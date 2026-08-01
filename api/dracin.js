/**
 * DRACIN catalog proxy.
 *
 * Why a server-side proxy: the MacCMS-v10 short-drama APIs send no CORS
 * headers at all, so a browser cannot call them directly. Their *media* hosts
 * do send `Access-Control-Allow-Origin: *`, so once the JSON is proxied here,
 * hls.js plays the m3u8 straight from the CDN with no further relaying.
 *
 * Verified 2026-08-01 (see tools/verify-dracin.mjs for the live checks):
 *   ikunzyapi  t=45  1,507 titles, per-episode splits, 1080x1920 portrait
 *   ffzy1.tv   t=36 19,858 titles, per-episode splits, search works
 *   dbzy.tv    t=37  7,884 titles, single merged file per title
 *
 * Actions:
 *   ?action=list&source=<key>&page=N        category listing
 *   ?action=detail&source=<key>&id=<vod_id> one title + parsed episode array
 *   ?action=search&source=<key>&q=<text>    search within the source
 */
import { requireAuth } from '../lib/auth.js';
import {
    localizeStatus, localizeArea, localizeGenre, localizeEpLabel, translateBatch,
} from '../lib/localize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const SOURCES = {
    // Best structure: real per-episode splits, largest portrait covers.
    ikun: {
        label: 'Utama',
        base: 'https://ikunzyapi.com/api.php/provide/vod',
        type: 45,
    },
    // Biggest catalog by far, also per-episode.
    ffzy: {
        label: 'Katalog Besar',
        base: 'https://ffzy1.tv/api.php/provide/vod/from/ffm3u8',
        type: 36,
        mirror: 'https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8',
    },
    // Fallback; mostly single merged files rather than split episodes.
    dbzy: {
        label: 'Alternatif',
        base: 'https://dbzy.tv/api.php/provide/vod',
        type: 37,
    },
};

// Category ids that are explicitly softcore on some hosts — never queried.
const BLOCKED_TYPES = new Set([73]);

const TIMEOUT_MS = 12000;

async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
async function fetchWithMirror(src, qs) {
    const urls = [src.base + '/?' + qs];
    if (src.mirror) urls.push(src.mirror + '/?' + qs);
    let lastErr;
    for (const u of urls) {
        try {
            return await getJson(u);
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
        if (val) it[field] = val;
    });
    return items;
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const action = String(req.query.action || 'list');
    const key = String(req.query.source || 'ikun');
    const src = SOURCES[key];
    if (!src) return res.status(400).json({ error: 'unknown_source' });
    if (BLOCKED_TYPES.has(src.type)) return res.status(400).json({ error: 'blocked_category' });

    try {
        if (action === 'list') {
            const page = Math.max(1, Math.min(999, parseInt(req.query.page, 10) || 1));
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
                page: data.page ? Number(data.page) : page,
                pages: Number(data.pagecount) || 1,
                total: Number(data.total) || items.length,
                items: items.map(({ epList, ...rest }) => rest),
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
            return res.status(200).json({ success: true, item });
        }

        if (action === 'search') {
            const q = String(req.query.q || '').slice(0, 60).trim();
            if (!q) return res.status(400).json({ error: 'missing_query' });
            const qs = new URLSearchParams({ ac: 'detail', wd: q });
            const data = await fetchWithMirror(src, qs.toString());
            const items = (data.list || [])
                .map(it => mapItem(it, key))
                .filter(it => it.pic && it.epList.length > 0);
            await localizeItems(items);
            res.setHeader('Cache-Control', 'private, max-age=120');
            return res.status(200).json({
                success: true,
                source: key,
                total: Number(data.total) || items.length,
                items: items.map(({ epList, ...rest }) => rest),
            });
        }

        return res.status(400).json({ error: 'unknown_action' });
    } catch (err) {
        return res.status(502).json({ error: 'upstream_failed', detail: err.message });
    }
}
