import { requireAuth } from '../lib/auth.js';

/**
 * HLS relay proxy (Vercel side).
 *
 * Direct-source m3u8 tokens are bound to the egress IP of the server that
 * resolved them, so Vercel serverless (rotating IP pool) cannot fetch the
 * CDNs directly. This endpoint forwards every request to the stable-IP relay
 * running on the VM (relay-server.js, exposed via Cloudflare Tunnel), which
 * resolves and serves m3u8 + segments with CORS.
 */
const RELAY_BASE = 'https://debian-document-thriller-congressional.trycloudflare.com';
const TIMEOUT_MS = 25000;

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const raw = String(req.query.u || '');
    let target;
    try {
        target = Buffer.from(raw, 'base64url').toString('utf8');
    } catch { target = ''; }
    if (!/^https?:\/\//.test(target)) return res.status(400).json({ error: 'invalid_url' });

    const relayUrl = `${RELAY_BASE}/hls?u=${b64url(target)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(relayUrl, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' },
        });
    } catch (e) {
        return res.status(502).json({ error: 'relay_unreachable', detail: e.message });
    } finally { clearTimeout(timer); }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const isPlaylist = type.includes('mpegurl') || target.includes('.m3u8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', isPlaylist ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300');
    return res.status(upstream.status).send(buf);
}
