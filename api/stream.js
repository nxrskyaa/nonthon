import { requireAuth } from '../lib/auth.js';

/**
 * Multi-server stream resolver for the movie/series player.
 *
 * A single TMDB title usually has several video backends on the source host
 * (e.g. StreamHG, EarnVids, RPMShare, UpnShare, StreamP2P). This endpoint
 * parses every server the embed advertises and resolves each to a playable,
 * CORS-open m3u8, returning them as an ordered list so the player can expose a
 * clean server selector (no ads, native <video> + HLS.js — no iframes).
 *
 * Response:
 *   { success, type, sources:[{ name, streamUrl, subtitles }],
 *     streamUrl, subtitles }        // streamUrl/subtitles = first source (BC)
 *
 * All stream URLs carry a short-lived proxy token, so resolved URLs are never
 * edge-cached; only a short per-instance memory cache softens repeat loads.
 */
const HOSTS = ['https://rozgarlelo.modiplay.xyz'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

const langNames = {
    en: 'English', eng: 'English', id: 'Indonesia', ind: 'Indonesia',
    es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano',
    pt: 'Português', ja: '日本語', ko: '한국어', zh: '中文',
    ar: 'العربية', hi: 'हिन्दी', ru: 'Русский', th: 'ไทย',
    vi: 'Tiếng Việt', tr: 'Türkçe', ms: 'Melayu', may: 'Melayu',
};

// ---- tiny per-instance cache -------------------------------------------------
const _cache = new Map();
function cacheGet(k) {
    const e = _cache.get(k);
    if (e && e.exp > Date.now()) return e.v;
    if (e) _cache.delete(k);
    return null;
}
function cacheSet(k, v, ttlMs) {
    if (_cache.size > 300) _cache.clear();
    _cache.set(k, { exp: Date.now() + ttlMs, v });
}

async function getText(url, referer) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
        });
        return { status: r.status, text: await r.text() };
    } finally {
        clearTimeout(timer);
    }
}

/** Pull the list of advertised servers out of the embed page. */
function parseServers(html) {
    const items = [];
    const seen = new Set();
    // switchServer(embedUrl, platform, name, fileCode, title, el)
    for (const m of html.matchAll(/switchServer\('([^']+)','([^']+)','([^']+)','([^']+)','([^']+)'/g)) {
        const key = m[2] + '|' + m[4];
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ embedUrl: m[1], platform: m[2], name: m[3], code: m[4], title: m[5] });
    }
    // Fallback for embed builds without switchServer: use the active proxy iframe.
    if (items.length === 0) {
        const iframe = html.match(/<iframe[^>]*src="([^"]*proxy\.php[^"]*)"/);
        if (iframe) {
            const p = new URLSearchParams(iframe[1].replace(/&amp;/g, '&'));
            const platform = p.get('p') || 'server';
            const code = p.get('c') || '';
            items.push({ embedUrl: iframe[1].replace(/&amp;/g, '&'), platform, name: platform, code, title: '' });
        }
    }
    return items;
}

/** Resolve one server to a playable proxy m3u8 (+ its embedded subtitles). */
async function resolveSource(host, srv) {
    const proxy = `${host}/proxy.php?p=${encodeURIComponent(srv.platform)}&c=${encodeURIComponent(srv.code)}` +
        `&title=${encodeURIComponent(srv.title || '')}&noredirect=1`;
    const { text: playerHtml } = await getText(proxy, host + '/');
    const sm = playerHtml.match(/var\s+src\s*=\s*"([^"]+serve_m3u8[^"]+)"/);
    if (!sm) return null;
    let url = sm[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (url.startsWith('/')) url = host + url;

    const subtitles = [];
    const seen = new Set();
    for (const m of playerHtml.matchAll(/(\/stream_proxy\.php\?[^\s"'<>\\]+\.vtt[^\s"'<>\\]*)/g)) {
        let su = m[1].replace(/&amp;/g, '&');
        if (su.startsWith('/')) su = host + su;
        const lm = su.match(/_([a-z]{2,3})\.vtt/i);
        const lang = lm ? lm[1].toLowerCase() : 'en';
        if (!seen.has(lang)) {
            seen.add(lang);
            subtitles.push({ lang, label: langNames[lang] || lang.toUpperCase(), url: su });
        }
    }
    return { name: srv.name || srv.platform || 'Server', streamUrl: url, subtitles };
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ error: 'Missing type or id' });

    const season = req.query.s || 1;
    const episode = req.query.e || 1;
    const embedPath = type === 'movie'
        ? `/embed/tmdb/movie?id=${id}`
        : `/embed/tmdb/tv?id=${id}&s=${season}&e=${episode}`;
    const cacheKey = `${type}|${id}|${season}|${episode}`;

    try {
        let sources = cacheGet(cacheKey);

        if (!sources) {
            let embedHtml = null;
            for (const host of HOSTS) {
                try {
                    embedHtml = (await getText(host + embedPath, host + '/')).text;
                    if (embedHtml) break;
                } catch (e) { /* try next host */ }
            }
            if (!embedHtml) return res.status(502).json({ error: 'upstream_down' });

            const servers = parseServers(embedHtml);
            if (servers.length === 0) return res.status(404).json({ error: 'no_source' });

            const host = HOSTS[0];
            const settled = await Promise.allSettled(servers.map(s => resolveSource(host, s).catch(() => null)));
            sources = settled
                .filter(r => r.status === 'fulfilled' && r.value && r.value.streamUrl)
                .map(r => r.value);

            if (sources.length === 0) return res.status(404).json({ error: 'no_stream_url' });
            cacheSet(cacheKey, sources, 300000);
        }

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(200).json({
            success: true, type,
            sources,
            streamUrl: sources[0].streamUrl,
            subtitles: sources[0].subtitles,
        });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
