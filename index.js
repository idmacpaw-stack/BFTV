const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.boyfriendtv.com';

const manifest = {
    id: 'org.customboyfriendaddon',
    version: '1.0.2',
    name: 'BFTV Catalog Addon',
    description: 'Katalog Trending, Terbaru, dan Pencarian dari BoyfriendTV',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'bftv_trending',
            name: 'BFTV - Trending',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: 'bftv_latest',
            name: 'BFTV - Latest Videos',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: 'bftv_top',
            name: 'BFTV - Top Rated',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['bftv_']
};

const builder = new addonBuilder(manifest);

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.boyfriendtv.com/'
};

function parseVideos($) {
    const metas = [];
    const seenUrls = new Set();

    // Mencari semua elemen <a> yang mengarah ke halaman video dan memiliki thumbnail <img>
    $('a[href*="/videos/"]').each((index, element) => {
        const href = $(element).attr('href');
        if (!href || href === '/videos/' || href.includes('/videos/page') || seenUrls.has(href)) {
            return;
        }

        const img = $(element).find('img').first();
        const container = $(element).closest('div, li, article');
        const containerImg = img.length ? img : container.find('img').first();

        let title =
            $(element).attr('title') ||
            containerImg.attr('alt') ||
            container.find('.title, .video-title, h2, h3, h4').first().text().trim() ||
            $(element).text().trim();

        let poster =
            containerImg.attr('data-src') ||
            containerImg.attr('data-original') ||
            containerImg.attr('data-lazy') ||
            containerImg.attr('src');

        if (title && title.length > 2 && poster && !poster.includes('blank.gif')) {
            seenUrls.add(href);
            const fullPath = href.startsWith('http') ? href.replace(BASE_URL, '') : href;
            const videoId = 'bftv_' + Buffer.from(fullPath).toString('base64').replace(/=/g, '');

            if (poster.startsWith('//')) {
                poster = 'https:' + poster;
            } else if (!poster.startsWith('http')) {
                poster = BASE_URL + (poster.startsWith('/') ? '' : '/') + poster;
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
        let targetUrl = `${BASE_URL}/`;

        if (args.extra && args.extra.search) {
            const query = encodeURIComponent(args.extra.search.trim()).replace(/%20/g, '+');
            targetUrl = `${BASE_URL}/search/?q=${query}`;
        } else if (args.id === 'bftv_trending') {
            targetUrl = `${BASE_URL}/most-popular/`;
        } else if (args.id === 'bftv_top') {
            targetUrl = `${BASE_URL}/top-rated/`;
        } else {
            targetUrl = `${BASE_URL}/videos/`;
        }

        const response = await axios.get(targetUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const $ = cheerio.load(response.data);
        let metas = parseVideos($);

        // Fallback jika URL /most-popular/ atau /search/?q= berbeda struktur di situs target
        if (metas.length === 0 && args.extra && args.extra.search) {
            const altQuery = encodeURIComponent(args.extra.search.trim());
            const altRes = await axios.get(`${BASE_URL}/search/${altQuery}/`, {
                headers: HTTP_HEADERS,
                timeout: 9000
            });
            metas = parseVideos(cheerio.load(altRes.data));
        } else if (metas.length === 0 && args.id === 'bftv_trending') {
            const homeRes = await axios.get(`${BASE_URL}/`, {
                headers: HTTP_HEADERS,
                timeout: 9000
            });
            metas = parseVideos(cheerio.load(homeRes.data));
        }

        return { metas };
    } catch (error) {
        console.error('Catalog error:', error.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('bftv_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : BASE_URL + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const $ = cheerio.load(response.data);
        const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || 'BFTV Video';
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
                name: 'BFTV Video'
            }
        };
    }
});

builder.defineStreamHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('bftv_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : BASE_URL + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: HTTP_HEADERS,
            timeout: 9000
        });

        const html = response.data;
        const $ = cheerio.load(html);
        const streams = [];

        // 1. Cari URL .mp4 atau .m3u8 di dalam source HTML / script
        const mediaMatches = html.match(/https?:\/\/[^"'\s\\]+\.(?:mp4|m3u8)[^"'\s\\]*/g);
        if (mediaMatches) {
            const uniqueUrls = [...new Set(mediaMatches)];
            uniqueUrls.forEach((url, idx) => {
                streams.push({
                    title: `Direct Stream ${idx + 1}`,
                    url: url.replace(/\\/g, '')
                });
            });
        }

        // 2. Fallback dari tag <video> atau <source>
        if (streams.length === 0) {
            $('video source, video').each((i, el) => {
                const src = $(el).attr('src');
                if (src) {
                    streams.push({
                        title: 'HTML5 Video Stream',
                        url: src.startsWith('http') ? src : BASE_URL + src
                    });
                }
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
