const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const API = 'https://www.eporner.com/api/v2';
const SITE = 'https://www.eporner.com';
const PAGE_SIZE = 30;
const PREFIX = 'gpub_';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '3.2.0',
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

// ---------- Katalog ----------
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

// ---------- Meta ----------
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

// ---------- Ekstraksi link mp4 ----------

// Hash untuk endpoint xhr Eporner: 4 potongan hex (8 karakter) -> base36
function calcHash(h) {
    let out = '';
    for (let i = 0; i < 32; i += 8) {
        out += parseInt(h.slice(i, i + 8), 16).toString(36);
    }
    return out;
}

// Halaman video biasa kena gerbang umur, jadi pakai halaman embed.
// "dbg" opsional: kalau diisi, hasil tiap langkah dicatat untuk /debug.
async function getDirectStreams(id, dbg) {
    const embedUrl = `${SITE}/embed/${id}/`;
    const page = await http.get(embedUrl, {
        timeout: 6000,
        headers: { 'User-Agent': UA, Referer: SITE + '/', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const html = typeof page.data === 'string' ? page.data : '';
    const cookie = (page.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const vid = (html.match(/vid\s*[:=]\s*['"]([A-Za-z0-9]+)['"]/) || [])[1];
    const hash = (html.match(/hash\s*[:=]\s*['"]([0-9a-f]{32})['"]/) || [])[1];
    const found = [];
    if (dbg) {
        dbg.vid = vid;
        dbg.hashFound = !!hash;
    }

    if (vid && hash) {
        for (const embedFlag of ['true', 'false']) {
            try {
                const r = await http.get(`${SITE}/xhr/video/${vid}`, {
                    timeout: 6000,
                    validateStatus: () => true,
                    params: {
                        hash: calcHash(hash),
                        domain: 'www.eporner.com',
                        fallback: 'false',
                        embed: embedFlag,
                        supportedFormats: 'mp4'
                    },
                    headers: {
                        'User-Agent': UA,
                        Referer: embedUrl,
                        'X-Requested-With': 'XMLHttpRequest',
                        Cookie: cookie
                    }
                });
                if (dbg) {
                    dbg['xhr_embed_' + embedFlag] = {
                        status: r.status,
                        sample: JSON.stringify(r.data).slice(0, 500).replace(/https?:\/\/[^"]+/g, '[url]')
                    };
                }
                const mp4 = r.data && r.data.sources && r.data.sources.mp4;
                if (mp4) {
                    for (const [label, info] of Object.entries(mp4)) {
                        const src = info && (info.src || info.url);
                        if (src) found.push({ label, url: src.startsWith('//') ? 'https:' + src : src });
                    }
                }
                if (found.length) break;
            } catch (e) {
                console.error('xhr error:', e.message);
                if (dbg) dbg['xhr_embed_' + embedFlag] = { error: e.message };
            }
        }
    }

    const height = l => parseInt(l, 10) || 0;
    return found.sort((a, b) => height(b.label) - height(a.label));
}

// ---------- Stream ----------
builder.defineStreamHandler(async (args) => {
    const id = args.id.replace(PREFIX, '');
    try {
        const v = await getVideo(id);
        const streams = [];

        if (v && v.url) {
            try {
                const direct = await getDirectStreams(id);
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

// ---------- Diagnosa: buka /debug/<id video Eporner> ----------
async function runDebug(id) {
    const out = { id };
    try {
        const streams = await getDirectStreams(id, out);
        out.streamsFound = streams.map(s => ({
            label: s.label,
            host: s.url.replace(/^https?:\/\/([^/]+).*/, '$1')
        }));
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

// ---------- Probe umum untuk situs lain: /probe?url=<url video> ----------
const PROBE_ALLOWED = ['boyfriendtv.com', 'xhamster.com', 'xhamster2.com', 'xhamster3.com'];

function maskUrl(u) {
    return String(u).replace(/\\\//g, '/').split('?')[0].slice(0, 200);
}

async function runProbe(rawUrl) {
    const out = { url: rawUrl };
    let u;
    try {
        u = new URL(rawUrl);
    } catch (e) {
        return { error: 'URL tidak valid' };
    }
    const host = u.hostname.toLowerCase();
    if (!PROBE_ALLOWED.some(d => host === d || host.endsWith('.' + d))) {
        return { error: 'Domain tidak diizinkan', allowed: PROBE_ALLOWED };
    }
    try {
        const r = await http.get(u.href, {
            timeout: 7000,
            validateStatus: () => true,
            maxRedirects: 5,
            headers: {
                'User-Agent': UA,
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml'
            }
        });
        const html = typeof r.data === 'string' ? r.data : '';
        out.status = r.status;
        out.finalUrl = r.request && r.request.res && r.request.res.responseUrl;
        out.length = html.length;
        out.title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
        out.cloudflareBlock = /Just a moment|cf-chl|challenge-platform|Attention Required|cf-browser-verification/i.test(html);
        out.ageGateHint = /age verification|verify your age|are you 18|over 18|age-gate|agegate/i.test(html);
        out.cookieNames = (r.headers['set-cookie'] || []).map(c => c.split('=')[0]);
        out.m3u8Count = (html.match(/\.m3u8/g) || []).length;
        out.mp4Count = (html.match(/\.mp4/g) || []).length;
        out.hasSourceTag = /<source[^>]+src=/i.test(html);
        out.hasOgVideo = /og:video/i.test(html);
        out.hasJsonLd = /application\/ld\+json/i.test(html);
        out.hasInitials = /window\.initials/i.test(html);
        out.sampleM3u8 = (html.match(/https?:[^"'\s<>]+?\.m3u8[^"'\s<>]*/g) || []).slice(0, 3).map(maskUrl);
        out.sampleMp4 = (html.match(/https?:[^"'\s<>]+?\.mp4[^"'\s<>]*/g) || []).slice(0, 3).map(maskUrl);
        if (html.length < 6000) out.html = html;
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

const app = express();
app.use(cors());
app.get('/', (req, res) => res.redirect('/manifest.json'));
app.get('/probe', async (req, res) => res.json(await runProbe(String(req.query.url || ''))));
app.get('/debug/:id', async (req, res) => res.json(await runDebug(req.params.id)));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
