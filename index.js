const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '2.6.0',
    name: 'Gay Video Catalog Addon',
    description: 'Katalog Video Khusus Gay Stabil dari Sumber Publik',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'gay_trending',
            name: 'Gay - Best & Trending',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['gpub_']
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async function(args) {
    try {
        let apiUrl = 'https://www.eporner.com/api/v2/video/best/?per=30&format=json';

        if (args && args.extra && args.extra.search) {
            const query = encodeURIComponent(`gay ${args.extra.search.trim()}`);
            apiUrl = `https://www.eporner.com/api/v2/video/search/?query=${query}&per=30&format=json`;
        }

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
                name: 'Video Detail',
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

const router = getRouter(builder.getInterface());
module.exports = router;
