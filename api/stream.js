import { requireAuth } from '../lib/auth.js';

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const { type, id, s, e } = req.query;

    if (!type || !id) {
        return res.status(400).json({ error: 'Missing type or id' });
    }

    const MODIPLAY = 'https://rozgarlelo.modiplay.xyz';
    const langNames = { 
        en: 'English', eng: 'English', id: 'Indonesia', ind: 'Indonesia',
        es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', 
        pt: 'Português', ja: '日本語', ko: '한국어', zh: '中文',
        ar: 'العربية', hi: 'हिन्दी', ru: 'Русский', th: 'ไทย',
        vi: 'Tiếng Việt', tr: 'Türkçe',
    };

    try {
        // Step 1: Get embed page
        let embedUrl;
        if (type === 'movie') {
            embedUrl = `${MODIPLAY}/embed/tmdb/movie?id=${id}`;
        } else {
            embedUrl = `${MODIPLAY}/embed/tmdb/tv?id=${id}&s=${s || 1}&e=${e || 1}`;
        }

        const embedResp = await fetch(embedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        });
        const embedHtml = await embedResp.text();

        const iframeMatch = embedHtml.match(/<iframe[^>]*src="([^"]*proxy\.php[^"]*)"/);
        if (!iframeMatch) {
            return res.status(404).json({ error: 'No stream iframe found' });
        }

        let iframeSrc = iframeMatch[1].replace(/&amp;/g, '&');
        if (iframeSrc.startsWith('/')) {
            iframeSrc = MODIPLAY + iframeSrc;
        }

        // Step 2: Get player page
        const playerResp = await fetch(iframeSrc, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        });
        const playerHtml = await playerResp.text();

        // Extract the modiplay PROXY m3u8 URL (var src=...)
        // This is the one that works with CORS * from browser
        let streamUrl = null;
        const srcMatch = playerHtml.match(/var\s+src\s*=\s*"([^"]+serve_m3u8[^"]+)"/);
        if (srcMatch) {
            streamUrl = srcMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            if (streamUrl.startsWith('/')) {
                streamUrl = MODIPLAY + streamUrl;
            }
        }

        if (!streamUrl) {
            return res.status(404).json({ error: 'No stream URL found' });
        }

        // Extract subtitle VTT URLs
        const subStreamMatches = [...playerHtml.matchAll(/(\/stream_proxy\.php\?[^\s"'<>\\]+\.vtt[^\s"'<>\\]*)/g)];
        const subtitles = [];
        const seen = new Set();
        
        for (const m of subStreamMatches) {
            let subUrl = m[1].replace(/&amp;/g, '&');
            if (subUrl.startsWith('/')) {
                subUrl = MODIPLAY + subUrl;
            }
            const langMatch = subUrl.match(/_([a-z]{2,3})\.vtt/i);
            const lang = langMatch ? langMatch[1].toLowerCase() : 'en';
            
            if (!seen.has(lang)) {
                seen.add(lang);
                subtitles.push({
                    lang,
                    label: langNames[lang] || lang.toUpperCase(),
                    url: subUrl, // modiplay stream_proxy has CORS *
                });
            }
        }

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        return res.status(200).json({
            success: true,
            streamUrl,  // modiplay proxy URL with CORS *
            subtitles,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
