// HLS Proxy - relays m3u8 + segments through our server to bypass browser CORS
// Only rewrites relative paths (/proxy.php, /stream_proxy.php) to absolute proxied URLs
export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        return res.status(400).send('Missing url param');
    }

    const targetUrl = decodeURIComponent(url);
    const origin = new URL(targetUrl).origin;

    try {
        const resp = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Referer': origin + '/',
            },
        });

        const contentType = resp.headers.get('content-type') || 'application/octet-stream';
        const buffer = Buffer.from(await resp.arrayBuffer());

        let body = buffer;

        if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
            let text = buffer.toString('utf-8');
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

            // ONLY rewrite lines that are relative paths (start with /)
            // These are the sub-playlist and segment URLs
            // DO NOT touch anything that's already encoded (contains %2F)
            const lines = text.split('\n').map(line => {
                let trimmed = line.trim();
                
                // Skip empty lines and comments (but not URI= lines)
                if (!trimmed || trimmed.startsWith('#EXT')) {
                    // Handle URI= attribute inside #EXT-X-MEDIA and #EXT-X-STREAM-INF
                    if (trimmed.includes('URI=') && (trimmed.includes('/proxy.php') || trimmed.includes('/stream_proxy.php'))) {
                        return line.replace(
                            /URI=["']?(\/(?:proxy|stream_proxy)\.php\?[^\s"',]*)/g,
                            (match, path) => {
                                const fullUrl = origin + path;
                                return 'URI="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                            }
                        );
                    }
                    // Handle URI=https://rozgarlelo... (absolute, leave as-is if already proxied, otherwise rewrite)
                    if (trimmed.includes('URI=https://rozgarlelo.modiplay.xyz')) {
                        return line.replace(
                            /URI=(https:\/\/rozgarlelo\.modiplay\.xyz\/(?:proxy|stream_proxy)\.php\?[^\s"',]*)/g,
                            (match, absUrl) => 'URI=' + '/api/proxy?url=' + encodeURIComponent(absUrl)
                        );
                    }
                    return line;
                }

                // This is a URL line (relative path to a sub-playlist or segment)
                // Only rewrite if it starts with / (relative to origin)
                if (trimmed.startsWith('/proxy.php') || trimmed.startsWith('/stream_proxy.php')) {
                    const fullUrl = origin + trimmed;
                    return '/api/proxy?url=' + encodeURIComponent(fullUrl);
                }

                // Relative without leading /
                if (!trimmed.startsWith('http') && !trimmed.startsWith('/api/')) {
                    let fullUrl;
                    if (trimmed.startsWith('/')) {
                        fullUrl = origin + trimmed;
                    } else {
                        fullUrl = baseUrl + trimmed;
                    }
                    return '/api/proxy?url=' + encodeURIComponent(fullUrl);
                }

                return line;
            });

            body = lines.join('\n');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(body);

    } catch (err) {
        res.status(502).json({ error: err.message });
    }
}
