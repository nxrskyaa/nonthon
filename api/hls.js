import { requireAuth } from '../lib/auth.js';

/**
 * HLS relay — serves m3u8 playlists and segments through this server.
 *
 * Why: direct-source m3u8 URLs carry tokens that are bound to the IP which
 * resolved them (the embed host issues a token for the requesting client).
 * A user's browser cannot fetch them directly (403), so this endpoint fetches
 * every playlist/segment from OUR server IP (where the token is valid) and
 * re-serves it with CORS headers. All URLs inside playlists are rewritten to
 * route back through this same endpoint.
 *
 * Usage: /api/hls?u=<base64url(targetUrl)>
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchTarget(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': UA },
            redirect: 'follow',
        });
        const buf = Buffer.from(await r.arrayBuffer());
        return { status: r.status, type: r.headers.get('content-type') || '', buf };
    } finally {
        clearTimeout(timer);
    }
}

/** Rewrite every URI reference inside an m3u8 to route through /api/hls. */
function rewritePlaylist(text, baseUrl) {
    const base = new URL(baseUrl);
    const wrap = (raw) => {
        if (!raw) return raw;
        let abs;
        try { abs = new URL(raw, base).toString(); } catch { return raw; }
        return `/api/hls?u=${b64url(abs)}`;
    };
    // URI="..." inside #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF lines
    let out = text.replace(/URI="([^"]*)"/g, (m, uri) => `URI="${wrap(uri)}"`);
    // standalone URI lines (variant playlists, segment entries)
    out = out.split('\n').map((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        return wrap(t);
    }).join('\n');
    return out;
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const raw = String(req.query.u || '');
    let target;
    try {
        target = Buffer.from(raw, 'base64url').toString('utf8');
    } catch { target = ''; }
    if (!/^https?:\/\//.test(target)) return res.status(400).json({ error: 'invalid_url' });

    const { status, type, buf } = await fetchTarget(target);
    if (status !== 200) return res.status(status).json({ error: 'upstream_fetch_failed' });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const isPlaylist = type.includes('mpegurl') || target.includes('.m3u8');
    if (isPlaylist) {
        const text = rewritePlaylist(buf.toString('utf8'), target);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.status(200).send(text);
    }

    res.setHeader('Content-Type', type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(buf);
}
