const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';

export default async function handler(req, res) {
    const { type, id, s, e } = req.query;

    if (!type || !id) {
        return res.status(400).json({ error: 'Missing type or id' });
    }

    try {
        // Step 1: Get embed page from modiplay
        let embedUrl;
        if (type === 'movie') {
            embedUrl = `https://rozgarlelo.modiplay.xyz/embed/tmdb/movie?id=${id}`;
        } else {
            embedUrl = `https://rozgarlelo.modiplay.xyz/embed/tmdb/tv?id=${id}&s=${s || 1}&e=${e || 1}`;
        }

        const embedResp = await fetch(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://vidbox.vc/',
            },
        });
        const embedHtml = await embedResp.text();

        // Find iframe src with proxy.php
        const iframeMatch = embedHtml.match(/<iframe[^>]*src="([^"]*proxy\.php[^"]*)"/);
        if (!iframeMatch) {
            return res.status(404).json({ error: 'No stream iframe found' });
        }

        let iframeSrc = iframeMatch[1].replace(/&amp;/g, '&');
        if (iframeSrc.startsWith('/')) {
            iframeSrc = `https://rozgarlelo.modiplay.xyz${iframeSrc}`;
        }

        // Step 2: Get the player page to extract m3u8 URL
        const playerResp = await fetch(iframeSrc, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': embedUrl,
            },
        });
        const playerHtml = await playerResp.text();

        // Extract proxied m3u8 URL
        const srcMatch = playerHtml.match(/var\s+src\s*=\s*"([^"]+serve_m3u8[^"]+)"/);
        if (srcMatch) {
            let streamUrl = srcMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            if (streamUrl.startsWith('/')) {
                streamUrl = `https://rozgarlelo.modiplay.xyz${streamUrl}`;
            }
            return res.status(200).json({ 
                success: true, 
                streamUrl,
                type: 'proxy_m3u8'
            });
        }

        // Try directSrc fallback
        const directMatch = playerHtml.match(/var\s+directSrc\s*=\s*"(https?:[^"]+master\.m3u8)"/);
        if (directMatch) {
            let directUrl = directMatch[1].replace(/\\\//g, '/');
            return res.status(200).json({ 
                success: true, 
                streamUrl: directUrl,
                type: 'direct_m3u8'
            });
        }

        return res.status(404).json({ error: 'No m3u8 URL found in player page' });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
