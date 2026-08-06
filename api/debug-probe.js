/**
 * TEMPORARY debug probe — auth-gated, whitelisted Sansekai paths only.
 * Used to inspect raw upstream shapes while fixing flickreels/melolo.
 * REMOVE BEFORE SHIPPING.
 */
import { requireAuth } from '../lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SANSEKAI = 'https://api.sansekai.my.id/api';

const ALLOWED_PREFIX = ['/flickreels/', '/flick_reels/', '/flickreel/', '/melolo/', '/freereels/', '/reelshort/'];

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;
    const path = String(req.query.path || '');
    if (!ALLOWED_PREFIX.some(p => path.startsWith(p))) return res.status(400).json({ error: 'not_allowed' });
    const q = String(req.query.q || '');
    const url = SANSEKAI + path + (q ? '?' + q : '');
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' },
        });
        const text = (await r.text()).slice(0, 3000);
        return res.status(r.status).json({ status: r.status, url, bodyPreview: text });
    } catch (e) {
        return res.status(502).json({ error: 'probe_failed', detail: e.message });
    }
}
