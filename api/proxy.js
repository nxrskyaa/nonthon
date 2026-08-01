// HLS Proxy — passes through m3u8 playlists and segments, rewriting relative paths
// Keeps it simple: only rewrite relative → absolute, then proxy through us
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
                'Referer': new URL(targetUrl).origin + '/',
            },
        });

        const contentType = resp.headers.get('content-type') || '';
        const text = await resp.text();

        // Determine if this is a playlist
        const isPlaylist = contentType.includes('mpegurl') || 
                          targetUrl.includes('.m3u8') ||
                          text.trimStart().startsWith('#EXTM3U');

        if (isPlaylist) {
            const origin = new URL(targetUrl).origin;
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

            // Process line by line
            const lines = text.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    // Rewrite URI= attributes in tags
                    return line.replace(
                        /URI=["']?(\/(?:proxy|stream_proxy)\.php\?[^"'\s,]*)/g,
                        (m, path) => 'URI="/api/proxy?url=' + encodeURIComponent(origin + path) + '"'
                    );
                }

                // Skip ad segments from known ad domains
                const adDomains = ['tiktokcdn', 'ad-site-i18n', 'doubleclick', 'googleads', 'googlesyndication', 'popads'];
                if (adDomains.some(d => trimmed.includes(d))) {
                    return '__AD__'; // mark for removal (with its EXTINF)
                }

                // Segment or sub-playlist URL
                let fullUrl;
                if (trimmed.startsWith('http')) {
                    fullUrl = trimmed;
                } else if (trimmed.startsWith('/proxy.php') || trimmed.startsWith('/stream_proxy.php')) {
                    fullUrl = origin + trimmed;
                } else if (trimmed.startsWith('/')) {
                    fullUrl = origin + trimmed;
                } else {
                    fullUrl = baseUrl + trimmed;
                }

                return '/api/proxy?url=' + encodeURIComponent(fullUrl);
            });

            // Remove ad segments and their preceding #EXTINF lines
            const filtered = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i] === '__AD__') {
                    // Remove preceding #EXTINF
                    if (filtered.length > 0 && filtered[filtered.length - 1].includes('#EXTINF')) {
                        filtered.pop();
                    }
                    // Also remove preceding #EXT-X-DISCONTINUITY if present
                    if (filtered.length > 0 && filtered[filtered.length - 1].includes('#EXT-X-DISCONTINUITY')) {
                        filtered.pop();
                    }
                    continue;
                }
                filtered.push(lines[i]);
            }

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(200).send(filtered.join('\n'));
        }

        // Binary segment — pass through
        const buffer = Buffer.from(await resp.arrayBuffer());
        res.setHeader('Content-Type', contentType || 'video/mp2t');
        res.setHeader('Cache-Control', 's-maxage=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(buffer);

    } catch (err) {
        res.status(502).json({ error: err.message });
    }
}
