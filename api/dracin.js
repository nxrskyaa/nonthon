/**
 * DRACIN catalog proxy.
 *
 * Why a server-side proxy: the MacCMS-v10 short-drama APIs send no CORS
 * headers at all, so a browser cannot call them directly. Their *media* hosts
 * do send `Access-Control-Allow-Origin: *`, so once the JSON is proxied here,
 * hls.js plays the m3u8 straight from the CDN with no further relaying.
 *
 * ── Source selection, measured 2026-08-02 ────────────────────────────────────
 * Probed 123 candidate hosts; 30 returned a playable chain. Of those, most are
 * the *same* catalog re-served under different domains (subo/hhzy/huya/xinlang/
 * guangsu overlap 79–100% on title sets), so only one of that family is kept.
 *
 * Verified per source over 5 spread-out pages (pg 1/2/10/50/200), first AND
 * last episode of 2 titles each, plus one real segment fetch with strict TLS:
 *
 *   key   host                    titles  per-ep%  newest record   cert
 *   dytt  caiji.dyttzyapi.com     22,226   98.0%   2026-07-17      175d
 *   ffzy  ffzy1.tv                19,858   97.0%   2026-07-17       54d
 *   ikun  ikunzyapi.com            1,507   71.2%   2026-04-09       72d
 *   uku   api.ukuapi.com           9,291    0.0%   2026-08-02 09:11 42d
 *   subo  subocaiji.com           35,769    4.0%   2026-08-01 19:42 33d
 *
 * `per-ep%` is the share of records with real per-episode m3u8 splits rather
 * than one merged full-series file. It decides whether an episode grid is
 * meaningful, so it is surfaced to the UI as `shape`.
 *
 * dytt and ffzy overlap only 8% — they are genuinely different libraries and
 * both are worth carrying. uku and subo update *daily* (uku's newest record was
 * hours old at probe time) which is what makes the "Viral" feed possible; they
 * pay for that with merged single-file playback.
 *
 * DROPPED: dbzy.tv. 47.5% per-episode looks fine, but its variant playlist
 * took 71 s to load (measured twice). To a user that is "won't play", not
 * "slow". hhzyapi/huyaapi/xinlangapi/guangsuapi are dropped as duplicates of
 * subo's catalog.
 *
 * Actions:
 *   ?action=list&source=<key>&page=N        category listing
 *   ?action=detail&source=<key>&id=<vod_id> one title + parsed episode array
 *   ?action=search&source=<key>&q=<text>    search within the source
 *   ?action=fresh                           newest across every source, merged
 *   ?action=sources                          source table for the UI
 */
import { requireAuth } from '../lib/auth.js';
import {
    localizeStatus, localizeArea, localizeGenre, localizeEpLabel, translateBatch, tidyTitle,
} from '../lib/localize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const SOURCES = {
    // Largest verified per-episode catalog, and the longest cert runway.
    dytt: {
        label: 'Utama',
        short: 'UT',
        note: 'Episode terpisah · katalog terbesar',
        base: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
        type: 36,
        shape: 'episodes',
    },
    // Different library from dytt (8% title overlap), same episode structure.
    ffzy: {
        label: 'Katalog Besar',
        short: 'KB',
        note: 'Episode terpisah',
        base: 'https://ffzy1.tv/api.php/provide/vod/from/ffm3u8',
        type: 36,
        mirror: 'https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8',
        shape: 'episodes',
    },
    // Smallest catalog but natively portrait (720x1280 / 1080x1920) and unique.
    ikun: {
        label: 'Vertikal HD',
        short: 'HD',
        note: 'Portrait asli · episode terpisah',
        base: 'https://ikunzyapi.com/api.php/provide/vod',
        type: 45,
        shape: 'episodes',
    },
    // Updates daily — this is the recency source. Merged single-file playback.
    uku: {
        label: 'Update Harian',
        short: 'UH',
        note: 'Rilis terbaru · 1 file penuh per judul',
        base: 'https://api.ukuapi.com/api.php/provide/vod',
        type: 32,
        mirror: 'https://api.ukuapi88.com/api.php/provide/vod',
        shape: 'full',
    },
    // Biggest catalog of all, also daily. AES-128 HLS (hls.js handles natively).
    subo: {
        label: 'Arsip Besar',
        short: 'AB',
        note: '35rb+ judul · 1 file penuh per judul',
        base: 'https://subocaiji.com/api.php/provide/vod',
        type: 27,
        shape: 'full',
    },
};

/** Order used by the aggregated "fresh" feed and as UI tab order. */
const SOURCE_ORDER = ['dytt', 'ffzy', 'ikun', 'uku', 'subo'];

/** Sources that update daily — the only ones worth polling for "newest". */
const FRESH_SOURCES = ['uku', 'subo', 'dytt', 'ffzy'];

// Category ids that are explicitly softcore on some hosts — never queried.
const BLOCKED_TYPES = new Set([73, 62]);

const TIMEOUT_MS = 12000;

async function getJson(url, timeoutMs = TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' },
        });
        if (!r.ok) throw new Error('upstream ' + r.status);
        const text = await r.text();
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

/** Try the primary host, then the mirror if one is configured. */
async function fetchWithMirror(src, qs, timeoutMs = TIMEOUT_MS) {
    const urls = [src.base + '/?' + qs];
    if (src.mirror) urls.push(src.mirror + '/?' + qs);
    let lastErr;
    for (const u of urls) {
        try {
            return await getJson(u, timeoutMs);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('all hosts failed');
}

/**
 * MacCMS packs episodes into vod_play_url as:
 *   "Ep1$url1#Ep2$url2"
 * and multiple play groups are separated by "$$$". Only groups whose URLs are
 * .m3u8 are useful; some hosts put an HTML share page in the first group.
 */
function parseEpisodes(playUrl) {
    if (!playUrl) return [];
    const groups = String(playUrl).split('$$$');
    let best = [];
    for (const g of groups) {
        const eps = [];
        for (const part of g.split('#')) {
            if (!part.trim()) continue;
            const i = part.lastIndexOf('$');
            if (i === -1) continue;
            const label = part.slice(0, i).trim();
            const url = part.slice(i + 1).trim();
            if (!/^https?:\/\//i.test(url)) continue;
            if (!/\.m3u8(\?|$)/i.test(url)) continue;   // skip /share/ HTML pages
            eps.push({ label: label || `Eps ${eps.length + 1}`, url });
        }
        if (eps.length > best.length) best = eps;
    }
    return best;
}

function stripHtml(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
}

function mapItem(it, sourceKey) {
    const eps = parseEpisodes(it.vod_play_url);
    return {
        src: sourceKey,
        id: it.vod_id,
        title: it.vod_name || '',
        titleOrig: it.vod_name || '',
        pic: it.vod_pic || '',
        remarks: localizeStatus(it.vod_remarks),
        year: it.vod_year || '',
        area: localizeArea(it.vod_area),
        genre: localizeGenre(it.vod_class || it.type_name),
        overview: stripHtml(it.vod_content || it.vod_blurb),
        updated: it.vod_time || '',
        episodes: eps.length,
        epList: eps.map((e, i) => ({ label: localizeEpLabel(e.label, i), url: e.url })),
    };
}

/**
 * Translate titles (and optionally synopses) to Indonesian in one batched call.
 * Any genre tag the dictionary did not cover is translated in the same batch.
 * Mutates and returns the same array.
 */
async function localizeItems(items, { withOverview = false } = {}) {
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

    const texts = [];
    const slots = [];   // where each translated string goes back

    items.forEach(it => {
        texts.push(it.titleOrig);
        slots.push({ it, field: 'title' });
    });
    if (withOverview) {
        items.forEach(it => {
            texts.push(it.overview);
            slots.push({ it, field: 'overview' });
        });
    }
    // Genre tokens the dictionary missed.
    items.forEach(it => {
        if (it.genre && CJK.test(it.genre)) {
            texts.push(it.genre);
            slots.push({ it, field: 'genre' });
        }
    });

    const tr = await translateBatch(texts);
    tr.forEach((val, i) => {
        const { it, field } = slots[i];
        if (!val) return;
        it[field] = field === 'title' ? tidyTitle(val) : val;
    });
    return items;
}

/** Strip epList before sending a grid payload — the URLs are only needed on detail. */
function forGrid(items) {
    return items.map(({ epList, ...rest }) => rest);
}

/**
 * Aggregated "newest" feed.
 *
 * Every source returns page 1 in descending `vod_time` (verified: pg1 newest >=
 * pg2/10/50/200 newest on all five), so page 1 of each host *is* its newest
 * slice. Merging those and re-sorting by `vod_time` gives a real cross-source
 * recency feed without any extra endpoint.
 *
 * Failures are per-source and non-fatal: a dead host drops out of the mix
 * instead of failing the request.
 */
async function freshFeed(perSource = 12) {
    const settled = await Promise.allSettled(
        FRESH_SOURCES.map(async key => {
            const src = SOURCES[key];
            const qs = new URLSearchParams({ ac: 'detail', t: String(src.type), pg: '1' });
            const data = await fetchWithMirror(src, qs.toString(), 9000);
            return (data.list || [])
                .map(it => mapItem(it, key))
                .filter(it => it.pic && it.epList.length > 0)
                .slice(0, perSource);
        }),
    );

    const failed = [];
    let merged = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') merged = merged.concat(r.value);
        else failed.push(FRESH_SOURCES[i]);
    });

    // Dedupe on the original Chinese title — the same release appears on
    // several hosts and a duplicate row reads as broken data.
    const seen = new Set();
    merged = merged.filter(it => {
        const k = it.titleOrig.replace(/\s+/g, '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    merged.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return { items: merged, failed };
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const action = String(req.query.action || 'list');

    if (action === 'sources') {
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).json({
            success: true,
            sources: SOURCE_ORDER.map(k => ({
                key: k,
                label: SOURCES[k].label,
                short: SOURCES[k].short,
                note: SOURCES[k].note,
                shape: SOURCES[k].shape,
            })),
        });
    }

    if (action === 'fresh') {
        try {
            const { items, failed } = await freshFeed(
                Math.max(4, Math.min(20, parseInt(req.query.per, 10) || 12)),
            );
            await localizeItems(items);
            res.setHeader('Cache-Control', 'private, max-age=180');
            return res.status(200).json({
                success: true,
                source: 'fresh',
                total: items.length,
                failedSources: failed,
                items: forGrid(items),
            });
        } catch (err) {
            return res.status(502).json({ error: 'upstream_failed', detail: err.message });
        }
    }

    const key = String(req.query.source || 'dytt');
    const src = SOURCES[key];
    if (!src) return res.status(400).json({ error: 'unknown_source' });
    if (BLOCKED_TYPES.has(src.type)) return res.status(400).json({ error: 'blocked_category' });

    try {
        if (action === 'list') {
            const page = Math.max(1, Math.min(1999, parseInt(req.query.page, 10) || 1));
            const qs = new URLSearchParams({ ac: 'detail', t: String(src.type), pg: String(page) });
            const data = await fetchWithMirror(src, qs.toString());
            const items = (data.list || [])
                .map(it => mapItem(it, key))
                .filter(it => it.pic && it.epList.length > 0);
            await localizeItems(items);
            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).json({
                success: true,
                source: key,
                shape: src.shape,
                page: data.page ? Number(data.page) : page,
                pages: Number(data.pagecount) || 1,
                total: Number(data.total) || items.length,
                items: forGrid(items),
            });
        }

        if (action === 'detail') {
            const id = String(req.query.id || '').replace(/[^0-9]/g, '');
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const qs = new URLSearchParams({ ac: 'detail', ids: id });
            const data = await fetchWithMirror(src, qs.toString());
            const raw = (data.list || [])[0];
            if (!raw) return res.status(404).json({ error: 'not_found' });
            const item = mapItem(raw, key);
            if (item.epList.length === 0) return res.status(404).json({ error: 'no_playable_episodes' });
            await localizeItems([item], { withOverview: true });
            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).json({ success: true, shape: src.shape, item });
        }

        if (action === 'search') {
            const q = String(req.query.q || '').slice(0, 60).trim();
            if (!q) return res.status(400).json({ error: 'missing_query' });
            const qs = new URLSearchParams({ ac: 'detail', wd: q });
            const data = await fetchWithMirror(src, qs.toString());
            // Search leaks rows from other categories on every host measured
            // (1–4 per query), so filter back to the short-drama type id.
            const items = (data.list || [])
                .filter(it => String(it.type_id) === String(src.type))
                .map(it => mapItem(it, key))
                .filter(it => it.pic && it.epList.length > 0);
            await localizeItems(items);
            res.setHeader('Cache-Control', 'private, max-age=120');
            return res.status(200).json({
                success: true,
                source: key,
                shape: src.shape,
                total: items.length,
                items: forGrid(items),
            });
        }

        return res.status(400).json({ error: 'unknown_action' });
    } catch (err) {
        return res.status(502).json({ error: 'upstream_failed', detail: err.message });
    }
}
