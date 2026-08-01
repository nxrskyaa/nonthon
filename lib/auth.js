import crypto from 'node:crypto';

/**
 * Nonthon access control.
 *
 * Design notes (why it looks like this):
 *  - Plaintext passwords NEVER exist in this repo. The server only ever sees
 *    SHA-256(AUTH_SECRET + password) values, supplied via the ACCESS_HASHES env var.
 *  - Comparison is timing-safe, so response latency does not leak how many
 *    leading characters of a guess were correct.
 *  - The session cookie is an HMAC-signed token (HttpOnly, Secure, SameSite=Strict).
 *    There is no server-side session store, so nothing to steal at rest.
 *  - Both AUTH_SECRET and ACCESS_HASHES live only in Vercel's encrypted env store
 *    and in a 0600 file outside the git working tree.
 */

export const COOKIE_NAME = '__Host-nonthon_sess';
const SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function secret() {
    const s = process.env.AUTH_SECRET;
    if (!s || s.length < 32) {
        throw new Error('AUTH_SECRET not configured');
    }
    return s;
}

function allowedHashes() {
    return (process.env.ACCESS_HASHES || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(h => /^[0-9a-f]{64}$/.test(h));
}

/** Timing-safe equality for equal-or-unequal-length strings. */
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    // Hash both sides first so length differences don't short-circuit.
    const ha = crypto.createHash('sha256').update(ba).digest();
    const hb = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** Check a submitted password against the configured hash allow-list. */
export function checkPassword(password) {
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
        return false;
    }
    const candidate = crypto.createHash('sha256')
        .update(secret() + password)
        .digest('hex');

    let ok = false;
    // Iterate over every hash regardless of an early match: constant work.
    for (const h of allowedHashes()) {
        if (safeEqual(candidate, h)) ok = true;
    }
    return ok;
}

/** Create a signed session token. */
export function issueToken() {
    const payload = {
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
        jti: crypto.randomBytes(12).toString('hex'),
    };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
    return `${body}.${sig}`;
}

/** Verify a signed session token. Returns true only for intact, unexpired tokens. */
export function verifyToken(token) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [body, sig] = parts;
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(body) || !/^[A-Za-z0-9_-]{16,128}$/.test(sig)) return false;

    let expected;
    try {
        expected = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
    } catch {
        return false;
    }
    if (!safeEqual(sig, expected)) return false;

    try {
        const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
        if (typeof payload.exp !== 'number') return false;
        return payload.exp > Math.floor(Date.now() / 1000);
    } catch {
        return false;
    }
}

/** Parse the Cookie header without trusting framework helpers. */
export function readCookie(req, name) {
    const raw = req.headers?.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

/** True when the request carries a valid session. */
export function isAuthed(req) {
    return verifyToken(readCookie(req, COOKIE_NAME));
}

export function sessionCookie(token) {
    // __Host- prefix requires Secure, Path=/ and no Domain attribute.
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Baseline hardening headers applied to every response. */
export function applySecurityHeaders(res, { html = false } = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (html) {
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://image.tmdb.org",
            "media-src 'self' blob: https:",
            "connect-src 'self' https://api.themoviedb.org https://image.tmdb.org https: blob:",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "object-src 'none'",
        ].join('; '));
    }
}

/**
 * Gate an API route. Returns true when the caller may proceed.
 * Sends 401 and returns false otherwise.
 */
export function requireAuth(req, res) {
    applySecurityHeaders(res);
    if (isAuthed(req)) return true;
    res.status(401).json({ error: 'unauthorized' });
    return false;
}

/**
 * Best-effort brute-force throttle. Serverless instances are ephemeral and not
 * shared, so this is a speed bump per warm instance, not a global rate limit.
 * The real defence is the long random passwords plus constant-time comparison.
 */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

export function throttle(ip) {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || now - rec.first > WINDOW_MS) {
        attempts.set(ip, { first: now, count: 1 });
        return { blocked: false, remaining: MAX_ATTEMPTS - 1 };
    }
    rec.count += 1;
    if (rec.count > MAX_ATTEMPTS) {
        return { blocked: true, retryAfter: Math.ceil((rec.first + WINDOW_MS - now) / 1000) };
    }
    return { blocked: false, remaining: MAX_ATTEMPTS - rec.count };
}

export function resetThrottle(ip) {
    attempts.delete(ip);
}
