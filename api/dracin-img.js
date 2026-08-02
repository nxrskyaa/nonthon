/**
 * DRACIN image relay.
 *
 * The short-drama cover hosts are third-party and some send no CORS headers,
 * set no cache headers, or are slow. Relaying them here keeps the page's CSP
 * tight (img-src stays on 'self') and lets us cache aggressively at the edge.
 *
 * Locked to an allow-list of cover CDNs so this cannot become an open image
 * proxy or an SSRF pivot.
 */
import { isAuthed, applySecurityHeaders } from '../lib/auth.js';

const ALLOWED_HOSTS = [
    // MacCMS short-drama cover hosts (verified serving portrait JPEGs)
    /^([a-z0-9-]+\.)*ffeiimg\.com$/i,
    /^([a-z0-9-]+\.)*ynztctv\.com$/i,
    /^([a-z0-9-]+\.)*dbzy5?\.com$/i,
    /^([a-z0-9-]+\.)*ikunzyapi\.com$/i,
    /^([a-z0-9-]+\.)*bfikuncdn\.com$/i,
    /^([a-z0-9-]+\.)*ffzy[a-z0-9-]*\.(com|tv)$/i,
    /^([a-z0-9-]+\.)*oag7h\.com$/i,
    /^([a-z0-9-]+\.)*vodcnd[0-9]*\.[a-z0-9-]+\.com$/i,
    // Cover hosts for the sources added 2026-08-02 (measured from ac=detail:
    // vod.dyttimage.com, img.ukuapi88.com, xinlangtupian.com)
    /^([a-z0-9-]+\.)*dyttimage\.com$/i,
    /^([a-z0-9-]+\.)*dyttzyapi\.com$/i,
    /^([a-z0-9-]+\.)*ukuapi(88)?\.com$/i,
    /^([a-z0-9-]+\.)*ukubf[0-9]*\.com$/i,
    /^([a-z0-9-]+\.)*xinlangtupian\.com$/i,
    /^([a-z0-9-]+\.)*subocaiji\.com$/i,
    // ReelShort covers
    /^([a-z0-9-]+\.)*crazymaplestudios\.com$/i,
    // NXRStream cover/image hosts
    /^([a-z0-9-]+\.)*netpop\.app$/i,
    /^([a-z0-9-]+\.)*despseek\.com$/i,
    /^([a-z0-9-]+\.)*loklok\.media$/i,
    /^([a-z0-9-]+\.)*loklok\.tv$/i,
];

const MAX_BYTES = 6 * 1024 * 1024;

export default async function handler(req, res) {
    applySecurityHeaders(res);
    if (!isAuthed(req)) return res.status(401).end();

    const raw = req.query.u;
    if (!raw) return res.status(400).end();

    let target;
    try {
        target = new URL(decodeURIComponent(Array.isArray(raw) ? raw[0] : raw));
    } catch {
        return res.status(400).end();
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return res.status(400).end();
    if (!ALLOWED_HOSTS.some(re => re.test(target.hostname))) {
        return res.status(403).end();
    }

    try {
        const upstream = await fetch(target.toString(), {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': target.origin + '/' },
        });
        if (!upstream.ok) return res.status(502).end();

        const ct = upstream.headers.get('content-type') || '';
        if (!/^image\//i.test(ct)) return res.status(415).end();

        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_BYTES) return res.status(413).end();

        res.setHeader('Content-Type', ct);
        // Private, not public: a shared edge cache would serve these to
        // anonymous callers and defeat the session check on this route.
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
        return res.status(200).send(buf);
    } catch {
        return res.status(502).end();
    }
}
