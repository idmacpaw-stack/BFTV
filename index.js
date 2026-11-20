const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://xhamster.com/gay';

const manifest = {
    id: 'org.customgayaddon',
    version: '2.0.0',
    name: 'xHamster Gay Addon',
    description: 'Katalog dan Video Khusus Gay dari xHamster',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'gay_trending',
            name: 'xHamster Gay - Trending',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: 'gay_new',
            name: 'xHamster Gay - New & Recent',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['xhg_']
};

const builder = new addonBuilder(manifest);

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://xhamster.com/'
};

function parseVideos($) {
    const metas = [];
    const seenUrls = new Set();

    // Selector fleksibel untuk card video xHamster
    $('a.video-thumb__image-container, a.xh-card__image, a[href*="/videos/"]').each((index, element) => {
        const href = $(element).attr('href');
        if (!href || !href.includes('/videos/') || seenUrls.has(href)) {
            return;
        }

        const container = $(element).closest('.video-thumb, .xh-card, div');
        const img = container.find('img').first();
        
        let title = 
            container.find('.video-thumb__title, .xh-card__title, .video-label').text().trim() ||
            $(element).attr('title') ||
            img.attr('alt');

        let poster = 
            img.attr('data-src') ||
            img.attr('data-lazy-src') ||
            img.attr('src');

        if (title && poster && !poster.includes('data:image')) {
            seenUrls.add(href);
            const videoId = 'xhg_' + Buffer.from(href).toString('base64').replace(/=/g, '');

            if (poster.startsWith('//')) {
                poster = 'https:' + poster;
            } else if (!poster.startsWith('http')) {
                poster = 'https://xhamster.com' + (poster.startsWith('/') ? '' : '/') + poster;
            }

            metas.push({
                id: videoId,
                type: 'movie',
                name: title.replace(/\s+/g, ' ').trim(),
                poster: poster,
                posterShape: 'landscape'
            });
        }
    });

    return metas;
}

builder.defineCatalogHandler(async function(args) {
    try {
        let targetUrl = `${BASE_URL}`;

        if (args.extra && args.extra.search) {
            const query = encodeURIComponent(args.extra.search.trim()).replace(/%20/g, '+');
            targetUrl = `https://xhamster.com/search/${query}?rating=gay`;
        } else if (args.id === 'gay_new') {
            targetUrl = `${BASE_URL}/new`;
        } else {
            targetUrl = `${BASE_URL}`;
        }

        const response = await axios.get(targetUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const $ = cheerio.load(response.data);
        const metas = parseVideos($);

        return { metas };
    } catch (error) {
        console.error('Catalog error:', error.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('xhg_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : 'https://xhamster.com' + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const $ = cheerio.load(response.data);
        const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || 'xHamster Video';
        const poster = $('meta[property="og:image"]').attr('content');
        const description = $('meta[property="og:description"]').attr('content') || '';

        return {
            meta: {
                id: args.id,
                type: 'movie',
                name: title,
                poster: poster,
                background: poster,
                description: description
            }
        };
    } catch (error) {
        return {
            meta: {
                id: args.id,
                type: 'movie',
                name: 'xHamster Video'
            }
        };
    }
});

builder.defineStreamHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('xhg_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : 'https://xhamster.com' + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const html = response.data;
        const streams = [];

        // Mencari tautan video .mp4 atau .m3u8 langsung di dalam source halaman xHamster
        const mediaMatches = html.match(/https?:\/\/[^"'\s\\]+\.(?:mp4|m3u8)[^"'\s\\]*/g);
        if (mediaMatches) {
            const uniqueUrls = [...new Set(mediaMatches.filter(u => u.includes('xhcdn') || u.includes('mp4') || u.includes('m3u8')))];
            uniqueUrls.forEach((url, idx) => {
                streams.push({
                    title: `Stream HD ${idx + 1}`,
                    url: url.replace(/\\/g, '')
                });
            });
        }

        return { streams };
    } catch (error) {
        console.error('Stream error:', error.message);
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();

module.exports = async function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const urlObj = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
        const pathname = urlObj.pathname;

        if (pathname === '/' || pathname === '/manifest.json') {
            return res.status(200).send(JSON.stringify(addonInterface.manifest));
        }

        const parts = pathname.split('/').filter(Boolean);
        if (parts.length >= 3) {
            const resource = parts[0];
            const type = parts[1];
            const id = decodeURIComponent(parts[2].replace(/\.json$/, ''));
            const extraRaw = parts[3] ? decodeURIComponent(parts[3].replace(/\.json$/, '')) : '';

            let extra = {};
            if (extraRaw) {
                for (const pair of extraRaw.split('&')) {
                    const idx = pair.indexOf('=');
                    if (idx > -1) {
                        const k = pair.slice(0, idx);
                        const v = pair.slice(idx + 1);
                        extra[k] = decodeURIComponent(v.replace(/\+/g, ' '));
                    }
                }
            }
            if (urlObj.searchParams.has('search')) {
                extra.search = urlObj.searchParams.get('search');
            }

            const result = await addonInterface.get(resource, type, id, extra);
            return res.status(200).send(JSON.stringify(result));
        }

        return res.status(404).send(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
        console.error('Handler error:', e);
        return res.status(200).send(JSON.stringify({ metas: [], streams: [], error: e.message }));
    }
};
