// HLS Proxy - relays m3u8 + segments through our server to bypass browser CORS
// Usage: /api/proxy?url=<encoded_url>

export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing url param');
    }

    const targetUrl = decodeURIComponent(url);

    try {
        const resp = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://rozgarlelo.modiplay.xyz/',
                'Origin': 'https://rozgarlelo.modiplay.xyz',
            },
        });

        const contentType = resp.headers.get('content-type') || 'application/octet-stream';
        const buffer = Buffer.from(await resp.arrayBuffer());

        // Rewrite relative URLs in m3u8 playlists to go through our proxy
        let body = buffer;

        if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
            let text = buffer.toString('utf-8');
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const originUrl = new URL(targetUrl).origin;

            // Rewrite absolute and relative proxy.php URLs
            // Pattern 1: /proxy.php?... (relative to modiplay origin)
            text = text.replace(/\/proxy\.php\?([^\s"'<>\\]*)/g, (match, qs) => {
                const fullUrl = `https://rozgarlelo.modiplay.xyz${match}`;
                return `/api/proxy?url=${encodeURIComponent(fullUrl)}`;
            });

            // Pattern 2: /stream_proxy.php?... (relative to modiplay origin)  
            text = text.replace(/\/stream_proxy\.php\?([^\s"'<>\\]*)/g, (match, qs) => {
                const fullUrl = `https://rozgarlelo.modiplay.xyz${match}`;
                return `/api/proxy?url=${encodeURIComponent(fullUrl)}`;
            });

            // Pattern 3: relative .m3u8 or .ts URLs
            text = text.replace(/(?!\/api\/proxy\?)(["']?)(?!https?:\/\/)([^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/g, (match, quote, path) => {
                let fullUrl;
                if (path.startsWith('/')) {
                    fullUrl = originUrl + path;
                } else {
                    fullUrl = baseUrl + path;
                }
                return `/api/proxy?url=${encodeURIComponent(fullUrl)}`;
            });

            // Pattern 4: relative .ts/.aac segment URLs
            text = text.replace(/(?!\/api\/proxy\?)(["']?)(?!https?:\/\/)([^\s"'<>\\]+\.(?:ts|aac|mp4)[^\s"'<>\\]*)/g, (match, quote, path) => {
                let fullUrl;
                if (path.startsWith('/')) {
                    fullUrl = originUrl + path;
                } else {
                    fullUrl = baseUrl + path;
                }
                return `/api/proxy?url=${encodeURIComponent(fullUrl)}`;
            });

            body = text;
        }

        // Set permissive CORS + cache
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
        res.setHeader('Access-Control-Allow-Origin', '*');

        res.status(200).send(body);

    } catch (err) {
        res.status(502).json({ error: err.message });
    }
}
