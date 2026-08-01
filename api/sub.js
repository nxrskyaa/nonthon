// Subtitle relay: fetch SRT/VTT from an allow-listed origin, convert SRT -> WebVTT, serve to the app.
//
// Security notes:
//  - Requires a valid session (no open proxy for anonymous callers).
//  - Host allow-list prevents this endpoint being used as an SSRF pivot into
//    internal/metadata addresses (169.254.169.254, localhost, RFC1918, etc.).
//  - Only http/https schemes accepted; response size capped.
import { requireAuth } from '../lib/auth.js';

// Only the subtitle origins this app actually consumes.
const ALLOWED_HOSTS = [
    /^([a-z0-9-]+\.)*strem\.io$/i,          // OpenSubtitles v3 addon + subsN.strem.io mirrors
    /^([a-z0-9-]+\.)*opensubtitles\.org$/i,
    /^([a-z0-9-]+\.)*opensubtitles\.com$/i,
    /^([a-z0-9-]+\.)*modiplay\.xyz$/i,      // stream provider's own embedded VTT tracks
];

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB is far beyond any real subtitle file

function hostAllowed(host) {
    return ALLOWED_HOSTS.some(re => re.test(host));
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'missing_url' });

    let target;
    try {
        target = new URL(decodeURIComponent(Array.isArray(url) ? url[0] : url));
    } catch {
        return res.status(400).json({ error: 'invalid_url' });
    }

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return res.status(400).json({ error: 'bad_scheme' });
    }
    if (!hostAllowed(target.hostname)) {
        console.warn(JSON.stringify({ evt: 'sub_host_blocked', host: target.hostname }));
        return res.status(403).json({ error: 'host_not_allowed' });
    }

    try {
        const resp = await fetch(target.toString(), {
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            },
        });

        if (!resp.ok) return res.status(502).json({ error: 'upstream_' + resp.status });

        // Guard against an oversized body even if Content-Length is absent.
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

        let text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (!text.trimStart().startsWith('WEBVTT')) {
            text = srtToVtt(text);
        }

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(text);
    } catch (err) {
        return res.status(502).json({ error: 'fetch_failed' });
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
