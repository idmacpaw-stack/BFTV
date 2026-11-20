const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.boyfriendtv.com';

const manifest = {
    id: 'org.customboyfriendaddon',
    version: '1.0.1',
    name: 'Custom Web Catalog Addon',
    description: 'Add-on otomatis untuk katalog dan video dari web target',
    resources: ['catalog', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'custom_latest',
            name: 'Latest Videos',
            extra: [{ name: 'search', isRequired: false }]
        }
    ],
    idPrefixes: ['bftv_']
};

const builder = new addonBuilder(manifest);

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

builder.defineCatalogHandler(async function(args) {
    try {
        let targetUrl = `${BASE_URL}/videos/`;
        if (args.extra && args.extra.search) {
            const query = encodeURIComponent(args.extra.search.trim());
            targetUrl = `${BASE_URL}/search/${query}/`;
        }

        const response = await axios.get(targetUrl, {
            headers: HTTP_HEADERS,
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        const metas = [];

        $('.video-item, .item-video, .thumb-block, .video').each((index, element) => {
            const title = $(element).find('img').attr('alt') || $(element).find('.title, a').first().attr('title') || $(element).find('.title').text().trim();
            const poster = $(element).find('img').attr('data-src') || $(element).find('img').attr('data-original') || $(element).find('img').attr('src');
            const relativeLink = $(element).find('a').first().attr('href');

            if (title && relativeLink && !relativeLink.startsWith('#')) {
                const videoId = 'bftv_' + Buffer.from(relativeLink).toString('base64').replace(/=/g, '');
                metas.push({
                    id: videoId,
                    type: 'movie',
                    name: title.trim(),
                    poster: poster ? (poster.startsWith('http') ? poster : (poster.startsWith('//') ? 'https:' + poster : BASE_URL + poster)) : undefined
                });
            }
        });

        return { metas };
    } catch (error) {
        console.error('Catalog error:', error.message);
        return { metas: [] };
    }
});

builder.defineStreamHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('bftv_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('ascii');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : BASE_URL + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: HTTP_HEADERS,
            timeout: 8000
        });

        const $ = cheerio.load(response.data);
        let streamUrl = null;

        $('script').each((i, el) => {
            const scriptContent = $(el).html() || '';
            const match = scriptContent.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
            if (match && !streamUrl) {
                streamUrl = match[0];
            }
        });

        if (!streamUrl) {
            streamUrl = $('video source').attr('src') || $('video').attr('src') || $('iframe').attr('src');
        }

        if (streamUrl) {
            return {
                streams: [{ title: 'Direct Stream (HD)', url: streamUrl }]
            };
        }

        return { streams: [] };
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

            // Pemanggilan standar stremio-addon-sdk (argumen terpisah)
            const result = await addonInterface.get(resource, type, id, extra);
            return res.status(200).send(JSON.stringify(result));
        }

        return res.status(404).send(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
        console.error('Handler error:', e);
        return res.status(200).send(JSON.stringify({ metas: [], streams: [], error: e.message }));
    }
};
