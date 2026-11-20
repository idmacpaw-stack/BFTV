const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '2.3.0',
    name: 'Gay Video Catalog Addon',
    description: 'Katalog dan Video Khusus Gay Stabil dari Sumber Publik',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'gay_trending',
            name: 'Gay - Trending & Popular',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['gpub_']
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async function(args) {
    try {
        let searchQuery = 'gay';
        if (args && args.extra && args.extra.search) {
            searchQuery = `gay ${args.extra.search.trim()}`;
        }

        const query = encodeURIComponent(searchQuery);
        const apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${query}&per=24&format=json`;

        const response = await axios.get(apiUrl, { timeout: 8000 });
        const data = response.data;
        const metas = [];

        if (data && data.videos && Array.isArray(data.videos)) {
            data.videos.forEach(video => {
                if (video && video.url && video.title) {
                    const videoId = 'gpub_' + Buffer.from(video.url).toString('base64').replace(/=/g, '');
                    metas.push({
                        id: videoId,
                        type: 'movie',
                        name: video.title,
                        poster: video.default_thumb && video.default_thumb.src ? video.default_thumb.src : '',
                        posterShape: 'landscape',
                        description: `Duration: ${video.duration || 'N/A'} | Views: ${video.views || 0}`
                    });
                }
            });
        }

        return { metas };
    } catch (error) {
        return { metas: [] };
    }
});

builder.defineMetaHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('gpub_', '');
        const videoUrl = Buffer.from(encodedPart, 'base64').toString('utf8');

        return {
            meta: {
                id: args.id,
                type: 'movie',
                name: 'Gay Video Detail',
                poster: '',
                description: `Source URL: ${videoUrl}`
            }
        };
    } catch (error) {
        return {
            meta: {
                id: args.id,
                type: 'movie',
                name: 'Video'
            }
        };
    }
});

builder.defineStreamHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('gpub_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
        
        const videoIdMatch = videoPath.split('/').filter(Boolean).pop();
        if (!videoIdMatch) return { streams: [] };

        const apiDetailUrl = `https://www.eporner.com/api/v2/video/id/?id=${videoIdMatch}&format=json`;
        const response = await axios.get(apiDetailUrl, { timeout: 8000 });
        const data = response.data;

        const streams = [];
        if (data && data.sources) {
            for (const [quality, info] of Object.entries(data.sources)) {
                if (info && info.url) {
                    streams.push({
                        title: `Stream (${quality.toUpperCase()})`,
                        url: info.url
                    });
                }
            }
        }

        return { streams };
    } catch (error) {
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();

module.exports = async function (req, res) {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/json');

        const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
        const urlObj = new URL(req.url || '/', `https://${host}`);
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
        return res.status(200).send(JSON.stringify({ metas: [], streams: [], error: e.message }));
    }
};
