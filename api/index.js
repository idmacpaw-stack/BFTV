const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EP_API = 'https://www.eporner.com/api/v2';
const EP_SITE = 'https://www.eporner.com';
const PAGE_SIZE = 30;
const PREFIX = 'gpub_';

// Katalog Eporner. "order" mengikuti parameter API Eporner.
// Pencarian hanya dipasang di katalog pertama supaya hasil tidak muncul berulang.
const CATALOGS = [
    { id: 'ep_weekly',  name: "Let's Fun! - Top Minggu Ini",   order: 'top-weekly',   search: true },
    { id: 'ep_latest',  name: "Let's Fun! - Terbaru",          order: 'latest' },
    { id: 'ep_popular', name: "Let's Fun! - Terpopuler",       order: 'most-popular' },
    { id: 'ep_rated',   name: "Let's Fun! - Rating Tertinggi", order: 'top-rated' },
    { id: 'ep_monthly', name: "Let's Fun! - Top Bulan Ini",    order: 'top-monthly' },

    // Kategori berdasarkan kata kunci (tetap hanya konten gay lewat filter di bawah)
    { id: 'ep_black',    name: "Let's Fun! - Black",              query: 'black',              order: 'most-popular' },
    { id: 'ep_bigdick',  name: "Let's Fun! - Big Dick",           query: 'big dick',           order: 'most-popular' },
    { id: 'ep_dp',       name: "Let's Fun! - Double Penetration", query: 'double penetration', order: 'most-popular' },
    { id: 'ep_fisting',  name: "Let's Fun! - Fisting",            query: 'fisting',            order: 'most-popular' },
    { id: 'ep_orgy',     name: "Let's Fun! - Orgy",               query: 'orgy',               order: 'most-popular' }
];

// Filter konten: hanya video gay. Daftar bisa diubah sesuai selera.
const REQUIRE_GAY_TAG = true; // video harus punya kata "gay" / "twink" di judul atau tag
const BLOCK_RE = /\b(shemale|she-male|tranny|trannies|trans|transgender|ladyboy|ladyboys|tgirl|t-girl|lesbian|lesbians|bisexual|futanari)\b/i;
const GAY_RE = /\b(gays?|twinks?)\b/i;

function classify(v) {
    const text = `${v.title || ''} ${v.keywords || ''}`;
    if (BLOCK_RE.test(text)) return 'blocked';
    if (REQUIRE_GAY_TAG && v.keywords && !GAY_RE.test(text)) return 'not-gay';
    return 'ok';
}

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '5.3.0',
    name: "Let's Fun!",
    description: "Let's Fun! - katalog video pilihan",
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: CATALOGS.map(c => ({
        type: 'movie',
        id: c.id,
        name: c.name,
        extra: c.search
            ? [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
            : [{ name: 'skip', isRequired: false }]
    })),
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
        description: `Sumber: Eporner | Durasi: ${video.length_min || 'N/A'} | Views: ${video.views || 0}`
    };
}

// ---------- Katalog ----------
async function fetchEpCatalog(cat, search, page) {
    const { data } = await http.get(`${EP_API}/video/search/`, {
        params: {
            query: search || cat.query || 'gay',
            gay: 2, // 2 = hanya konten gay
            per_page: PAGE_SIZE,
            page,
            thumbsize: 'big',
            order: search ? 'latest' : cat.order,
            format: 'json'
        }
    });
    const all = Array.isArray(data && data.videos) ? data.videos.filter(v => v && v.id && v.title) : [];
    const kept = [];
    const removed = [];
    for (const v of all) {
        const verdict = classify(v);
        if (verdict === 'ok') kept.push(v);
        else removed.push({ title: v.title, why: verdict });
    }
    return { total: all.length, kept, removed };
}

builder.defineCatalogHandler(async (args) => {
    try {
        const cat = CATALOGS.find(c => c.id === args.id);
        if (!cat) return { metas: [] };

        const extra = (args && args.extra) || {};
        const skip = parseInt(extra.skip, 10) || 0;
        const page = Math.floor(skip / PAGE_SIZE) + 1;
        const search = cat.search && extra.search && extra.search.trim() ? extra.search.trim() : '';

        const r = await fetchEpCatalog(cat, search, page);
        return { metas: r.kept.map(toMeta), cacheMaxAge: 900 };
    } catch (err) {
        console.error('catalog error:', err.message);
        return { metas: [] };
    }
});

async function getVideo(id) {
    const { data } = await http.get(`${EP_API}/video/id/`, {
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
                description: `Sumber: Eporner | Durasi: ${v.length_min || 'N/A'} | Views: ${v.views || 0}\n${v.keywords || ''}`
            }
        };
    } catch (err) {
        console.error('meta error:', err.message);
        return { meta: { id: args.id, type: 'movie', name: 'Video' } };
    }
});

// ---------- Link mp4 lewat halaman embed ----------
// Halaman video biasa kena gerbang umur, jadi pakai halaman embed.
function calcHash(h) {
    let out = '';
    for (let i = 0; i < 32; i += 8) {
        out += parseInt(h.slice(i, i + 8), 16).toString(36);
    }
    return out;
}

async function getDirectStreams(id, dbg) {
    const embedUrl = `${EP_SITE}/embed/${id}/`;
    const page = await http.get(embedUrl, {
        timeout: 6000,
        headers: { 'User-Agent': UA, Referer: EP_SITE + '/', 'Accept-Language': 'en-US,en;q=0.9' }
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
                const r = await http.get(`${EP_SITE}/xhr/video/${vid}`, {
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
                            proxyHeaders: { request: { 'User-Agent': UA, Referer: EP_SITE + '/' } }
                        }
                    });
                }
            } catch (e) {
                console.error('direct error:', e.message);
            }

            // Cadangan: buka di browser
            streams.push({ name: 'Eporner', title: 'Buka di browser', externalUrl: v.url });
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

// Diagnosa katalog: /debug-catalog/ep_weekly?q=kata
async function runCatalogDebug(id, q) {
    const cat = CATALOGS.find(c => c.id === id);
    if (!cat) return { error: 'katalog tidak ada', ids: CATALOGS.map(c => c.id) };
    try {
        const r = await fetchEpCatalog(cat, cat.search ? q : '', 1);
        return {
            catalog: id,
            query: q || '(kosong)',
            totalFromApi: r.total,
            kept: r.kept.length,
            removedCount: r.removed.length,
            removed: r.removed.slice(0, 10),
            keptSample: r.kept.slice(0, 5).map(v => ({ title: v.title, keywords: String(v.keywords || '').slice(0, 120) }))
        };
    } catch (e) {
        return { error: e.message };
    }
}

const app = express();
app.use(cors());
app.get('/', (req, res) => res.redirect('/manifest.json'));
app.get('/debug-catalog/:id', async (req, res) => res.json(await runCatalogDebug(req.params.id, String(req.query.q || ''))));
app.get('/debug/:id', async (req, res) => res.json(await runDebug(req.params.id)));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
