#!/usr/bin/env node
/**
 * End-to-end verification of the DRACIN feature against a running server.
 *
 *   PASSWORDS="p1,p2" node tools/verify-dracin.mjs http://localhost:8901
 *
 * Proves, with real network calls: the catalog proxy returns portrait covers and
 * split episodes, the image relay works and refuses non-allow-listed hosts, and
 * an actual episode playlist plus its first media segment are fetchable.
 */
const base = (process.argv[2] || 'http://localhost:8901').replace(/\/$/, '');
const passwords = (process.env.PASSWORDS || '').split(',').filter(Boolean);

let failures = 0;
function check(name, cond, detail = '') {
    if (!cond) failures++;
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// --- session ---
const xff = '198.51.100.' + (10 + Math.floor(Math.random() * 200));
const lr = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ password: passwords[0] }),
});
if (lr.status !== 200) {
    console.log('cannot log in (status ' + lr.status + '):', await lr.text());
    process.exit(2);
}
const cookie = '__Host-nonthon_sess=' +
    (lr.headers.get('set-cookie') || '').match(/__Host-nonthon_sess=([^;]+)/)[1];
const H = { cookie, 'x-forwarded-for': xff };

// --- anonymous access must be refused ---
for (const p of ['/api/dracin?action=list&source=ikun', '/api/dracin-img?u=https%3A%2F%2Fynztctv.com%2Fx.jpg']) {
    const r = await fetch(base + p);
    check('anon ' + p.split('?')[0] + ' is 401', r.status === 401, String(r.status));
}

// --- catalog per source ---
const sources = ['ikun', 'ffzy', 'dbzy'];
const firstOf = {};
for (const s of sources) {
    const r = await fetch(base + `/api/dracin?action=list&source=${s}&page=1`, { headers: H });
    let d = {};
    try { d = await r.json(); } catch {}
    const items = d.items || [];
    check(`[${s}] list 200`, r.status === 200, String(r.status));
    check(`[${s}] returns items`, items.length > 0, `${items.length} items of ${d.total || 0} total`);
    if (items.length) {
        const it = items[0];
        check(`[${s}] item has title+cover+episodes`,
            !!it.title && !!it.pic && it.episodes > 0,
            `"${it.title}" eps=${it.episodes}`);
        const multi = items.filter(x => x.episodes > 1).length;
        console.log(`      split-episode titles on page 1: ${multi}/${items.length}`);
        firstOf[s] = it;
    }
}

// --- detail + episode list ---
const probeSrc = firstOf.ikun ? 'ikun' : Object.keys(firstOf)[0];
const probe = firstOf[probeSrc];
let ep1 = null, detailItem = null;
if (probe) {
    const r = await fetch(base + `/api/dracin?action=detail&source=${probeSrc}&id=${probe.id}`, { headers: H });
    const d = await r.json();
    detailItem = d.item;
    check('detail 200 with epList', r.status === 200 && Array.isArray(d.item?.epList) && d.item.epList.length > 0,
        `${d.item?.epList?.length || 0} episodes for "${d.item?.title}"`);
    if (d.item?.epList?.length) {
        ep1 = d.item.epList[0];
        check('every episode url is m3u8', d.item.epList.every(e => /\.m3u8(\?|$)/i.test(e.url)));
        console.log('      ep1:', ep1.label, ep1.url.slice(0, 88));
    }
}

// --- search ---
{
    const r = await fetch(base + `/api/dracin?action=search&source=ffzy&q=${encodeURIComponent('总裁')}`, { headers: H });
    const d = await r.json();
    check('search returns hits', r.status === 200 && (d.items || []).length > 0,
        `${(d.items || []).length} items`);
}

// --- image relay ---
if (probe) {
    const r = await fetch(base + '/api/dracin-img?u=' + encodeURIComponent(probe.pic), { headers: H });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    check('image relay serves an image', r.status === 200 && /^image\//.test(ct), `${r.status} ${ct} ${buf.length}B`);
    // JPEG dimensions, to prove the covers really are portrait
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let i = 2, w = 0, h = 0;
        while (i < buf.length - 9) {
            if (buf[i] !== 0xFF) { i++; continue; }
            const m = buf[i + 1];
            if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
                h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break;
            }
            if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            i += 2 + buf.readUInt16BE(i + 2);
        }
        check('cover is portrait', h > w, `${w}x${h}`);
    }
}
for (const evil of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8901/', 'https://evil.example.com/a.jpg']) {
    const r = await fetch(base + '/api/dracin-img?u=' + encodeURIComponent(evil), { headers: H });
    check('img relay blocks ' + evil.slice(0, 30), r.status === 403 || r.status === 400, String(r.status));
}

// --- real playback chain: playlist -> variant -> first segment ---
if (ep1) {
    const m = await fetch(ep1.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const body = await m.text();
    check('episode m3u8 fetchable', m.status === 200, `${m.status} ${m.headers.get('content-type')}`);
    check('m3u8 starts with #EXTM3U', body.startsWith('#EXTM3U'));
    check('media CDN sends CORS *', (m.headers.get('access-control-allow-origin') || '') === '*',
        m.headers.get('access-control-allow-origin') || 'none');

    const res = body.match(/RESOLUTION=(\d+)x(\d+)/);
    if (res) {
        const w = Number(res[1]), h = Number(res[2]);
        check('stream is portrait', h > w, `${w}x${h}`);
    }

    // Follow the variant playlist and pull the first segment for real.
    const variant = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (variant) {
        const vUrl = new URL(variant, ep1.url).toString();
        const v = await fetch(vUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const vBody = await v.text();
        check('variant playlist ok', v.status === 200 && vBody.includes('#EXTINF'), String(v.status));
        const seg = vBody.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
        if (seg) {
            const sUrl = new URL(seg, vUrl).toString();
            const s = await fetch(sUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const sBuf = Buffer.from(await s.arrayBuffer());
            check('first media segment downloads', s.status === 200 && sBuf.length > 10000,
                `${s.status} ${s.headers.get('content-type')} ${sBuf.length}B`);
            check('segment looks like MPEG-TS', sBuf[0] === 0x47, '0x' + sBuf[0].toString(16));
        }
    }
}

// --- last episode of the same title must also play ---
if (detailItem && detailItem.epList.length > 1) {
    const last = detailItem.epList[detailItem.epList.length - 1];
    const r = await fetch(last.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const b = await r.text();
    check('last episode also playable', r.status === 200 && b.startsWith('#EXTM3U'),
        `${last.label} ${r.status}`);
}

// --- localisation ---
{
    const r = await fetch(base + '/api/dracin?action=list&source=ffzy&page=1', { headers: H });
    const d = await r.json();
    const items = d.items || [];
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff]/;
    const translated = items.filter(it => !cjk.test(it.title)).length;
    check('titles translated to Indonesian', translated >= Math.ceil(items.length * 0.7),
        `${translated}/${items.length} non-CJK titles`);
    check('original title retained for reference', items.every(it => !!it.titleOrig));
    check('status badges localised', items.every(it => !cjk.test(it.remarks || '')));
    check('area localised', items.every(it => !cjk.test(it.area || '')));
    check('genre localised', items.every(it => !cjk.test(it.genre || '')));
    if (items[0]) {
        console.log('      sample title :', items[0].title);
        console.log('      sample orig  :', items[0].titleOrig);
        console.log('      sample meta  :', items[0].remarks, '|', items[0].area, '|', items[0].genre);
    }
    if (items[0]) {
        const dr = await fetch(base + `/api/dracin?action=detail&source=ffzy&id=${items[0].id}`, { headers: H });
        const dd = await dr.json();
        const labels = (dd.item?.epList || []).map(e => e.label);
        check('episode labels localised', labels.length > 0 && labels.every(l => !cjk.test(l)),
            labels.slice(0, 4).join(', '));
        check('synopsis translated', !cjk.test(dd.item?.overview || ''),
            (dd.item?.overview || '').slice(0, 60));
    }
}

// --- the app shell must ship the DRACIN UI ---
{
    const r = await fetch(base + '/', { headers: H });
    const app = await r.text();
    for (const [label, needle] of Object.entries({
        'nav Dracin': 'nav-dracin',
        'renderDracin': 'function renderDracin',
        'portrait stage css': '.dracin-stage',
        'episode grid css': '.dracin-ep-grid',
        'auto-advance': "addEventListener('ended'",
        'no source attribution in footer': null,
    })) {
        if (needle === null) {
            check(label, !app.includes('vidbox') && !/Source:\s*TMDB/i.test(app));
        } else {
            check(label, app.includes(needle));
        }
    }
}

console.log(failures === 0 ? '\nALL DRACIN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
