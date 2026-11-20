const axios = require('axios');

const manifest = {
    id: 'org.customgayaddon.stream',
    version: '2.4.0',
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

module.exports = async function (req, res) {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/json');

        const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
        const urlObj = new URL(req.url || '/', `https://${host}`);
        const pathname = urlObj.pathname;

        // 1. Endpoint Manifest
        if (pathname === '/' || pathname === '/manifest.json') {
            return res.status(200).send(JSON.stringify(manifest));
        }

        const parts = pathname.split('/').filter(Boolean);
        // Format path stremio: /resource/type/id.json atau /resource/type/id/extra.json
        if (parts.length >= 3) {
            const resource = parts[0];
            const id = decodeURIComponent(parts[2].replace(/\.json$/, ''));
            const extraRaw = parts[3] ? decodeURIComponent(parts[3].replace(/\.json$/, '')) : '';

            let searchQuery = 'gay';
            if (extraRaw.includes('search=')) {
                const searchPart = extraRaw.split('&').find(p => p.startsWith('search='));
                if (searchPart) {
                    const term = searchPart.split('=')[1];
                    if (term) searchQuery = `gay ${decodeURIComponent(term.replace(/\+/g, ' '))}`;
                }
            }
            if (urlObj.searchParams.has('search')) {
                searchQuery = `gay ${urlObj.searchParams.get('search')}`;
            }

            // 2. Endpoint Catalog
            if (resource === 'catalog') {
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
                return res.status(200).send(JSON.stringify({ metas }));
            }

            // 3. Endpoint Meta
            if (resource === 'meta') {
                const encodedPart = id.replace('gpub_', '');
                const videoUrl = Buffer.from(encodedPart, 'base64').toString('utf8');
                return res.status(200).send(JSON.stringify({
                    meta: {
                        id: id,
                        type: 'movie',
                        name: 'Gay Video Detail',
                        poster: '',
                        description: `Source URL: ${videoUrl}`
                    }
                }));
            }

            // 4. Endpoint Stream
            if (resource === 'stream') {
                const encodedPart = id.replace('gpub_', '');
                const videoPath = Buffer.from(encodedPart, 'base64').toString('utf8');
                const videoIdMatch = videoPath.split('/').filter(Boolean).pop();
                
                if (!videoIdMatch) return res.status(200).send(JSON.stringify({ streams: [] }));

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
                return res.status(200).send(JSON.stringify({ streams }));
            }
        }

        return res.status(404).send(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
        return res.status(200).send(JSON.stringify({ metas: [], streams: [], error: e.message }));
    }
};
