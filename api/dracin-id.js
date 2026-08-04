/**
 * DRACIN — Indonesian-localized short dramas.
 *
 * The five MacCMS sources in api/dracin.js are all Mandarin audio with no
 * Indonesian track. This endpoint wraps a public aggregator (Sansekai) that
 * exposes ReelShort / DramaBox catalogs already localized to Indonesian —
 * Indonesian titles, synopses, and (for DramaBox "Sulih Suara") dubbed audio.
 *
 * Response shape is kept identical to api/dracin.js so the same grid / detail /
 * player render path works unchanged:
 *   list   -> { items:[{src,id,title,pic,episodes,remarks,year,area,overview}] }
 *   detail -> { item:{ ...same, epList:[{label, ep}] } }   (no url yet)
 *   episode-> { url }                                        (resolved lazily)
 *
 * Episode media URLs are resolved lazily (one call per episode watched) rather
 * than prefetched for the whole series: the upstream rate-limits to ~10 req/min,
 * so fetching 40+ episode manifests up front would blow the budget instantly.
 *
 * A small per-instance memory cache softens that rate limit for repeat views.
 * IMPORTANT: this is a third-party API we do not control — it can rate-limit,
 * change, or disappear. Failures degrade to an error the UI shows per-source,
 * never a crash.
 */
import { requireAuth } from '../lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SANSEKAI = 'https://api.sansekai.my.id/api';

export const ID_SOURCES = {
    reelshort: {
        label: '🔊 Drama ID',
        short: 'ID',
        note: 'Sub/Dub Indonesia · verified playable',
        shape: 'episodes',
    },
};
const ID_SOURCE_ORDER = ['reelshort'];

// ---- tiny per-instance cache (survives warm invocations only) --------------
const _cache = new Map();
function cacheGet(k) {
    const e = _cache.get(k);
    if (e && e.exp > Date.now()) return e.data;
    if (e) _cache.delete(k);
    return null;
}
function cacheSet(k, data, ttlMs) {
    // Bound the map so a long-lived warm instance can't grow without limit.
    if (_cache.size > 200) _cache.clear();
    _cache.set(k, { exp: Date.now() + ttlMs, data });
}

async function sanse(path, { ttlMs = 300000, timeoutMs = 15000 } = {}) {
    const hit = cacheGet(path);
    if (hit) return hit;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(SANSEKAI + path, {
            signal: ctrl.signal,
            headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' },
        });
        if (r.status === 429) throw new Error('rate_limited');
        if (!r.ok) throw new Error('upstream ' + r.status);
        const j = JSON.parse(await r.text());
        cacheSet(path, j, ttlMs);
        return j;
    } finally {
        clearTimeout(timer);
    }
}

// ---- ReelShort adapters ----------------------------------------------------
function rsBook(b) {
    return {
        src: 'reelshort',
        id: String(b.book_id || b.bookId || ''),
        title: b.book_title || b.title || b.book_name || '',
        titleOrig: '',
        pic: b.book_pic || b.book_cover || b.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: (b.theme || '').toString(),
        overview: '',
        updated: '',
        episodes: Number(b.chapter_count || b.chapterCount || 0) || 0,
    };
}

async function rsList() {
    const j = await sanse('/reelshort/homepage', { ttlMs: 600000 });
    const lists = j?.data?.lists || [];
    const books = [];
    const seen = new Set();
    for (const blk of lists) {
        for (const b of (blk.books || blk.book_list || [])) {
            const id = String(b.book_id || b.bookId || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const m = rsBook(b);
            if (m.title && m.pic) books.push(m);
        }
    }
    return books;
}

async function rsSearch(q) {
    const j = await sanse('/reelshort/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    // The search payload nests differently across builds; dig for any array of books.
    const pools = [];
    const walk = (v) => {
        if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') pools.push(v); v.forEach(walk); }
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j);
    const seen = new Set();
    const out = [];
    for (const arr of pools) {
        for (const b of arr) {
            const id = String(b.book_id || b.bookId || '');
            if (!id || seen.has(id)) continue;
            const m = rsBook(b);
            if (m.title && m.pic) { seen.add(id); out.push(m); }
        }
    }
    return out;
}

async function rsDetail(id) {
    const j = await sanse('/reelshort/detail?bookId=' + encodeURIComponent(id), { ttlMs: 600000 });
    if (!j || j.success === false || !j.title) return null;
    const chapters = Array.isArray(j.chapters) ? j.chapters : [];
    const total = Number(j.totalEpisodes) || chapters.length;
    const epList = (chapters.length
        ? chapters.map((c, i) => ({ label: 'Eps ' + (c.index || i + 1), ep: c.index || i + 1 }))
        : Array.from({ length: total }, (_, i) => ({ label: 'Eps ' + (i + 1), ep: i + 1 })));
    return {
        src: 'reelshort',
        id: String(id),
        title: j.title || '',
        titleOrig: '',
        pic: j.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: (j.description || '').toString(),
        episodes: epList.length,
        epList,
    };
}

/** Resolve one episode to a playable m3u8. Prefers a browser-decodable codec. */
async function rsEpisode(id, ep) {
    const j = await sanse(
        `/reelshort/episode?bookId=${encodeURIComponent(id)}&episodeNumber=${ep}`,
        { ttlMs: 3600000 },
    );
    const list = (Array.isArray(j?.videoList) ? j.videoList : [])
        .filter(v => v.url && /\.m3u8(\?|$)/i.test(v.url));
    if (!list.length) throw new Error('no_playable_variant');
    // H.265/HEVC in HLS is not decodable in most desktop browsers (Chromium
    // via MSE in particular), so pick H.264 whenever it exists and only fall
    // back to HEVC as a last resort. Within a codec, take the highest quality.
    const isH264 = v => /264|avc/i.test(String(v.encode || ''));
    const byQuality = (a, b) => Number(b.quality || 0) - Number(a.quality || 0);
    const h264 = list.filter(isH264).sort(byQuality);
    const rest = list.filter(v => !isH264(v)).sort(byQuality);
    const chosen = h264[0] || rest[0];
    return { url: chosen.url, locked: !!j.isLocked, codec: chosen.encode || '' };
}

// ---- handler ---------------------------------------------------------------
function forGrid(items) {
    return items.map(({ epList, ...rest }) => rest);
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const action = String(req.query.action || 'list');

    if (action === 'sources') {
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).json({
            success: true,
            sources: ID_SOURCE_ORDER.map(k => ({ key: k, ...ID_SOURCES[k] })),
        });
    }

    const key = String(req.query.source || 'reelshort');
    if (!ID_SOURCES[key]) return res.status(400).json({ error: 'unknown_source' });

    try {
        if (action === 'list') {
            const items = await rsList();
            res.setHeader('Cache-Control', 'private, max-age=600');
            return res.status(200).json({
                success: true, source: key, shape: 'episodes',
                page: 1, pages: 1, total: items.length, items: forGrid(items),
            });
        }

        if (action === 'search') {
            const q = String(req.query.q || '').slice(0, 60).trim();
            if (!q) return res.status(400).json({ error: 'missing_query' });
            const items = await rsSearch(q);
            res.setHeader('Cache-Control', 'private, max-age=120');
            return res.status(200).json({
                success: true, source: key, shape: 'episodes',
                total: items.length, items: forGrid(items),
            });
        }

        if (action === 'detail') {
            const id = String(req.query.id || '').trim();
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const item = await rsDetail(id);
            if (!item) return res.status(404).json({ error: 'not_found' });
            res.setHeader('Cache-Control', 'private, max-age=600');
            return res.status(200).json({ success: true, shape: 'episodes', item });
        }

        if (action === 'episode') {
            const id = String(req.query.id || '').trim();
            const ep = Math.max(1, parseInt(req.query.ep, 10) || 1);
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const { url, locked } = await rsEpisode(id, ep);
            // Do not cache the resolved URL at the edge — some carry a signed
            // auth_key with a limited lifetime; the per-instance memory cache is
            // enough and stays private.
            res.setHeader('Cache-Control', 'private, max-age=0, no-store');
            return res.status(200).json({ success: true, url, locked });
        }

        return res.status(400).json({ error: 'unknown_action' });
    } catch (err) {
        const code = err.message === 'rate_limited' ? 429 : 502;
        return res.status(code).json({ error: 'upstream_failed', detail: err.message });
    }
}
