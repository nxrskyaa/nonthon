import {
    checkPassword, issueToken, sessionCookie, applySecurityHeaders,
    throttle, resetThrottle, clientIp,
} from '../lib/auth.js';

export default async function handler(req, res) {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    const ip = clientIp(req);
    const t = throttle(ip);
    if (t.blocked) {
        res.setHeader('Retry-After', String(t.retryAfter));
        return res.status(429).json({ error: 'too_many_attempts', retryAfter: t.retryAfter });
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    const password = body && typeof body.password === 'string' ? body.password : '';

    // Uniform delay so a rejected guess cannot be distinguished by timing
    // from an accepted one at the network layer.
    const started = Date.now();
    let ok = false;
    try {
        ok = checkPassword(password);
    } catch (e) {
        return res.status(500).json({ error: 'auth_not_configured' });
    }
    const elapsed = Date.now() - started;
    if (elapsed < 120) {
        await new Promise(r => setTimeout(r, 120 - elapsed));
    }

    if (!ok) {
        console.warn(JSON.stringify({ evt: 'login_failed', ip, ua: req.headers['user-agent'] || '' }));
        return res.status(401).json({ error: 'invalid_password' });
    }

    resetThrottle(ip);
    res.setHeader('Set-Cookie', sessionCookie(issueToken()));
    console.log(JSON.stringify({ evt: 'login_ok', ip }));
    return res.status(200).json({ ok: true });
}
