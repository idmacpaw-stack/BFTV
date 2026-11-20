const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.boyfriendtv.com';

const manifest = {
    id: 'org.customboyfriendaddon',
    version: '1.0.0',
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

builder.defineCatalogHandler(async function(args) {
    try {
        let targetUrl = `${BASE_URL}/videos/`;
        if (args.extra && args.extra.search) {
            targetUrl = `${BASE_URL}/search/${encodeURIComponent(args.extra.search)}/`;
        }

        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const $ = cheerio.load(response.data);
        const metas = [];

        $('.video-item, .item-video, .thumb-block').each((index, element) => {
            const title = $(element).find('img').attr('alt') || $(element).find('.title').text().trim();
            const poster = $(element).find('img').attr('data-src') || $(element).find('img').attr('src');
            const relativeLink = $(element).find('a').attr('href');

            if (title && relativeLink) {
                const videoId = 'bftv_' + Buffer.from(relativeLink).toString('base64').replace(/=/g, '');
                metas.push({
                    id: videoId,
                    type: 'movie',
                    name: title,
                    poster: poster ? (poster.startsWith('http') ? poster : BASE_URL + poster) : undefined
                });
            }
        });

        return { metas };
    } catch (error) {
        return { metas: [] };
    }
});

builder.defineStreamHandler(async function(args) {
    try {
        const encodedPart = args.id.replace('bftv_', '');
        const videoPath = Buffer.from(encodedPart, 'base64').toString('ascii');
        const targetVideoUrl = videoPath.startsWith('http') ? videoPath : BASE_URL + videoPath;

        const response = await axios.get(targetVideoUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const $ = cheerio.load(response.data);
        let streamUrl = null;

        $('script').each((i, el) => {
            const scriptContent = $(el).html() || '';
            const match = scriptContent.match(/https?:\/\/[^"']+\.mp4[^"']*/);
            if (match && !streamUrl) {
                streamUrl = match[0];
            }
        });

        if (!streamUrl) {
            streamUrl = $('video source').attr('src') || $('iframe').attr('src');
        }

        if (streamUrl) {
            return {
                streams: [{ title: 'Direct Stream (HD)', url: streamUrl }]
            };
        }

        return { streams: [] };
    } catch (error) {
        return { streams: [] };
    }
});

// Mengekspor router khusus untuk serverless Vercel
const router = getRouter(builder.getInterface());
module.exports = (req, res) => {
    router(req, res);
};
