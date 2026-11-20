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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SITE = 'https://www.eporner.com';

// Hash untuk endpoint xhr Eporner: 4 potongan hex (8 karakter) -> base36
function calcHash(h) {
    let out = '';
    for (let i = 0; i < 32; i += 8) {
        out += parseInt(h.slice(i, i + 8), 16).toString(36);
    }
    return out;
}

async function getDirectStreams(pageUrl) {
    const page = await http.get(pageUrl, {
        timeout: 6000,
        headers: { 'User-Agent': UA, Referer: SITE + '/' }
    });
    const html = typeof page.data === 'string' ? page.data : '';

    const vid = (html.match(/vid\s*[:=]\s*['"]([A-Za-z0-9]+)['"]/) || [])[1];
    const hash = (html.match(/hash\s*[:=]\s*['"]([0-9a-f]{32})['"]/) || [])[1];
    const found = [];

    // Cara 1: endpoint xhr
    if (vid && hash) {
        try {
            const { data } = await http.get(`${SITE}/xhr/video/${vid}`, {
                timeout: 6000,
                params: {
                    hash: calcHash(hash),
                    domain: 'www.eporner.com',
                    fallback: 'false',
                    embed: 'false',
                    supportedFormats: 'mp4'
                },
                headers: { 'User-Agent': UA, Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest' }
            });
            const mp4 = data && data.sources && data.sources.mp4;
            if (mp4) {
                for (const [label, info] of Object.entries(mp4)) {
                    const src = info && (info.src || info.url);
                    if (src) found.push({ label, url: src.startsWith('//') ? 'https:' + src : src });
                }
            }
        } catch (e) {
            console.error('xhr error:', e.message);
        }
    }

    // Cara 2: link download di halaman
    if (!found.length) {
        const re = /href="(\/dload\/[^"]+?-(\d{3,4})p[^"]*\.mp4)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            found.push({ label: m[2] + 'p', url: SITE + m[1] });
        }
    }

    const height = l => parseInt(l, 10) || 0;
    return found.sort((a, b) => height(b.label) - height(a.label));
}

builder.defineStreamHandler(async (args) => {
    const id = args.id.replace(PREFIX, '');
    try {
        const v = await getVideo(id);
        const streams = [];

        if (v && v.url) {
            try {
                const direct = await getDirectStreams(v.url);
                for (const d of direct) {
                    streams.push({
                        name: 'Eporner',
                        title: d.label,
                        url: d.url,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: { request: { 'User-Agent': UA, Referer: SITE + '/' } }
                        }
                    });
                }
            } catch (e) {
                console.error('direct error:', e.message);
            }

            // Cadangan: buka di browser
            streams.push({
                name: 'Eporner',
                title: 'Buka di browser',
                externalUrl: v.url
            });
        }
        return { streams, cacheMaxAge: 300 };
    } catch (err) {
        console.error('stream error:', err.message);
        return { streams: [] };
    }
});

const app = express();
app.use(cors());
app.get('/', (req, res) => res.redirect('/manifest.json'));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
