const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const API = 'https://www.eporner.com/api/v2';
const PAGE_SIZE = 30;
const PREFIX = 'gpub_';

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '3.0.0',
    name: 'Gay Video Catalog Addon',
    description: 'Katalog video dari sumber publik',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'gay_trending',
            name: 'Gay - Best & Trending',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        }
    ],
    idPrefixes: [PREFIX],
    behaviorHints: { adult: true }
};

const builder = new addonBuilder(manifest);

const http = axios.create({
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/3.0)' }
});

function toMeta(video) {
    return {
        id: PREFIX + video.id,
        type: 'movie',
        name: video.title,
        poster: video.default_thumb && video.default_thumb.src ? video.default_thumb.src : undefined,
        posterShape: 'landscape',
        description: `Durasi: ${video.length_min || 'N/A'} | Views: ${video.views || 0}`
    };
}

builder.defineCatalogHandler(async (args) => {
    try {
        const extra = (args && args.extra) || {};
        const skip = parseInt(extra.skip, 10) || 0;
        const page = Math.floor(skip / PAGE_SIZE) + 1;
        const query = extra.search && extra.search.trim() ? extra.search.trim() : 'all';
        const order = extra.search ? 'latest' : 'top-weekly';

        const { data } = await http.get(`${API}/video/search/`, {
            params: {
                query,
                gay: 2,
                per_page: PAGE_SIZE,
                page,
                thumbsize: 'big',
                order,
                format: 'json'
            }
        });

        const metas = Array.isArray(data && data.videos)
            ? data.videos.filter(v => v && v.id && v.title).map(toMeta)
            : [];

        return { metas, cacheMaxAge: 900 };
    } catch (err) {
        console.error('catalog error:', err.message);
        return { metas: [] };
    }
});

async function getVideo(id) {
    const { data } = await http.get(`${API}/video/id/`, {
        params: { id, thumbsize: 'big', format: 'json' }
    });
    return data;
}

builder.defineMetaHandler(async (args) => {
    const id = args.id.replace(PREFIX, '');
    try {
        const v = await getVideo(id);
        return {
            meta: {
                ...toMeta({ ...v, id }),
                background: v.default_thumb && v.default_thumb.src,
                releaseInfo: v.added ? String(v.added).slice(0, 4) : undefined,
                runtime: v.length_min,
                description: `Durasi: ${v.length_min || 'N/A'} | Views: ${v.views || 0}\n${v.keywords || ''}`
            }
        };
    } catch (err) {
        console.error('meta error:', err.message);
        return { meta: { id: args.id, type: 'movie', name: 'Video' } };
    }
});

builder.defineStreamHandler(async (args) => {
    const id = args.id.replace(PREFIX, '');
    try {
        const v = await getVideo(id);
        const streams = [];
        if (v && v.url) {
            // API Eporner tidak memberi link video langsung,
            // jadi dibuka lewat browser (externalUrl)
            streams.push({
                name: 'Eporner',
                title: 'Buka di browser',
                externalUrl: v.url
            });
        }
        return { streams };
    } catch (err) {
        console.error('stream error:', err.message);
        return { streams: [] };
    }
});

const app = express();
app.use(cors());
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
