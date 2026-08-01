export default async function handler(req, res) {
    const { type, id, s, e } = req.query;

    if (!type || !id) {
        return res.status(400).json({ error: 'Missing type or id' });
    }

    const PROXY_BASE = 'https://nonthon.vercel.app/api/proxy?url=';
    const langNames = { 
        en: 'English', eng: 'English', id: 'Indonesia', ind: 'Indonesia',
        es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', 
        pt: 'Português', ja: '日本語', ko: '한국어', zh: '中文',
        ar: 'العربية', hi: 'हिन्दी', ru: 'Русский', th: 'ไทย',
        vi: 'Tiếng Việt', tr: 'Türkçe',
    };

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

        // Step 2: Get the player page to extract m3u8 URL + subtitle info
        const playerResp = await fetch(iframeSrc, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': embedUrl,
            },
        });
        const playerHtml = await playerResp.text();

        // Extract proxied m3u8 URL
        let streamUrl = null;
        const srcMatch = playerHtml.match(/var\s+src\s*=\s*"([^"]+serve_m3u8[^"]+)"/);
        if (srcMatch) {
            streamUrl = srcMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            if (streamUrl.startsWith('/')) {
                streamUrl = `https://rozgarlelo.modiplay.xyz${streamUrl}`;
            }
        }

        if (!streamUrl) {
            const directMatch = playerHtml.match(/var\s+directSrc\s*=\s*"(https?:[^"]+master\.m3u8)"/);
            if (directMatch) {
                streamUrl = directMatch[1].replace(/\\\//g, '/');
            }
        }

        if (!streamUrl) {
            return res.status(404).json({ error: 'No m3u8 URL found' });
        }

        // Extract subtitle VTT URLs
        const subStreamMatches = [...playerHtml.matchAll(/(\/stream_proxy\.php\?[^\s"'<>\\]+\.vtt[^\s"'<>\\]*)/g)];
        const subtitles = [];
        const seen = new Set();
        
        for (const m of subStreamMatches) {
            let subUrl = m[1].replace(/&amp;/g, '&');
            if (subUrl.startsWith('/')) {
                subUrl = `https://rozgarlelo.modiplay.xyz${subUrl}`;
            }
            const langMatch = subUrl.match(/_([a-z]{2,3})\.vtt/i);
            const lang = langMatch ? langMatch[1].toLowerCase() : 'en';
            
            if (!seen.has(lang)) {
                seen.add(lang);
                subtitles.push({
                    lang,
                    label: langNames[lang] || lang.toUpperCase(),
                    url: PROXY_BASE + encodeURIComponent(subUrl),
                });
            }
        }

        // Rewrite stream URL to go through our proxy
        const proxiedStreamUrl = PROXY_BASE + encodeURIComponent(streamUrl);

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        return res.status(200).json({
            success: true,
            streamUrl: proxiedStreamUrl,
            subtitles,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
