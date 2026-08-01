#!/usr/bin/env node
/**
 * End-to-end verification of the Nonthon access gate against a running server.
 *
 *   node tools/verify-auth.mjs http://localhost:8901
 *
 * Exits non-zero if any assertion fails. Passwords are read from PASSWORDS env
 * (comma separated) so they never live in the repo.
 */
const base = (process.argv[2] || 'http://localhost:8901').replace(/\/$/, '');
const passwords = (process.env.PASSWORDS || '').split(',').filter(Boolean);

let failures = 0;
function check(name, cond, detail = '') {
    const mark = cond ? 'PASS' : 'FAIL';
    if (!cond) failures++;
    console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

function cookieFrom(res) {
    const sc = res.headers.get('set-cookie') || '';
    const m = sc.match(/__Host-nonthon_sess=([^;]+)/);
    return m ? `__Host-nonthon_sess=${m[1]}` : null;
}

async function main() {
    // 1. Anonymous root must serve the gate, not the app.
    const r1 = await fetch(base + '/', { redirect: 'manual' });
    const gate = await r1.text();
    check('anon root returns 200', r1.status === 200, String(r1.status));
    check('anon root shows password gate', gate.includes('Sandi Akses'));
    check('anon root does NOT leak app', !gate.includes('TMDB_API') && !gate.includes('grid-trending'));
    check('gate has CSP', !!r1.headers.get('content-security-policy'));
    check('gate has X-Frame-Options DENY', r1.headers.get('x-frame-options') === 'DENY');
    check('gate is noindex', (r1.headers.get('x-robots-tag') || '').includes('noindex'));
    check('gate not cached', (r1.headers.get('cache-control') || '').includes('no-store'));
    check('gate contains no plaintext password',
        !passwords.some(p => gate.includes(p)));

    // 2. Anonymous API routes must be 401.
    for (const [name, url] of [
        ['stream', '/api/stream?type=movie&id=634649'],
        ['subs', '/api/subs?type=movie&id=634649'],
        ['sub', '/api/sub?url=' + encodeURIComponent('https://subs5.strem.io/x')],
    ]) {
        const r = await fetch(base + url);
        check(`anon /api/${name} is 401`, r.status === 401, String(r.status));
    }

    // 3. Wrong password rejected.
    const bad = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'definitely-not-it-' + Date.now() }),
    });
    check('wrong password is 401', bad.status === 401, String(bad.status));
    check('wrong password sets no cookie', !cookieFrom(bad));

    // 4. Empty / oversized input rejected.
    const empty = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' }),
    });
    check('empty password is 401', empty.status === 401, String(empty.status));

    const getLogin = await fetch(base + '/api/login');
    check('GET /api/login is 405', getLogin.status === 405, String(getLogin.status));

    // 5. Every configured password works and yields a usable session.
    let firstCookie = null;
    for (const [i, pw] of passwords.entries()) {
        const r = await fetch(base + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        const ck = cookieFrom(r);
        check(`password #${i + 1} accepted`, r.status === 200, String(r.status));
        check(`password #${i + 1} issues cookie`, !!ck);
        const sc = r.headers.get('set-cookie') || '';
        check(`password #${i + 1} cookie is HttpOnly+Secure+SameSite`,
            /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Strict/i.test(sc));
        if (!firstCookie) firstCookie = ck;
    }

    if (!firstCookie) {
        console.log('[FAIL] no session cookie obtained — aborting authed checks');
        failures++;
        return;
    }

    // 6. Authed root serves the real app.
    const r2 = await fetch(base + '/', { headers: { cookie: firstCookie } });
    const app = await r2.text();
    check('authed root returns app', app.includes('grid-trending') && app.includes('TMDB_API'));
    check('app has Terbaru nav', app.includes('nav-latest'));
    check('app has sort options', app.includes('SORT_OPTIONS') && app.includes('buildDiscoverParams') && app.includes('Rilis Terbaru'));
    check('app has About page', app.includes('renderAbout') && app.includes('CREATED BY NxrHunt Labs'));
    check('app never embeds plaintext password', !passwords.some(p => app.includes(p)));

    // --- edge cache must never serve an authed response to an anonymous caller ---
    // Regression guard: `s-maxage` on an authenticated route let Vercel's shared
    // cache hand /api/subs to anonymous callers. Warm each route WITH a session,
    // then immediately request the identical URL WITHOUT one.
    {
        const urls = [
            '/api/subs?type=movie&id=634649',
            '/api/dracin?action=list&source=ikun&page=1',
        ];
        for (const u of urls) {
            const warm = await fetch(base + u, { headers: { cookie: firstCookie } });
            await warm.text();
            const cold = await fetch(base + u);
            const body = await cold.text();
            check('no edge-cache leak on ' + u.split('?')[0],
                cold.status === 401,
                `warm=${warm.status} cold=${cold.status}` +
                (cold.status === 200 ? ' LEAKED: ' + body.slice(0, 60) : ''));
        }
        // Cover relay too (needs a real cover URL).
        const dl = await fetch(base + '/api/dracin?action=list&source=ikun&page=1', {
            headers: { cookie: firstCookie },
        });
        const dj = await dl.json();
        const pic = dj.items?.[0]?.pic;
        if (pic) {
            const iu = '/api/dracin-img?u=' + encodeURIComponent(pic);
            const w = await fetch(base + iu, { headers: { cookie: firstCookie } });
            await w.arrayBuffer();
            const c = await fetch(base + iu);
            check('no edge-cache leak on /api/dracin-img', c.status === 401,
                `warm=${w.status} cold=${c.status}`);
        }
    }

    // --- Tampered cookie rejected ---
    const tampered = firstCookie.replace(/.$/, m => (m === 'A' ? 'B' : 'A'));
    const r3 = await fetch(base + '/', { headers: { cookie: tampered } });
    const t = await r3.text();
    check('tampered cookie falls back to gate', t.includes('Sandi Akses'));

    const r4 = await fetch(base + '/api/subs?type=movie&id=634649', { headers: { cookie: tampered } });
    check('tampered cookie blocked on API', r4.status === 401, String(r4.status));

    // 8. SSRF guard on the subtitle relay.
    for (const evil of [
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:8901/api/login',
        'http://127.0.0.1:22/',
        'file:///etc/passwd',
        'http://10.0.0.1/',
    ]) {
        const r = await fetch(base + '/api/sub?url=' + encodeURIComponent(evil), {
            headers: { cookie: firstCookie },
        });
        check(`SSRF blocked: ${evil.slice(0, 34)}`, r.status === 403 || r.status === 400, String(r.status));
    }

    // 9. Allow-listed subtitle host still works end-to-end (real fetch).
    const catalog = await fetch(base + '/api/subs?type=movie&id=634649', {
        headers: { cookie: firstCookie },
    });
    const cat = await catalog.json();
    check('subtitle catalog authed OK', catalog.status === 200 && cat.success === true);
    if (cat.subtitles && cat.subtitles.length) {
        check('catalog has languages', cat.languages > 1, `${cat.count} subs / ${cat.languages} langs`);
        const relay = await fetch(base + '/api/sub?url=' + encodeURIComponent(cat.subtitles[0].url), {
            headers: { cookie: firstCookie },
        });
        const vtt = await relay.text();
        check('relay returns WEBVTT', relay.status === 200 && vtt.startsWith('WEBVTT'), String(relay.status));
        check('relay VTT has cues', vtt.includes('-->'));
        check('relay VTT timestamps use dots', !/\d{2}:\d{2}:\d{2},\d{3}/.test(vtt));
    }

    // 10. Logout clears the cookie.
    const out = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: firstCookie } });
    check('logout 200', out.status === 200, String(out.status));
    check('logout expires cookie', /Max-Age=0/.test(out.headers.get('set-cookie') || ''));

    // 11. Brute-force throttle engages.
    let got429 = false;
    for (let i = 0; i < 14; i++) {
        const r = await fetch(base + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
            body: JSON.stringify({ password: 'brute-' + i }),
        });
        if (r.status === 429) { got429 = true; break; }
    }
    check('brute-force throttle returns 429', got429);
}

main().then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}).catch(e => {
    console.error('verifier crashed:', e);
    process.exit(2);
});
