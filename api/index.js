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
// "queries" = beberapa kata kunci yang digabung supaya hasil lebih banyak.
// "must" = (opsional) judul/tag wajib cocok dengan pola ini.
// Pencarian hanya dipasang di katalog pertama supaya hasil tidak muncul berulang.
const BLACK_RE = /\b(black|ebony|bbc|african|afro)\b/i;
const MUSCLE_RE = /\b(muscle|muscles|muscular|muscled|bodybuilder|bodybuilders|jock|jocks)\b/i;
const DADDY_RE = /\b(daddy|daddies|dad|stepdad|stepfather|father|bear|bears|mature|older)\b/i;
const INDO_RE = /\b(indo|indonesia|indonesian)\b/i;

const CATALOGS = [
    { id: 'ep_weekly',  name: "Let's Fun! - Top Minggu Ini",   order: 'top-weekly',   search: true },
    { id: 'ep_latest',  name: "Let's Fun! - Terbaru",          order: 'latest' },
    { id: 'ep_popular', name: "Let's Fun! - Terpopuler",       order: 'most-popular' },
    { id: 'ep_rated',   name: "Let's Fun! - Rating Tertinggi", order: 'top-rated' },
    { id: 'ep_monthly', name: "Let's Fun! - Top Bulan Ini",    order: 'top-monthly' },

    // Kategori berdasarkan kata kunci (semuanya tetap disaring hanya konten gay)
    { id: 'ep_black',   name: "Let's Fun! - Black",              order: 'most-popular', must: BLACK_RE,
      queries: ['black gay', 'ebony gay', 'bbc gay', 'black twink'] },
    { id: 'ep_bigdick', name: "Let's Fun! - Big Dick",           order: 'most-popular',
      queries: ['big dick gay', 'huge cock gay'] },
    { id: 'ep_dp',      name: "Let's Fun! - Double Penetration", order: 'most-popular',
      queries: ['double penetration gay', 'dp gay'] },
    { id: 'ep_fisting', name: "Let's Fun! - Fisting",            order: 'most-popular',
      queries: ['fisting gay'] },
    { id: 'ep_orgy',    name: "Let's Fun! - Orgy",               order: 'most-popular',
      queries: ['orgy gay', 'group sex gay'] },
    { id: 'ep_indo',    name: "Let's Fun! - Indonesia",          order: 'most-popular', must: INDO_RE,
      queries: ['indonesian gay', 'indo gay', 'indonesia gay'] },
    { id: 'ep_muscle',  name: "Let's Fun! - Muscle",             order: 'most-popular', must: MUSCLE_RE,
      queries: ['muscle gay', 'muscular gay', 'bodybuilder gay'] },
    { id: 'ep_daddy',   name: "Let's Fun! - Daddy",              order: 'most-popular', must: DADDY_RE,
      queries: ['daddy gay', 'gay daddy', 'bear gay'] },
    { id: 'ep_4k',      name: "Let's Fun! - 4K",                 order: 'most-popular',
      queries: ['4k gay', 'uhd gay'] },
    // Movies: diurutkan dari yang terpanjang, minimal 20 menit
    { id: 'ep_long',    name: "Let's Fun! - Movies",             order: 'longest', minSec: 1200,
      queries: ['gay', 'gay movie', 'gay full movie'] }
];

// Filter konten: hanya video gay. Daftar bisa diubah sesuai selera.
// Video wajib punya kata "gay" / "twink" di judul atau tag (kalau REQUIRE_GAY_TAG = true).
const REQUIRE_GAY_TAG = true;
// Video dibuang kalau judul/tag memuat salah satu kata ini (shemale/trans/wanita/dll).
const BLOCK_RE = /\b(shemale|she-male|tranny|trannies|trans|transgender|ladyboy|ladyboys|tgirl|t-girl|femboy|femboys|futanari|lesbian|lesbians|bisexual|straight|hetero|mmf|ffm|girl|girls|woman|women|female|babe|babes|pussy|tits|boobs|busty)\b/i;
const GAY_RE = /\b(gays?|twinks?)\b/i;

function classify(v, cat) {
    const text = `${v.title || ''} ${v.keywords || ''}`;
    if (BLOCK_RE.test(text)) return 'blocked';
    if (REQUIRE_GAY_TAG && !GAY_RE.test(text)) return 'not-gay';
    if (cat && cat.must && !cat.must.test(text)) return 'off-topic';
    if (cat && cat.minSec && v.length_sec && Number(v.length_sec) < cat.minSec) return 'too-short';
    return 'ok';
}

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '5.6.0',
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
const PER_PAGE = 60; // jumlah hasil per permintaan ke API Eporner

async function searchEp(query, order, page) {
    const { data } = await http.get(`${EP_API}/video/search/`, {
        params: {
            query,
            gay: 2, // 2 = hanya konten gay
            per_page: PER_PAGE,
            page,
            thumbsize: 'big',
            order,
            format: 'json'
        }
    });
    return Array.isArray(data && data.videos) ? data.videos.filter(v => v && v.id && v.title) : [];
}

// Mengambil, menggabungkan, dan menyaring hasil. Posisi "skip" dipetakan dengan mengambil
// beberapa halaman sekaligus, supaya halaman berikutnya tidak mengulang halaman pertama
// walaupun sebagian video terbuang oleh filter.
async function fetchEpCatalog(cat, search, skip) {
    const queries = search ? [search] : (cat.queries || ['gay']);
    const order = search ? 'latest' : cat.order;
    const need = skip + PAGE_SIZE;
    const pages = Math.min(6, Math.max(1, Math.ceil(need / (PER_PAGE * 0.4 * queries.length))));

    const jobs = [];
    queries.forEach((q, qi) => {
        for (let p = 1; p <= pages; p++) jobs.push({ qi, p, promise: searchEp(q, order, p) });
    });
    const settled = await Promise.allSettled(jobs.map(j => j.promise));

    const lists = queries.map(() => []);
    jobs.forEach((j, i) => {
        if (settled[i].status === 'fulfilled') lists[j.qi][j.p - 1] = settled[i].value;
        else console.error('search error:', queries[j.qi], j.p, settled[i].reason && settled[i].reason.message);
    });
    const flat = lists.map(pagesArr => [].concat(...pagesArr.map(x => x || [])));

    // gabungkan bergantian antar kata kunci, buang duplikat
    const merged = [];
    const seen = new Set();
    const maxLen = Math.max(0, ...flat.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
        for (const l of flat) {
            const v = l[i];
            if (v && !seen.has(v.id)) {
                seen.add(v.id);
                merged.push(v);
            }
        }
    }

    const kept = [];
    const removed = [];
    for (const v of merged) {
        const verdict = classify(v, cat);
        if (verdict === 'ok') kept.push(v);
        else removed.push({ title: v.title, why: verdict });
    }
    return {
        total: merged.length,
        perQuery: queries.map((q, i) => ({ query: q, count: flat[i].length })),
        kept,
        removed,
        slice: kept.slice(skip, skip + PAGE_SIZE)
    };
}

builder.defineCatalogHandler(async (args) => {
    try {
        const cat = CATALOGS.find(c => c.id === args.id);
        if (!cat) return { metas: [] };

        const extra = (args && args.extra) || {};
        const skip = parseInt(extra.skip, 10) || 0;
        const search = cat.search && extra.search && extra.search.trim() ? extra.search.trim() : '';

        const r = await fetchEpCatalog(cat, search, skip);
        return { metas: r.slice.map(toMeta), cacheMaxAge: 900 };
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

// Diagnosa katalog: /debug-catalog/ep_black?q=kata&skip=0
async function runCatalogDebug(id, q, skip) {
    const cat = CATALOGS.find(c => c.id === id);
    if (!cat) return { error: 'katalog tidak ada', ids: CATALOGS.map(c => c.id) };
    try {
        const r = await fetchEpCatalog(cat, cat.search ? q : '', skip);
        return {
            catalog: id,
            query: q || '(kosong)',
            skip,
            perQuery: r.perQuery,
            totalAfterMerge: r.total,
            kept: r.kept.length,
            shownOnThisPage: r.slice.length,
            removedCount: r.removed.length,
            removed: r.removed.slice(0, 12),
            keptSample: r.slice.slice(0, 6).map(v => ({ title: v.title, keywords: String(v.keywords || '').slice(0, 120) }))
        };
    } catch (e) {
        return { error: e.message };
    }
}

const app = express();
app.use(cors());
app.get('/', (req, res) => res.redirect('/manifest.json'));
app.get('/debug-catalog/:id', async (req, res) => res.json(await runCatalogDebug(req.params.id, String(req.query.q || ''), parseInt(req.query.skip, 10) || 0)));
app.get('/debug/:id', async (req, res) => res.json(await runDebug(req.params.id)));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
