/**
 * TEMPORARY debug probe — auth-gated, whitelisted Sansekai paths only.
 * Used to inspect raw upstream shapes during dracin-id development.
 * REMOVE BEFORE SHIPPING.
 */
import { requireAuth } from '../lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SANSEKAI = 'https://api.sansekai.my.id/api';

const ALLOWED = new Set([
    '/melolo/stream',
    '/melolo/detail',
    '/dramabox/allepisode',
    '/dramabox/decrypt',
    '/dramabox/decrypt-stream',
]);

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;
    const path = String(req.query.path || '');
    if (!ALLOWED.has(path)) return res.status(400).json({ error: 'not_allowed' });
    const q = String(req.query.q || '');
    try {
        const r = await fetch(SANSEKAI + path + (q ? '?' + q : ''), {
            headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' },
        });
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) {
            const j = await r.json();
            return res.status(r.status).json({ status: r.status, body: j });
        }
        const text = (await r.text()).slice(0, 2000);
        return res.status(r.status).json({ status: r.status, contentType: ct, bodyPreview: text });
    } catch (e) {
        return res.status(502).json({ error: 'probe_failed', detail: e.message });
    }
}
