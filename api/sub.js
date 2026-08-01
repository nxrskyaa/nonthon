// Subtitle relay: fetch SRT/VTT from any origin, convert SRT -> WebVTT, serve with CORS.
export default async function handler(req, res) {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url param');

    const target = decodeURIComponent(url);

    try {
        const resp = await fetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        });
        let text = await resp.text();

        // Strip BOM
        text = text.replace(/^\uFEFF/, '');

        if (!text.trimStart().startsWith('WEBVTT')) {
            text = srtToVtt(text);
        }

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(text);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

function srtToVtt(srt) {
    const body = srt
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // SRT uses comma for milliseconds, VTT uses a dot
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
        // Drop the numeric counter line that precedes each cue
        .replace(/^\d+\s*$\n(?=\d{2}:\d{2}:\d{2})/gm, '')
        // Strip font/color tags OpenSubtitles uploaders often embed
        .replace(/<\/?font[^>]*>/gi, '')
        .trim();

    return 'WEBVTT\n\n' + body + '\n';
}
