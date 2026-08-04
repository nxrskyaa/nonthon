/**
 * NXRStream catalog proxy.
 *
 * Server-side proxy for a streaming catalog API. All branding is "NXRStream" —
 * no upstream source name is exposed in any response, header, or error message.
 *
 * Hybrid approach:
 *   - Web API (api.loklok.fun) with full crypto signing for search + screen/list
 *   - Mobile API (ga-mobile-api.loklok.tv) for detail + episodes + subtitles
 *   - Web API for stream URL (getPlayInfo) with crypto signing
 *
 * Actions:
 *   ?action=list&page=N&type=movie|tv|all        catalog listing
 *   ?action=detail&id=<id>&category=0|1          one title + parsed episode array
 *   ?action=search&q=<text>                      search
 *   ?action=media&contentId=<id>&category=0|1&episodeId=<eid>&definition=<code>
 *                                                 stream URL + subtitles
 */
import { requireAuth } from '../lib/auth.js';
import { generateHeaders, decryptResponse, getDeviceId } from '../lib/nxr-crypto.js';

const WEB_API = 'https://api.loklok.fun';
const MOB_API = 'https://ga-mobile-api.loklok.tv';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_MOB = 'okhttp/4.1.1';
const TIMEOUT_MS = 15000;

const DEVICE_ID = getDeviceId();

// ─── Web API (encrypted) ───

async function webGet(path, query = {}) {
    const url = new URL(WEB_API + path);
    Object.entries(query).forEach(([k, v]) => {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    const headers = await generateHeaders(query, null, null, DEVICE_ID);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { ...headers, 'User-Agent': UA_WEB },
        });
        const text = await r.text();
        const data = JSON.parse(text);
        if (r.headers.get('ecy') === '1' && data.data && typeof data.data === 'string') {
            data.data = decryptResponse(data.data, headers.aesKey_Internal);
        }
        return data;
    } finally { clearTimeout(timer); }
}

async function webPost(path, body = {}) {
    const headers = await generateHeaders(null, body, null, DEVICE_ID);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(WEB_API + path, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { ...headers, 'User-Agent': UA_WEB },
            body: JSON.stringify(body),
        });
        const text = await r.text();
        const data = JSON.parse(text);
        if (r.headers.get('ecy') === '1' && data.data && typeof data.data === 'string') {
            data.data = decryptResponse(data.data, headers.aesKey_Internal);
        }
        return data;
    } finally { clearTimeout(timer); }
}

// ─── Mobile API (no crypto) ───

const MOB_HEADERS = {
    lang: 'en',
    versionCode: '33',
    clientType: 'android_Official',
    deviceId: DEVICE_ID,
    'Content-Type': 'application/json',
    'User-Agent': UA_MOB,
};

async function mobGet(path, query = {}) {
    const url = new URL(MOB_API + path);
    Object.entries(query).forEach(([k, v]) => {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: MOB_HEADERS,
        });
        const text = await r.text();
        return JSON.parse(text);
    } finally { clearTimeout(timer); }
}

// ─── Helpers ───

function stripHtml(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}

/** Get category number from subType string. */
function categoryFromSubType(subType) {
    if (!subType) return 0;
    const s = subType.toUpperCase();
    if (s === 'MOVIE') return 0;
    if (s === 'DRAMA' || s === 'TV') return 1;
    if (s === 'SHORT_VIDEO' || s === 'SHORTVIDEO') return 2;
    return 0;
}

/** Map a search/list item to our normalized format. */
function mapListItem(it) {
    return {
        id: it.id,
        // Prefer the English title over the (often Korean) native `name` so
        // Drakor/Asian titles render in English/Indonesian, not Hangul.
        title: it.enName || it.name || '',
        name: it.name || '',
        enName: it.enName || '',
        coverVerticalUrl: it.coverVerticalUrl || '',
        coverHorizontalUrl: it.coverHorizontalUrl || '',
        score: it.score || 0,
        year: it.releaseTime || it.year || '',
        category: it.category ?? categoryFromSubType(it.subType),
        subType: it.subType || '',
        tagList: (it.categoryTag || it.tagList || []).map(t => t.name || t),
        areas: (it.areas || it.areaList || []).map(a => a.name || a),
    };
}

/** Map a detail item to our normalized format (from mobile API). */
function mapDetail(data, category) {
    const eps = (data.episodeVo || []).map((ep, i) => ({
        id: ep.id,
        label: ep.name || `Episode ${ep.seriesNo || i + 1}`,
        seriesNo: ep.seriesNo || i + 1,
        totalTime: ep.totalTime || 0,
        definitionList: (ep.definitionList || []).map(d => ({
            code: d.code,
            description: d.description,
        })),
        subtitlingList: (ep.subtitlingList || []).map(s => ({
            language: s.language || '',
            lang: s.languageAbbr || '',
            url: s.subtitlingUrl || '',
            translateType: s.translateType || 0,
        })),
    }));

    return {
        id: data.id,
        // Prefer the English title over the native (often Korean) `name`.
        title: data.enName || data.name || '',
        name: data.name || '',
        enName: data.enName || '',
        category,
        coverVerticalUrl: data.coverVerticalUrl || '',
        coverHorizontalUrl: data.coverHorizontalUrl || '',
        score: data.score || 0,
        year: data.year || data.releaseTime || '',
        areaList: (data.areaList || []).map(a => a.name),
        tagList: (data.tagList || data.categoryTag || []).map(t => t.name),
        introduction: stripHtml(data.introduction),
        episodeCount: data.episodeCount || eps.length,
        episodes: eps,
    };
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;
    const action = String(req.query.action || 'list');

    try {
        // ─── LIST ───
        if (action === 'list') {
            const page = Math.max(1, Math.min(999, parseInt(req.query.page, 10) || 1));
            const type = String(req.query.type || 'all');

            // Use web API screen/list (POST, encrypted)
            let params = 'MOVIE,DRAMA';
            let screenName = 'All';
            if (type === 'movie') { params = 'MOVIE'; screenName = 'Movie'; }
            else if (type === 'tv') { params = 'TV,SETI,VARIETY,TALK,COMIC,DOCUMENTARY'; screenName = 'TV Series'; }

            const data = await webPost('/cms/pc/search/screen/list', {
                size: 30,
                params,
                searchScreeningName: screenName,
                order: 'count',
            });

            if (data.code !== '00000') {
                return res.status(502).json({ error: 'upstream_error', detail: data.msg });
            }

            const items = (data.data || []).map(mapListItem)
                .filter(it => it.id && (it.coverVerticalUrl || it.coverHorizontalUrl));

            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).json({ success: true, page, items });
        }

        // ─── DETAIL ───
        if (action === 'detail') {
            const id = String(req.query.id || '').replace(/[^0-9]/g, '');
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const category = parseInt(req.query.category, 10);
            if (category !== 0 && category !== 1) return res.status(400).json({ error: 'invalid_category' });

            // Mobile API returns full detail with episodes + subtitles (no crypto needed)
            const data = await mobGet('/cms/web/movieDrama/get', { id, category });

            if (data.code !== '00000' || !data.data || !data.data.episodeVo) {
                return res.status(502).json({ error: 'upstream_error', detail: data.msg || 'no data' });
            }

            const item = mapDetail(data.data, category);
            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).json({ success: true, item });
        }

        // ─── SEARCH ───
        if (action === 'search') {
            const q = String(req.query.q || '').slice(0, 60).trim();
            if (!q) return res.status(400).json({ error: 'missing_query' });

            const data = await webPost('/cms/pc/search/searchWithKeyWord', {
                searchKeyWord: q, size: 50, sort: '', searchType: '',
            });

            if (data.code !== '00000') {
                return res.status(502).json({ error: 'upstream_error', detail: data.msg });
            }

            const items = (data.data || []).map(mapListItem).filter(it => it.id);
            res.setHeader('Cache-Control', 'private, max-age=120');
            return res.status(200).json({ success: true, items });
        }

        // ─── MEDIA (stream URL) ───
        if (action === 'media') {
            const contentId = String(req.query.contentId || '').replace(/[^0-9]/g, '');
            const category = parseInt(req.query.category, 10);
            const episodeId = String(req.query.episodeId || '').replace(/[^0-9]/g, '');
            const definition = String(req.query.definition || 'GROOT_LD');

            if (!contentId || !episodeId) return res.status(400).json({ error: 'missing_params' });
            if (category !== 0 && category !== 1) return res.status(400).json({ error: 'invalid_category' });

            const data = await webGet('/media/pc/getPlayInfo', {
                contentId, category: String(category), episodeId, definition,
            });

            if (data.code !== '00000') {
                return res.status(502).json({ error: 'stream_unavailable', detail: data.msg, code: data.code });
            }

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.status(200).json({
                success: true,
                streamUrl: data.data?.mediaUrl || '',
                subtitles: (data.data?.subtitlingList || []).map(s => ({
                    language: s.language || '', lang: s.languageAbbr || '',
                    url: s.subtitlingUrl || '', translateType: s.translateType || 0,
                })),
            });
        }

        // ─── EPISODES ───
        if (action === 'episodes') {
            const id = String(req.query.id || '').replace(/[^0-9]/g, '');
            if (!id) return res.status(400).json({ error: 'missing_id' });
            const category = parseInt(req.query.category, 10) || 1;

            const data = await webGet('/cms/pc/movieDrama/queryEpisodeList', {
                id, category: String(category), reliableDef: '0',
            });

            if (data.code !== '00000') {
                return res.status(502).json({ error: 'upstream_error', detail: data.msg });
            }

            const episodes = (data.data || []).map(ep => ({
                id: ep.id, seriesNo: ep.seriesNo, name: ep.name || '', paidMode: ep.paidMode || 0,
            }));

            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).json({ success: true, episodes });
        }

        return res.status(400).json({ error: 'unknown_action' });
    } catch (err) {
        return res.status(502).json({ error: 'upstream_failed', detail: err.message });
    }
}