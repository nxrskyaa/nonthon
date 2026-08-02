#!/usr/bin/env node
/**
 * End-to-end verification of the DRACIN feature against a running server.
 *
 *   PASSWORDS="p1,p2" node tools/verify-dracin.mjs http://localhost:8901
 *
 * Proves, with real network calls: the catalog proxy returns covers and
 * episodes for every configured source, the aggregated "Terbaru" feed merges
 * and sorts correctly, the image relay works and refuses non-allow-listed
 * hosts, and an actual episode playlist plus its first media segment are
 * fetchable for EVERY source (first and last episode).
 *
 * Notes on assertions that changed 2026-08-02:
 *  - Sources are no longer uniformly portrait. dytt/ffzy serve 1256x720 on many
 *    titles. The stream-orientation check therefore records the resolution
 *    rather than asserting portrait globally, and only asserts portrait on the
 *    hosts measured as portrait-native (ikun/uku/subo).
 *  - AES-128 HLS segments are ciphertext, so `first byte == 0x47` is NOT a
 *    valid liveness assertion. Where #EXT-X-KEY is present we assert a
 *    plausible body size instead and say so.
 */
const base = (process.argv[2] || 'http://localhost:8901').replace(/\/$/, '');
const passwords = (process.env.PASSWORDS || '').split(',').filter(Boolean);

let failures = 0;
function check(name, cond, detail = '') {
    if (!cond) failures++;
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function info(msg) { console.log('      ' + msg); }

const UAH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' };

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
for (const p of [
    '/api/dracin?action=list&source=dytt',
    '/api/dracin?action=fresh',
    '/api/dracin?action=sources',
    '/api/dracin-img?u=https%3A%2F%2Fynztctv.com%2Fx.jpg',
]) {
    const r = await fetch(base + p);
    check('anon ' + p.slice(0, 40) + ' is 401', r.status === 401, String(r.status));
}

// --- source table ---
let SOURCES = [];
{
    const r = await fetch(base + '/api/dracin?action=sources', { headers: H });
    const d = await r.json();
    SOURCES = d.sources || [];
    check('sources endpoint lists sources', r.status === 200 && SOURCES.length >= 4,
        SOURCES.map(s => s.key).join(','));
    check('every source declares a shape',
        SOURCES.every(s => s.shape === 'episodes' || s.shape === 'full'));
}

// --- catalog per source ---
const firstOf = {};
for (const s of SOURCES) {
    const r = await fetch(base + `/api/dracin?action=list&source=${s.key}&page=1`, { headers: H });
    let d = {};
    try { d = await r.json(); } catch { /* fallthrough */ }
    const items = d.items || [];
    check(`[${s.key}] list 200`, r.status === 200, String(r.status));
    check(`[${s.key}] returns items`, items.length > 0, `${items.length} items of ${d.total || 0} total`);
    if (items.length) {
        const it = items[0];
        check(`[${s.key}] item has title+cover+episodes`,
            !!it.title && !!it.pic && it.episodes > 0,
            `"${it.title}" eps=${it.episodes}`);
        const multi = items.filter(x => x.episodes > 1).length;
        info(`[${s.key}] split-episode titles on page 1: ${multi}/${items.length}  (declared shape: ${s.shape})`);
        if (s.shape === 'episodes') {
            check(`[${s.key}] shape=episodes really has splits`, multi >= Math.ceil(items.length * 0.5),
                `${multi}/${items.length}`);
        }
        firstOf[s.key] = it;
    }
    // Deep page must return distinct rows, not the same first slice.
    if ((d.pages || 1) > 3) {
        const deep = Math.min(d.pages, 25);
        const r2 = await fetch(base + `/api/dracin?action=list&source=${s.key}&page=${deep}`, { headers: H });
        const d2 = await r2.json();
        const a = new Set((items).map(x => x.id));
        const overlap = (d2.items || []).filter(x => a.has(x.id)).length;
        check(`[${s.key}] page ${deep} is distinct from page 1`,
            (d2.items || []).length > 0 && overlap === 0,
            `${(d2.items || []).length} items, ${overlap} overlapping`);
    }
}

// --- aggregated "Terbaru" feed ---
{
    const r = await fetch(base + '/api/dracin?action=fresh&per=10', { headers: H });
    const d = await r.json();
    const items = d.items || [];
    check('fresh feed 200 with items', r.status === 200 && items.length > 0, `${items.length} items`);
    const srcs = new Set(items.map(i => i.src));
    check('fresh feed mixes multiple sources', srcs.size >= 2, [...srcs].join(','));
    // sorted descending by updated
    const ts = items.map(i => i.updated).filter(Boolean);
    const sorted = ts.every((v, i) => i === 0 || ts[i - 1] >= v);
    check('fresh feed sorted newest-first', sorted, `${ts[0]} … ${ts[ts.length - 1]}`);
    // no duplicate titles across sources
    const keys = items.map(i => (i.titleOrig || '').replace(/\s+/g, ''));
    check('fresh feed deduped', new Set(keys).size === keys.length,
        `${keys.length - new Set(keys).size} dupes`);
    check('fresh feed items all playable-shaped', items.every(i => i.episodes > 0 && i.pic));
    if (d.failedSources?.length) info('sources that failed this run: ' + d.failedSources.join(','));
    info('newest 3: ' + items.slice(0, 3).map(i => `${i.title} (${i.src}, ${i.updated})`).join(' | '));
}

// --- detail + episode list + FULL playback chain, per source ---
const PORTRAIT_NATIVE = new Set(['ikun', 'uku', 'subo']);
for (const s of SOURCES) {
    const probe = firstOf[s.key];
    if (!probe) continue;
    const r = await fetch(base + `/api/dracin?action=detail&source=${s.key}&id=${probe.id}`, { headers: H });
    const d = await r.json();
    const item = d.item;
    check(`[${s.key}] detail 200 with epList`,
        r.status === 200 && Array.isArray(item?.epList) && item.epList.length > 0,
        `${item?.epList?.length || 0} episodes for "${item?.title}"`);
    if (!item?.epList?.length) continue;
    check(`[${s.key}] every episode url is m3u8`, item.epList.every(e => /\.m3u8(\?|$)/i.test(e.url)));

    // first AND last episode
    for (const [tag, ep] of [['ep1', item.epList[0]], ['epLast', item.epList[item.epList.length - 1]]]) {
        const t0 = Date.now();
        const m = await fetch(ep.url, { headers: UAH });
        const body = await m.text();
        const ms = Date.now() - t0;
        check(`[${s.key}] ${tag} m3u8 fetchable`, m.status === 200 && body.startsWith('#EXTM3U'),
            `${m.status} ${ms}ms ${ep.label}`);
        if (tag !== 'ep1') continue;

        check(`[${s.key}] media CDN sends CORS`,
            !!m.headers.get('access-control-allow-origin'),
            m.headers.get('access-control-allow-origin') || 'none');

        const res = body.match(/RESOLUTION=(\d+)x(\d+)/);
        if (res) {
            const w = Number(res[1]), h = Number(res[2]);
            info(`[${s.key}] resolution ${w}x${h} (${h > w ? 'portrait' : 'landscape'})`);
            if (PORTRAIT_NATIVE.has(s.key)) {
                check(`[${s.key}] portrait-native source really is portrait`, h > w, `${w}x${h}`);
            }
        }

        // variant -> first segment
        //
        // Two playlist shapes occur. Master playlists carry
        // #EXT-X-STREAM-INF and point at a variant; some hosts (subo) serve the
        // MEDIA playlist directly at the episode URL. Treating the latter's
        // first line as a variant fetches a .ts as if it were a playlist, which
        // fails with a 400 and reads exactly like a dead source. Detect by the
        // presence of #EXTINF in the body we already hold.
        const isMediaPlaylist = body.includes('#EXTINF');
        let vUrl = ep.url;
        let vBody = body;
        let vms = 0;
        if (!isMediaPlaylist) {
            const variant = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
            if (!variant) {
                check(`[${s.key}] playlist has a variant or segments`, false, 'neither #EXTINF nor a variant line');
                continue;
            }
            vUrl = new URL(variant, ep.url).toString();
            const tv = Date.now();
            const v = await fetch(vUrl, { headers: UAH });
            vBody = await v.text();
            vms = Date.now() - tv;
            check(`[${s.key}] variant playlist ok`, v.status === 200 && vBody.includes('#EXTINF'),
                `${v.status} ${vms}ms`);
        } else {
            info(`[${s.key}] episode URL is a media playlist (no variant tier)`);
        }
        // A variant that takes >25s reads to the user as "won't play".
        check(`[${s.key}] playlist loads under 25s`, (ms + vms) < 25000, `${ms}+${vms}ms`);
        const segCount = vBody.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
        const aes = /#EXT-X-KEY:[^\n]*METHOD=AES-128/.test(vBody);
        const dur = [...vBody.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
        info(`[${s.key}] ${segCount} segments, ${(dur / 60).toFixed(1)} min, aes128=${aes}`);

        const seg = vBody.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
        if (!seg) continue;
        const sUrl = new URL(seg, vUrl).toString();
        const sr = await fetch(sUrl, { headers: { ...UAH, Range: 'bytes=0-300000' } });
        const sBuf = Buffer.from(await sr.arrayBuffer());
        check(`[${s.key}] first media segment downloads`,
            (sr.status === 200 || sr.status === 206) && sBuf.length > 10000,
            `${sr.status} ${sr.headers.get('content-type')} ${sBuf.length}B`);
        if (aes) {
            // Ciphertext: 0x47 sync is absent by definition. hls.js decrypts
            // natively, so a plausible size is the correct assertion here.
            info(`[${s.key}] segment is AES-128 ciphertext — size asserted, TS sync not applicable`);
        } else {
            check(`[${s.key}] segment looks like MPEG-TS`, sBuf[0] === 0x47, '0x' + sBuf[0].toString(16));
        }
    }
}

// --- search, per source ---
for (const s of SOURCES) {
    const r = await fetch(base + `/api/dracin?action=search&source=${s.key}&q=${encodeURIComponent('总裁')}`, { headers: H });
    const d = await r.json();
    const items = d.items || [];
    check(`[${s.key}] search returns hits`, r.status === 200 && items.length > 0, `${items.length} items`);
    if (items.length) {
        check(`[${s.key}] search rows are playable`, items.every(i => i.episodes > 0 && i.pic));
    }
}

// --- image relay ---
for (const s of SOURCES) {
    const probe = firstOf[s.key];
    if (!probe) continue;
    const r = await fetch(base + '/api/dracin-img?u=' + encodeURIComponent(probe.pic), { headers: H });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    check(`[${s.key}] image relay serves an image`, r.status === 200 && /^image\//.test(ct),
        `${r.status} ${ct} ${buf.length}B ${new URL(probe.pic).hostname}`);
}
for (const evil of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8901/',
    'http://localhost/',
    'http://10.0.0.1/a.jpg',
    'file:///etc/passwd',
    'https://evil.example.com/a.jpg',
]) {
    const r = await fetch(base + '/api/dracin-img?u=' + encodeURIComponent(evil), { headers: H });
    check('img relay blocks ' + evil.slice(0, 32), r.status === 403 || r.status === 400, String(r.status));
}

// --- cache-control must be private on every authed route ---
for (const p of [
    '/api/dracin?action=sources',
    '/api/dracin?action=fresh&per=6',
    '/api/dracin?action=list&source=dytt&page=1',
]) {
    const r = await fetch(base + p, { headers: H });
    const cc = r.headers.get('cache-control') || '';
    check('private cache-control on ' + p.slice(0, 38),
        /private|no-store/.test(cc) && !/s-maxage|public/.test(cc), cc || 'none');
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
        info('sample title : ' + items[0].title);
        info('sample orig  : ' + items[0].titleOrig);
        info('sample meta  : ' + [items[0].remarks, items[0].area, items[0].genre].join(' | '));
        const dr = await fetch(base + `/api/dracin?action=detail&source=ffzy&id=${items[0].id}`, { headers: H });
        const dd = await dr.json();
        const labels = (dd.item?.epList || []).map(e => e.label);
        check('episode labels localised', labels.length > 0 && labels.every(l => !cjk.test(l)),
            labels.slice(0, 4).join(', '));
        check('synopsis translated', !cjk.test(dd.item?.overview || ''),
            (dd.item?.overview || '').slice(0, 60));
    }
    // The aggregated feed must be localised too — it is a different code path.
    const fr = await fetch(base + '/api/dracin?action=fresh&per=8', { headers: H });
    const fd = await fr.json();
    const fitems = fd.items || [];
    const ftrans = fitems.filter(it => !cjk.test(it.title)).length;
    check('fresh feed titles localised', ftrans >= Math.ceil(fitems.length * 0.7),
        `${ftrans}/${fitems.length}`);
}

// --- the app shell must ship the DRACIN UI ---
{
    const r = await fetch(base + '/', { headers: H });
    const app = await r.text();
    const needles = {
        'nav Dracin': 'nav-dracin',
        'renderDracin': 'function renderDracin',
        'portrait stage css': '.dracin-stage',
        'episode grid css': '.dracin-ep-grid',
        'source badge css': '.dracin-srcbadge',
        'bottom scrim': '.dracin-poster::before',
        'auto-advance': "addEventListener('ended'",
        'aspect auto-fit': 'function fitStage',
        'manifest timeout': 'manifestLoadingTimeOut',
        'bounded retry': 'netRetries',
        'sources fetched from api': 'action=sources',
        'short source codes': 'sm.short',
    };
    for (const [label, needle] of Object.entries(needles)) {
        check('app shell: ' + label, app.includes(needle));
    }
    check('app shell: no source attribution',
        !/vidbox|2embed|frembed|opensubtitles\.org|maccms|ikunzyapi|ffzy1|dyttzyapi|ukuapi|subocaiji/i.test(app));
}

console.log(failures === 0 ? '\nALL DRACIN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
