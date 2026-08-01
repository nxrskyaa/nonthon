import { clearCookie, applySecurityHeaders } from '../lib/auth.js';

export default function handler(req, res) {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
}
