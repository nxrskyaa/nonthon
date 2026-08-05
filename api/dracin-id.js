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
    dramabox: {
        label: '🔊 Sulih Suara',
        short: 'SS',
        note: 'Dub Indonesia asli · episode per judul',
        shape: 'episodes',
    },
    shortmax: {
        label: '🔊 Drama VIP',
        short: 'VP',
        note: 'Sub Indonesia · m3u8',
        shape: 'episodes',
    },
    pinedrama: {
        label: '📌 Drama Klik',
        short: 'DK',
        note: 'Sub Indonesia · episode per judul',
        shape: 'episodes',
    },
    netshort: {
        label: '🎯 Drama Net',
        short: 'DN',
        note: 'Sub Indonesia · episode per judul',
        shape: 'episodes',
    },
    freereels: {
        label: '🎬 Drama Bebas',
        short: 'DB',
        note: 'Sub Indonesia · m3u8',
        shape: 'episodes',
    },
    melolo: {
        label: '📱 Drama Mini',
        short: 'DM',
        note: 'Sub Indonesia · m3u8',
        shape: 'episodes',
    },
};
const ID_SOURCE_ORDER = ['reelshort', 'dramabox', 'shortmax', 'pinedrama', 'netshort', 'freereels', 'melolo'];

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

async function sanse(path, { ttlMs = 300000, timeoutMs = 15000, retries = 3 } = {}) {
    const hit = cacheGet(path);
    if (hit) return hit;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            // Upstream rate-limits to ~10 req/min; back off 1s, 2s, 4s on 429
            // so a burst doesn't trip the limit for everyone.
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(SANSEKAI + path, {
                signal: ctrl.signal,
                headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' },
            });
            if (r.status === 429) { lastErr = new Error('rate_limited'); continue; }
            if (r.status >= 500) {
                // 5xx (esp. 502) usually means the whole aggregator is down —
                // retry once for a transient blip, then fail fast so the UI
                // doesn't hang behind a dead origin.
                lastErr = new Error('upstream ' + r.status);
                if (attempt === 0) continue;
                throw lastErr;
            }
            if (!r.ok) throw new Error('upstream ' + r.status);
            const j = JSON.parse(await r.text());
            cacheSet(path, j, ttlMs);
            return j;
        } catch (e) {
            lastErr = e;
            if (e.name === 'AbortError') break; // timeout — don't hammer a hung origin
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error('upstream_failed');
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

// ---- DramaBox (dub indo "Sulih Suara") adapters ----------------------------
function dbBook(b) {
    return {
        src: 'dramabox',
        id: String(b.bookId || b.book_id || ''),
        title: b.bookName || b.book_name || b.title || '',
        titleOrig: '',
        pic: b.coverWap || b.cover || b.coverVerticalUrl || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: Array.isArray(b.tags) ? b.tags.join(', ') : String(b.tags || ''),
        overview: String(b.introduction || ''),
        updated: '',
        episodes: Number(b.chapterCount || b.chapter_count || b.episodeCount || 0) || 0,
    };
}

function dbItems(j) {
    const arr = j?.data?.list || j?.data || j?.list || (Array.isArray(j) ? j : []);
    const list = Array.isArray(arr) ? arr : (arr.list || []);
    return list.map(dbBook).filter(m => m.id && m.title);
}

async function dbList() {
    const j = await sanse('/dramabox/dubindo?classify=terbaru&page=1', { ttlMs: 600000 });
    return dbItems(j);
}

async function dbSearch(q) {
    const j = await sanse('/dramabox/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    return dbItems(j);
}

async function dbEpisodeArr(id) {
    const j = await sanse('/dramabox/allepisode?bookId=' + encodeURIComponent(id), { ttlMs: 3600000 });
    const eps = j?.data?.list || j?.data || j?.list || (Array.isArray(j) ? j : []);
    const arr = Array.isArray(eps) ? eps : (eps.list || []);
    return arr;
}

async function dbDetail(id) {
    const j = await sanse('/dramabox/detail?bookId=' + encodeURIComponent(id), { ttlMs: 600000 });
    if (!j || j.success === false) return null;
    const d = j.data || j;
    const book = dbBook(d.book || d.bookInfo || d);
    if (!book.id || !book.title) return null;
    let epCount = book.episodes;
    try { const arr = await dbEpisodeArr(id); if (arr.length) epCount = arr.length; } catch { /* keep count */ }
    const epList = Array.from({ length: Math.max(1, epCount) }, (_, i) => ({ label: 'Eps ' + (i + 1), ep: i + 1 }));
    return { ...book, episodes: epList.length, epList };
}

async function dbEpisode(id, ep) {
    const arr = await dbEpisodeArr(id);
    const target = arr[ep - 1] || arr[0];
    if (!target) throw new Error('no_episode');
    let cdn = target.cdnList || target.cdn || target.urls || [];
    if (typeof cdn === 'string') {
        try { cdn = JSON.parse(cdn); } catch { cdn = [cdn]; }
    }
    const urls = (Array.isArray(cdn) ? cdn : [cdn])
        .map(u => (typeof u === 'string' ? u : (u.url || u.file || '')))
        .filter(Boolean);
    for (const u of urls) {
        const dec = await sanse('/dramabox/decrypt?url=' + encodeURIComponent(u), { ttlMs: 600000 });
        const su = dec?.data?.streamUrl || dec?.streamUrl || dec?.data?.url || dec?.url || '';
        if (su) return { url: su, locked: false };
    }
    throw new Error('no_playable_variant');
}

// ---- ShortMax adapters ------------------------------------------------------
function smBook(b) {
    return {
        src: 'shortmax',
        id: String(b.shortPlayId || b.id || b.bookId || ''),
        title: b.title || b.name || b.shortPlayName || b.bookName || '',
        titleOrig: '',
        pic: b.cover || b.poster || b.picUrl || b.coverVerticalUrl || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: String(b.introduction || b.description || b.summary || ''),
        updated: '',
        episodes: Number(b.chapterCount || b.episodeCount || b.totalEpisodes || 0) || 0,
    };
}

function smItems(j) {
    // Raw upstream returns { results: [...] } at top level for latest/foryou,
    // and { data: { results: [...] } } for search — accept every variant.
    const arr = j?.data?.list || j?.data?.results || j?.results || j?.data || j?.list
        || (Array.isArray(j) ? j : []);
    const list = Array.isArray(arr) ? arr : (arr.list || arr.results || []);
    return list.map(smBook).filter(m => m.id && m.title);
}

async function smList() {
    const j = await sanse('/shortmax/latest?page=1', { ttlMs: 600000 });
    return smItems(j);
}

async function smSearch(q) {
    const j = await sanse('/shortmax/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    return smItems(j);
}

async function smDetail(id) {
    const j = await sanse('/shortmax/detail?shortPlayId=' + encodeURIComponent(id), { ttlMs: 600000 });
    if (!j || j.success === false) return null;
    const d = j.data || j;
    const book = smBook(d);
    if (!book.id || !book.title) return null;
    const n = book.episodes || 1;
    const epList = Array.from({ length: Math.max(1, n) }, (_, i) => ({ label: 'Eps ' + (i + 1), ep: i + 1 }));
    return { ...book, episodes: epList.length, epList };
}

async function smEpisode(id, ep) {
    const j = await sanse(`/shortmax/episode?shortPlayId=${encodeURIComponent(id)}&episodeNumber=${ep}`, { ttlMs: 3600000 });
    const data = j?.data || j;
    const found = [];
    const collect = (v) => {
        if (typeof v === 'string' && /^https?:\/\//.test(v)) found.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(data);
    // Prefer HLS (plays everywhere), then MP4, then any http URL as last resort.
    const url = found.find(u => /\.m3u8(\?|$)/i.test(u))
        || found.find(u => /\.mp4(\?|$)/i.test(u))
        || found[0] || '';
    if (!url) throw new Error('no_playable_variant');
    return { url, locked: !!data.isLocked };
}

// ---- NetShort adapters ------------------------------------------------------
function nsBook(b) {
    return {
        src: 'netshort',
        id: String(b.shortPlayId || ''),
        title: String(b.shortPlayName || b.title || '').replace(/<\/?em>/g, ''),
        titleOrig: '',
        pic: b.shortPlayCover || b.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: Array.isArray(b.labelArray || b.labels || b.labelNameList)
            ? (b.labelArray || b.labels || b.labelNameList).join(', ')
            : String(b.labels || ''),
        overview: String(b.shotIntroduce || b.description || ''),
        updated: '',
        episodes: Number(b.totalEpisode || b.total_episodes || 0) || 0,
    };
}

function nsItems(j) {
    const arr = j?.contentInfos || j?.searchCodeSearchResult || j?.data || j?.list || (Array.isArray(j) ? j : []);
    const list = Array.isArray(arr) ? arr : (arr.list || []);
    return list.map(nsBook).filter(m => m.id && m.title);
}

async function nsList() {
    const j = await sanse('/netshort/foryou?page=1', { ttlMs: 600000 });
    return nsItems(j);
}

async function nsSearch(q) {
    const j = await sanse('/netshort/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    return nsItems(j);
}

async function nsDetail(id) {
    const j = await sanse('/netshort/allepisode?shortPlayId=' + encodeURIComponent(id), { ttlMs: 600000 });
    const d = j?.data || j;
    if (!d || !d.shortPlayId) return null;
    const eps = Array.isArray(d.shortPlayEpisodeInfos) ? d.shortPlayEpisodeInfos : [];
    const epList = eps
        .map(e => ({ label: 'Eps ' + (e.episodeNo || 0), ep: e.episodeNo || 0 }))
        .filter(e => e.ep > 0);
    const total = Number(d.totalEpisode || 0) || epList.length || 1;
    return {
        src: 'netshort',
        id: String(id),
        title: String(d.shortPlayName || ''),
        titleOrig: '',
        pic: d.shortPlayCover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: Array.isArray(d.shortPlayLabels) ? d.shortPlayLabels.join(', ') : '',
        overview: String(d.shotIntroduce || ''),
        episodes: epList.length || total,
        epList: epList.length
            ? epList
            : Array.from({ length: total }, (_, i) => ({ label: 'Eps ' + (i + 1), ep: i + 1 })),
    };
}

async function nsEpisode(id, ep) {
    const j = await sanse('/netshort/allepisode?shortPlayId=' + encodeURIComponent(id), { ttlMs: 3600000 });
    const d = j?.data || j;
    const eps = Array.isArray(d?.shortPlayEpisodeInfos) ? d.shortPlayEpisodeInfos : [];
    const target = eps.find(e => Number(e.episodeNo) === Number(ep)) || eps[0];
    if (!target) throw new Error('no_episode');
    // playVoucher is the direct playable URL (m3u8 or mp4) — the upstream
    // player consumes it straight as the <video> source.
    const url = target.playVoucher || target.videoUrl || target.video_url || '';
    if (!url) throw new Error('no_playable_variant');
    return { url, locked: !!target.isLock };
}

// ---- PineDrama adapters ------------------------------------------------------
function pdBook(b) {
    return {
        src: 'pinedrama',
        id: String(b.collection_id || ''),
        title: b.title || '',
        titleOrig: '',
        pic: b.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: String(b.categories || ''),
        overview: String(b.description || ''),
        updated: '',
        episodes: Number(b.total_episodes || 0) || 0,
    };
}

function pdItems(j) {
    const d = j?.data || j;
    const arr = d?.collections || d?.results || (Array.isArray(d) ? d : []);
    return arr.map(pdBook).filter(m => m.id && m.title);
}

async function pdList() {
    // Upstream expects a cursor; page 1 is cursor=1 (mirrors SekaiDrama).
    const j = await sanse('/pinedrama/trending?cursor=1', { ttlMs: 600000 });
    return pdItems(j);
}

async function pdSearch(q) {
    const j = await sanse('/pinedrama/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    return pdItems(j);
}

async function pdDetail(id) {
    const j = await sanse('/pinedrama/detail?collection_id=' + encodeURIComponent(id), { ttlMs: 600000 });
    const d = j?.data || j;
    if (!d || !d.title) return null;
    const n = Math.max(1, Number(d.total_episodes || 0) || 1);
    const epList = Array.from({ length: n }, (_, i) => ({ label: 'Eps ' + (i + 1), ep: i + 1 }));
    return {
        src: 'pinedrama',
        id: String(id),
        title: d.title || '',
        titleOrig: '',
        pic: (Array.isArray(d.cover_urls) && d.cover_urls[0]) || d.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: String(d.description || ''),
        episodes: epList.length,
        epList,
    };
}

async function pdEpisode(id, ep) {
    const j = await sanse(
        `/pinedrama/episode?collection_id=${encodeURIComponent(id)}&episodeNumber=${ep}`,
        { ttlMs: 3600000 },
    );
    const d = j?.data || j;
    // Same priority as the aggregator's own player: best direct URL first,
    // then the Indonesian HLS variants.
    const url = d?.best_url || d?.main?.indo_hd_cdn_urls?.[0] || d?.main?.indo_cdn_urls?.[0] || '';
    if (!url) throw new Error('no_playable_variant');
    return { url, locked: false };
}

// ---- FreeReels adapters ------------------------------------------------------
function frBook(b) {
    return {
        src: 'freereels',
        id: String(b.key || b.id || ''),
        title: b.title || b.name || '',
        titleOrig: '',
        pic: b.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: Array.isArray(b.content_tags) ? b.content_tags.join(', ') : '',
        overview: String(b.desc || ''),
        updated: '',
        episodes: Number(b.episode_count || 0) || 0,
    };
}

async function frList() {
    const j = await sanse('/freereels/foryou?offset=0', { ttlMs: 600000 });
    const arr = j?.data?.items || j?.items || [];
    return arr.map(frBook).filter(m => m.id && m.title);
}

async function frSearch(q) {
    const j = await sanse('/freereels/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    const arr = j?.data?.items || j?.items || [];
    return arr.map(frBook).filter(m => m.id && m.title);
}

async function frInfo(id) {
    const j = await sanse('/freereels/detailAndAllEpisode?key=' + encodeURIComponent(id), { ttlMs: 600000 });
    return j?.data?.info || j?.info || null;
}

async function frDetail(id) {
    const info = await frInfo(id);
    if (!info || !info.id) return null;
    const eps = Array.isArray(info.episode_list) ? info.episode_list : [];
    const epList = eps.map((e, i) => ({ label: e.name || 'Eps ' + (i + 1), ep: e.id }));
    return {
        src: 'freereels',
        id: String(info.id),
        title: info.name || '',
        titleOrig: '',
        pic: info.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: String(info.desc || info.description || ''),
        episodes: epList.length,
        epList,
    };
}

async function frEpisode(id, ep) {
    const info = await frInfo(id);
    const eps = Array.isArray(info?.episode_list) ? info.episode_list : [];
    const target = eps.find(e => String(e.id) === String(ep)) || eps[0];
    if (!target) throw new Error('no_episode');
    // H.264 plays in every browser; H.265/HEVC does not (Chromium MSE), so
    // prefer the AVC variant and keep HEVC as the last resort.
    const url = target.external_audio_h264_m3u8 || target.video_url || target.m3u8_url
        || target.external_audio_h265_m3u8 || '';
    if (!url) throw new Error('no_playable_variant');
    return { url, locked: false };
}

// ---- Melolo adapters ----------------------------------------------------------
function mlBook(b) {
    return {
        src: 'melolo',
        id: String(b.book_id || b.bookId || ''),
        title: b.book_name || b.title || '',
        titleOrig: '',
        pic: b.thumb_url || b.cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: String(b.abstract || ''),
        updated: '',
        episodes: Number(b.serial_count || b.episode_count || 0) || 0,
    };
}

async function mlList() {
    const j = await sanse('/melolo/latest', { ttlMs: 600000 });
    // /melolo/latest returns a bare array (unlike /melolo/trending's {books}).
    const arr = Array.isArray(j) ? j : (j?.books || j?.data?.books || []);
    return arr.map(mlBook).filter(m => m.id && m.title);
}

async function mlSearch(q) {
    const j = await sanse('/melolo/search?query=' + encodeURIComponent(q), { ttlMs: 120000 });
    const sd = j?.data?.search_data;
    const arr = Array.isArray(sd) ? sd.flatMap(s => (Array.isArray(s?.books) ? s.books : [])) : [];
    if (arr.length) return arr.map(mlBook).filter(m => m.id && m.title);
    // Fallback: deep-walk for any array of book-shaped objects.
    const pools = [];
    const walk = (v) => {
        if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') pools.push(v); v.forEach(walk); }
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j);
    const seen = new Set();
    const out = [];
    for (const p of pools) {
        for (const b of p) {
            const m = mlBook(b);
            if (m.id && m.title && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
        }
    }
    return out;
}

async function mlDetail(id) {
    const j = await sanse('/melolo/detail?bookId=' + encodeURIComponent(id), { ttlMs: 600000 });
    const vd = j?.data?.video_data;
    if (!vd || !vd.series_id_str) return null;
    const vids = Array.isArray(vd.video_list) ? vd.video_list : [];
    const epList = vids.map((v, i) => ({ label: 'Eps ' + (i + 1), ep: v.vid }));
    return {
        src: 'melolo',
        id: String(vd.series_id_str),
        title: vd.series_title || '',
        titleOrig: '',
        pic: vd.series_cover || '',
        remarks: '',
        year: '',
        area: 'Indonesia',
        genre: '',
        overview: String(vd.series_intro || ''),
        episodes: epList.length,
        epList,
    };
}

function mlDecodeUrl(u) {
    if (!u) return '';
    if (u.startsWith('http')) return u;
    try {
        const dec = Buffer.from(u, 'base64').toString('utf8');
        if (dec.startsWith('http')) return dec;
    } catch { /* keep raw */ }
    return u;
}

async function mlEpisode(id, ep) {
    const j = await sanse('/melolo/stream?videoId=' + encodeURIComponent(ep), { ttlMs: 3600000 });
    const d = j?.data || j;
    const main = mlDecodeUrl(d?.main_url || '');
    if (main) return { url: main, locked: false };
    let model = d?.video_model;
    if (typeof model === 'string') { try { model = JSON.parse(model); } catch { model = null; } }
    const vlist = model?.video_list;
    if (vlist && typeof vlist === 'object') {
        const keys = Object.keys(vlist)
            .sort((a, b) => Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, '')));
        for (const k of keys) {
            const u = mlDecodeUrl(vlist[k]?.main_url_decoded || vlist[k]?.main_url || '');
            if (u) return { url: u, locked: false };
        }
    }
    throw new Error('no_playable_variant');
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

    const ADAPTERS = {
        reelshort: { list: rsList, search: rsSearch, detail: rsDetail, episode: rsEpisode },
        dramabox: { list: dbList, search: dbSearch, detail: dbDetail, episode: dbEpisode },
        shortmax: { list: smList, search: smSearch, detail: smDetail, episode: smEpisode },
        pinedrama: { list: pdList, search: pdSearch, detail: pdDetail, episode: pdEpisode },
        netshort: { list: nsList, search: nsSearch, detail: nsDetail, episode: nsEpisode },
        freereels: { list: frList, search: frSearch, detail: frDetail, episode: frEpisode },
        melolo: { list: mlList, search: mlSearch, detail: mlDetail, episode: mlEpisode },
    };
    const A = ADAPTERS[key];

    try {
        if (action === 'list') {
            const items = await A.list();
            res.setHeader('Cache-Control', 'private, max-age=600');
            return res.status(200).json({
                success: true, source: key, shape: 'episodes',
                page: 1, pages: 1, total: items.length, items: forGrid(items),
            });
        }

        if (action === 'search') {
            const q = String(req.query.q || '').slice(0, 60).trim();
            if (!q) return res.status(400).json({ error: 'missing_query' });
            const items = await A.search(q);
            res.setHeader('Cache-Control', 'private, max-age=120');
            return res.status(200).json({
                success: true, source: key, shape: 'episodes',
                total: items.length, items: forGrid(items),
            });
        }

        if (action === 'detail') {
            const id = String(req.query.id || '').trim();
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const item = await A.detail(id);
            if (!item) return res.status(404).json({ error: 'not_found' });
            res.setHeader('Cache-Control', 'private, max-age=600');
            return res.status(200).json({ success: true, shape: 'episodes', item });
        }

        if (action === 'episode') {
            const id = String(req.query.id || '').trim();
            const ep = Math.max(1, parseInt(req.query.ep, 10) || 1);
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const { url, locked } = await A.episode(id, ep);
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
