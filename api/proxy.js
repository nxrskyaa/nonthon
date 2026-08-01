// HLS Proxy - relays m3u8 + segments through our server to bypass browser CORS
// Also strips ad segments from playlists
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

            const lines = text.split('\n');

            // AD FILTERING: detect and remove ad segments
            // Ad segments are absolute URLs (tiktokcdn, etc) that are NOT from the stream provider
            // Video segments are relative paths (/proxy.php, /stream_proxy.php) or from the known CDN
            
            const processedLines = [];
            let skippingAd = false;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                let trimmed = line.trim();

                // Detect #EXT-X-DISCONTINUITY (marks ad boundaries)
                if (trimmed === '#EXT-X-DISCONTINUITY') {
                    // Could be ad boundary - check next segment
                    processedLines.push(line);
                    continue;
                }

                // Check if this is a segment URL line
                if (!trimmed || trimmed.startsWith('#')) {
                    // Handle URI= in EXT-X-MEDIA / EXT-X-STREAM-INF
                    if (trimmed.includes('URI=') && (trimmed.includes('/proxy.php') || trimmed.includes('/stream_proxy.php'))) {
                        line = line.replace(
                            /URI=["']?(\/(?:proxy|stream_proxy)\.php\?[^\s"',]*)/g,
                            (match, path) => {
                                const fullUrl = origin + path;
                                return 'URI="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                            }
                        );
                    }
                    processedLines.push(line);
                    continue;
                }

                // This is a segment URL line - check if it's an ad
                const isAd = (
                    trimmed.includes('tiktokcdn') ||
                    trimmed.includes('ad-site') ||
                    trimmed.includes('doubleclick') ||
                    trimmed.includes('googleads') ||
                    trimmed.includes('googlesyndication') ||
                    trimmed.includes('popads') ||
                    (trimmed.startsWith('http') && 
                     !trimmed.includes('hanerix') &&
                     !trimmed.includes('modiplay') &&
                     !trimmed.includes('premilkyway') &&
                     !trimmed.includes('/proxy.php') &&
                     !trimmed.includes('/stream_proxy.php') &&
                     !trimmed.includes('.ts') &&
                     !trimmed.includes('/api/proxy'))
                );

                if (isAd) {
                    // Skip this segment AND its preceding #EXTINF line
                    // Remove last EXTINF we just added
                    if (processedLines.length > 0) {
                        const lastIdx = processedLines.length - 1;
                        if (processedLines[lastIdx].trim().startsWith('#EXTINF')) {
                            processedLines.splice(lastIdx, 1);
                        }
                    }
                    // Also skip trailing #EXT-X-DISCONTINUITY if any
                    continue;
                }

                // Rewrite relative segment URLs to proxied URLs
                if (trimmed.startsWith('/proxy.php') || trimmed.startsWith('/stream_proxy.php')) {
                    const fullUrl = origin + trimmed;
                    line = '/api/proxy?url=' + encodeURIComponent(fullUrl);
                } else if (!trimmed.startsWith('http') && !trimmed.startsWith('/api/')) {
                    let fullUrl;
                    if (trimmed.startsWith('/')) {
                        fullUrl = origin + trimmed;
                    } else {
                        fullUrl = baseUrl + trimmed;
                    }
                    line = '/api/proxy?url=' + encodeURIComponent(fullUrl);
                }

                processedLines.push(line);
            }

            body = processedLines.join('\n');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(body);

    } catch (err) {
        res.status(502).json({ error: err.message });
    }
}
