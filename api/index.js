const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- Eporner ----------
const EP_API = 'https://www.eporner.com/api/v2';
const EP_SITE = 'https://www.eporner.com';
const EP_PAGE_SIZE = 30;
const EP_PREFIX = 'gpub_';

// ---------- xHamster & BoyfriendTV (scraping, belum teruji) ----------
// Kalau katalog kosong atau halaman salah, cukup ubah listUrl / linkRe / pageSize di sini.
const XH_BASE = 'https://xhamster.com';
const BF_BASE = 'https://www.boyfriendtv.com';

const SCRAPED = {
    xh: {
        key: 'xh',
        prefix: 'xh_',
        name: 'xHamster',
        catalogId: 'xh_gay',
        catalogName: 'xHamster - Gay',
        base: XH_BASE,
        pageSize: 40,
        linkRe: /href="((?:https?:\/\/[^"\/]*xhamster\d*\.[a-z]+)?\/videos\/[^"#?]+)"/,
        listUrl(query, page) {
            if (query) {
                const q = encodeURIComponent('gay ' + query).replace(/%20/g, '+');
                return `${XH_BASE}/search/${q}${page > 1 ? '?page=' + page : ''}`;
            }
            return page > 1 ? `${XH_BASE}/gay/${page}` : `${XH_BASE}/gay`;
        }
    },
    bf: {
        key: 'bf',
        prefix: 'bf_',
        name: 'BoyfriendTV',
        catalogId: 'bf_gay',
        catalogName: 'BoyfriendTV - Gay',
        base: BF_BASE,
        pageSize: 24,
        linkRe: /href="((?:https?:\/\/(?:www\.)?boyfriendtv\.com)?\/videos\/\d+\/[^"#?]*)"/,
        listUrl(query, page) {
            if (query) {
                return `${BF_BASE}/search/?q=${encodeURIComponent(query)}${page > 1 ? '&page=' + page : ''}`;
            }
            return page > 1 ? `${BF_BASE}/videos/page${page}/` : `${BF_BASE}/videos/`;
        }
    }
};

const SEARCH_EXTRA = [
    { name: 'search', isRequired: false },
    { name: 'skip', isRequired: false }
];

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '4.0.0',
    name: 'Gay Video Catalog Addon',
    description: 'Katalog video per sumber: Eporner, xHamster, BoyfriendTV',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        { type: 'movie', id: 'ep_gay', name: 'Eporner - Gay', extra: SEARCH_EXTRA },
        { type: 'movie', id: SCRAPED.xh.catalogId, name: SCRAPED.xh.catalogName, extra: SEARCH_EXTRA },
        { type: 'movie', id: SCRAPED.bf.catalogId, name: SCRAPED.bf.catalogName, extra: SEARCH_EXTRA }
    ],
    idPrefixes: [EP_PREFIX, SCRAPED.xh.prefix, SCRAPED.bf.prefix],
    behaviorHints: { adult: true }
};

const builder = new addonBuilder(manifest);

const http = axios.create({
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/3.0)' }
});

// ---------- Helper umum ----------
function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

function absUrl(u, base) {
    try {
        return new URL(decodeEntities(u).replace(/\\\//g, '/'), base).href;
    } catch (e) {
        return null;
    }
}

function maskUrl(u) {
    return String(u).split('?')[0].slice(0, 200);
}

function encodePath(p) {
    return Buffer.from(p, 'utf8').toString('base64url');
}

function decodePath(s) {
    try {
        const p = Buffer.from(s, 'base64url').toString('utf8');
        return p.startsWith('/') ? p : null;
    } catch (e) {
        return null;
    }
}

async function fetchHtml(url, referer) {
    const r = await http.get(url, {
        timeout: 7000,
        validateStatus: () => true,
        maxRedirects: 5,
        responseType: 'text',
        transformResponse: x => x,
        headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
            Referer: referer || url
        }
    });
    return {
        status: r.status,
        html: typeof r.data === 'string' ? r.data : '',
        finalUrl: r.request && r.request.res && r.request.res.responseUrl,
        headers: r.headers
    };
}

// ---------- Parser daftar video (xHamster & BoyfriendTV) ----------
function pickThumb(chunk, base) {
    const pats = [
        /(?:data-src|data-original|data-thumb|data-lazy-src|data-poster)="((?:https?:)?\/\/[^"]+)"/i,
        /srcset="((?:https?:)?\/\/[^\s"]+)/i,
        /<img[^>]+\bsrc="((?:https?:)?\/\/[^"]+\.(?:jpe?g|png|webp)[^"]*)"/i
    ];
    for (const p of pats) {
        const m = chunk.match(p);
        if (m) {
            const a = absUrl(m[1], base);
            if (a) return a;
        }
    }
    return null;
}

function pickTitle(chunk) {
    const strong = chunk.match(/\btitle="([^"]{3,200})"/i);
    if (strong) return { text: decodeEntities(strong[1]), strong: true };
    const weak = chunk.match(/\balt="([^"]{3,200})"/i);
    return weak ? { text: decodeEntities(weak[1]), strong: false } : null;
}

function slugTitle(path) {
    const parts = path.split('/').filter(Boolean);
    let s = parts[parts.length - 1] || 'Video';
    s = s.replace(/-xh[A-Za-z0-9]+$/, '').replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Video';
}

function parseListing(html, linkRe, base) {
    const re = new RegExp(linkRe.source, 'gi');
    const hits = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        // awal tag <a ...> yang memuat href ini
        const tagStart = Math.max(0, html.lastIndexOf('<', m.index));
        hits.push({ idx: m.index, tagStart, href: m[1] });
    }

    const map = new Map();
    for (let i = 0; i < hits.length; i++) {
        const abs = absUrl(hits[i].href, base);
        if (!abs) continue;
        const path = new URL(abs).pathname;
        const start = hits[i].tagStart;
        const end = Math.min(i + 1 < hits.length ? hits[i + 1].tagStart : html.length, start + 2500);
        const chunk = html.slice(start, end);
        const entry = map.get(path) || { path, title: null, strong: false, thumb: null };
        if (!entry.thumb) entry.thumb = pickThumb(chunk, base);
        const t = pickTitle(chunk);
        if (t && (!entry.title || (t.strong && !entry.strong))) {
            entry.title = t.text;
            entry.strong = t.strong;
        }
        map.set(path, entry);
    }
    return Array.from(map.values()).map(e => ({
        path: e.path,
        title: e.title || slugTitle(e.path),
        thumb: e.thumb || undefined
    }));
}

// ---------- Pencari link video di halaman (xHamster & BoyfriendTV) ----------
function unescapeJs(s) {
    return s
        .replace(/\\u002F/gi, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
}

function qualityLabel(url, label) {
    const fromLabel = label && String(label).match(/(\d{3,4})/);
    if (fromLabel) return fromLabel[1] + 'p';
    const fromUrl = url.match(/(\d{3,4})p/);
    return fromUrl ? fromUrl[1] + 'p' : null;
}

function findMedia(html, base) {
    const t = unescapeJs(html);
    const out = [];
    const seen = new Set();
    const add = (u, label) => {
        const a = absUrl(u, base);
        if (!a || seen.has(a)) return;
        if (/(preview|trailer|teaser|thumb|sprite|storyboard|\.vtt)/i.test(a)) return;
        seen.add(a);
        const hls = /\.m3u8(\?|$)/i.test(a);
        out.push({ url: a, hls, label: hls ? 'HLS' : qualityLabel(a, label) });
    };

    // 1) tag <source>
    const tagRe = /<source\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(t)) !== null) {
        const tag = m[0];
        const src = (tag.match(/\bsrc="([^"]+)"/i) || [])[1];
        if (!src || !/\.(mp4|m3u8)(\?|$)/i.test(src)) continue;
        const label = (tag.match(/\b(?:title|label|res|size|data-res)="([^"]+)"/i) || [])[1];
        add(src, label);
    }

    // 2) URL mp4 / m3u8 mentah di seluruh halaman (termasuk di dalam JSON)
    const rawRe = /https?:\/\/[^"'\s<>\\]+?\.(?:mp4|m3u8)(?:\?[^"'\s<>\\]*)?/gi;
    while ((m = rawRe.exec(t)) !== null) add(m[0]);

    const height = l => parseInt(l, 10) || 0;
    const mp4 = out.filter(x => !x.hls).sort((a, b) => height(b.label) - height(a.label));
    const hls = out.filter(x => x.hls);
    return mp4.concat(hls).slice(0, 8);
}

// ---------- Katalog scraping ----------
const metaCache = new Map();

function toScrapedMeta(cfg, item) {
    const meta = {
        id: cfg.prefix + encodePath(item.path),
        type: 'movie',
        name: item.title,
        poster: item.thumb,
        posterShape: 'landscape',
        description: `Sumber: ${cfg.name}`
    };
    metaCache.set(meta.id, meta);
    return meta;
}

async function scrapeCatalog(cfg, query, page) {
    const url = cfg.listUrl(query, page);
    const r = await fetchHtml(url, cfg.base + '/');
    const items = parseListing(r.html, cfg.linkRe, cfg.base);
    return { url, status: r.status, finalUrl: r.finalUrl, html: r.html, items };
}

// ---------- Eporner: katalog / meta ----------
function toEpMeta(video) {
    return {
        id: EP_PREFIX + video.id,
        type: 'movie',
        name: video.title,
        poster: video.default_thumb && video.default_thumb.src ? video.default_thumb.src : undefined,
        posterShape: 'landscape',
        description: `Sumber: Eporner | Durasi: ${video.length_min || 'N/A'} | Views: ${video.views || 0}`
    };
}

async function getVideo(id) {
    const { data } = await http.get(`${EP_API}/video/id/`, {
        params: { id, thumbsize: 'big', format: 'json' }
    });
    return data;
}

async function epCatalog(query, skip) {
    const page = Math.floor(skip / EP_PAGE_SIZE) + 1;
    const { data } = await http.get(`${EP_API}/video/search/`, {
        params: {
            query: query || 'all',
            gay: 2,
            per_page: EP_PAGE_SIZE,
            page,
            thumbsize: 'big',
            order: query ? 'latest' : 'top-weekly',
            format: 'json'
        }
    });
    return Array.isArray(data && data.videos)
        ? data.videos.filter(v => v && v.id && v.title).map(toEpMeta)
        : [];
}

builder.defineCatalogHandler(async (args) => {
    const extra = (args && args.extra) || {};
    const skip = parseInt(extra.skip, 10) || 0;
    const query = extra.search && extra.search.trim() ? extra.search.trim() : '';
    try {
        if (args.id === 'ep_gay') {
            return { metas: await epCatalog(query, skip), cacheMaxAge: 900 };
        }
        const cfg = Object.values(SCRAPED).find(c => c.catalogId === args.id);
        if (cfg) {
            const page = Math.floor(skip / cfg.pageSize) + 1;
            const { items } = await scrapeCatalog(cfg, query, page);
            return { metas: items.map(i => toScrapedMeta(cfg, i)), cacheMaxAge: 900 };
        }
    } catch (err) {
        console.error('catalog error:', args.id, err.message);
    }
    return { metas: [] };
});

builder.defineMetaHandler(async (args) => {
    try {
        if (args.id.startsWith(EP_PREFIX)) {
            const id = args.id.slice(EP_PREFIX.length);
            const v = await getVideo(id);
            return {
                meta: {
                    ...toEpMeta({ ...v, id }),
                    background: v.default_thumb && v.default_thumb.src,
                    releaseInfo: v.added ? String(v.added).slice(0, 4) : undefined,
                    runtime: v.length_min,
                    description: `Sumber: Eporner | Durasi: ${v.length_min || 'N/A'} | Views: ${v.views || 0}\n${v.keywords || ''}`
                }
            };
        }
        const cfg = Object.values(SCRAPED).find(c => args.id.startsWith(c.prefix));
        if (cfg) {
            const cached = metaCache.get(args.id);
            if (cached) return { meta: cached };
            const path = decodePath(args.id.slice(cfg.prefix.length));
            if (path) {
                const r = await fetchHtml(cfg.base + path, cfg.base + '/');
                const og = (prop) => {
                    const m =
                        r.html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i')) ||
                        r.html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + prop + '"', 'i'));
                    return m ? decodeEntities(m[1]) : null;
                };
                return {
                    meta: {
                        id: args.id,
                        type: 'movie',
                        name: og('og:title') || slugTitle(path),
                        poster: og('og:image') || undefined,
                        background: og('og:image') || undefined,
                        posterShape: 'landscape',
                        description: `Sumber: ${cfg.name}`
                    }
                };
            }
        }
    } catch (err) {
        console.error('meta error:', err.message);
    }
    return { meta: { id: args.id, type: 'movie', name: 'Video' } };
});

// ---------- Eporner: link mp4 lewat halaman embed ----------
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

async function epStreams(id) {
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
        streams.push({ name: 'Eporner', title: 'Buka di browser', externalUrl: v.url });
    }
    return { streams, cacheMaxAge: 300 };
}

// ---------- xHamster & BoyfriendTV: stream ----------
async function scrapedStreams(cfg, rest) {
    const path = decodePath(rest);
    if (!path) return { streams: [] };
    const pageUrl = cfg.base + path;
    const streams = [];
    try {
        const r = await fetchHtml(pageUrl, cfg.base + '/');
        for (const d of findMedia(r.html, pageUrl)) {
            streams.push({
                name: cfg.name,
                title: d.label || 'MP4',
                url: d.url,
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: { request: { 'User-Agent': UA, Referer: cfg.base + '/' } }
                }
            });
        }
    } catch (e) {
        console.error(cfg.key + ' stream error:', e.message);
    }
    streams.push({ name: cfg.name, title: 'Buka di browser', externalUrl: pageUrl });
    return { streams, cacheMaxAge: 300 };
}

builder.defineStreamHandler(async (args) => {
    try {
        if (args.id.startsWith(EP_PREFIX)) return await epStreams(args.id.slice(EP_PREFIX.length));
        const cfg = Object.values(SCRAPED).find(c => args.id.startsWith(c.prefix));
        if (cfg) return await scrapedStreams(cfg, args.id.slice(cfg.prefix.length));
    } catch (err) {
        console.error('stream error:', err.message);
    }
    return { streams: [] };
});

// ---------- Diagnosa ----------
// 1) /debug/<id video Eporner>
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

function pageFlags(html) {
    return {
        cloudflareBlock: /Just a moment|cf-chl|challenge-platform|Attention Required|cf-browser-verification/i.test(html),
        ageGateHint: /age verification|verify your age|are you 18|over 18|age-gate|agegate/i.test(html)
    };
}

// 2) /debug-list/xh?q=kata&page=1  atau  /debug-list/bf
async function runListDebug(site, query, page) {
    const cfg = SCRAPED[site];
    if (!cfg) return { error: 'site harus xh atau bf' };
    const out = { site, query, page };
    try {
        const r = await scrapeCatalog(cfg, query, page);
        out.listUrl = r.url;
        out.status = r.status;
        out.finalUrl = r.finalUrl;
        out.length = r.html.length;
        out.title = (r.html.match(/<title>([^<]*)<\/title>/i) || [])[1];
        Object.assign(out, pageFlags(r.html));
        out.itemCount = r.items.length;
        out.withThumb = r.items.filter(i => i.thumb).length;
        out.sample = r.items.slice(0, 3).map(i => ({
            path: i.path,
            title: i.title,
            thumb: i.thumb ? maskUrl(i.thumb) : null
        }));
        if (r.html.length < 6000) out.html = r.html;
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

// 3) /probe?url=<url halaman video xHamster / BoyfriendTV>
const PROBE_ALLOWED = ['boyfriendtv.com', 'xhamster.com', 'xhamster2.com', 'xhamster3.com'];

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
        const r = await fetchHtml(u.href, u.origin + '/');
        const html = r.html;
        out.status = r.status;
        out.finalUrl = r.finalUrl;
        out.length = html.length;
        out.title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
        Object.assign(out, pageFlags(html));
        out.cookieNames = (r.headers['set-cookie'] || []).map(c => c.split('=')[0]);
        out.m3u8Count = (html.match(/\.m3u8/g) || []).length;
        out.mp4Count = (html.match(/\.mp4/g) || []).length;
        out.hasSourceTag = /<source[^>]+src=/i.test(html);
        out.hasInitials = /window\.initials/i.test(html);
        out.media = findMedia(html, u.href).map(m => ({ label: m.label, hls: m.hls, url: maskUrl(m.url) }));
        if (html.length < 6000) out.html = html;
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

const app = express();
app.use(cors());
app.get('/', (req, res) => res.redirect('/manifest.json'));
app.get('/debug/:id', async (req, res) => res.json(await runDebug(req.params.id)));
app.get('/debug-list/:site', async (req, res) =>
    res.json(await runListDebug(req.params.site, String(req.query.q || ''), parseInt(req.query.page, 10) || 1)));
app.get('/probe', async (req, res) => res.json(await runProbe(String(req.query.url || ''))));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
