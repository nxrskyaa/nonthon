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

// Stable-IP HLS relay (see relay-server.js, exposed via Cloudflare Tunnel).
// Direct-source tokens are bound to the resolving server's egress IP, so all
// media bytes are relayed through this host. Kept in sync by the hourly cron.
const RELAY_BASE = 'https://debian-document-thriller-congressional.trycloudflare.com';

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

// ── Direct-source resolution ────────────────────────────────────────────────
// Some modiplay servers resolve to CDNs whose proxy-issued m3u8 is broken
// (acek-cdn 403 / no CORS). The ORIGINAL embed host (e.g. vibuxer.com,
// minochinos.com) publishes the real, CORS-open m3u8 inside a packed player
// script — decode it and use that URL directly: ad-free, playable everywhere.

/** Decode a Dean-Edwards packed JS blob (base-36 word substitution). */
function decodePackedJs(html) {
    const idx = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (idx === -1) return null;
    const slice = html.slice(idx, idx + 40000);
    const m = slice.match(/\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)\)/s);
    if (!m) return null;
    const [, body, baseStr, , wordsStr] = m;
    const base = parseInt(baseStr, 10) || 36;
    const words = wordsStr.split('|');
    return body.replace(/\b([0-9a-z]+)\b/gi, (tok) => {
        const n = parseInt(tok, base);
        if (Number.isNaN(n) || n < 0 || n >= words.length) return tok;
        return words[n];
    });
}

/** Repair decode artifacts in the extracted direct m3u8 URL. */
function repairDirectUrl(u) {
    const qIdx = u.indexOf('?');
    if (qIdx === -1) return u;
    let path = u.slice(0, qIdx);
    const qs = u.slice(qIdx + 1);
    // packed single letters l,n,h get eaten inside the path segment
    path = path.replace(/_,,,,\./, '_,l,n,h,.');
    const names = ['t', 's', 'e', 'f'];
    let ni = 0;
    const out = qs.split('&').map((part) => {
        if (part === '=.') return 'i=0.4';           // eaten i=0.4 param
        if (part.startsWith('=')) {                  // eaten t/s/e/f names
            const name = ni < names.length ? names[ni] : 'x';
            ni += 1;
            return `${name}=${part.slice(1)}`;
        }
        return part;
    });
    return `${path}?${out.join('&')}`;
}

/** Fetch the original embed page and extract its verified direct m3u8. */
async function resolveDirectEmbed(embedUrl) {
    const { status, text: embedHtml } = await getText(embedUrl, embedUrl);
    if (status !== 200 || !embedHtml) return null;
    const decoded = decodePackedJs(embedHtml);
    if (!decoded) return null;
    const m = decoded.match(/"hls2"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    const url = repairDirectUrl(m[1]);
    // Verify it actually streams from our server (200 + m3u8 body) and has CORS.
    const r = await getText(url, embedUrl);
    if (r.status !== 200 || !r.text.startsWith('#EXTM3U')) return null;
    return url;
}

/** Resolve one server to a playable, CORS-open m3u8 (+ embedded subtitles). */
async function resolveSource(host, srv) {
    const proxy = `${host}/proxy.php?p=${encodeURIComponent(srv.platform)}&c=${encodeURIComponent(srv.code)}` +
        `&title=${encodeURIComponent(srv.title || '')}&noredirect=1`;
    const { text: playerHtml } = await getText(proxy, host + '/');

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

    // Preferred: the original embed host's own CORS-open direct m3u8.
    // The token in the URL is bound to OUR server IP (we resolved it), so the
    // URL is wrapped in the /api/hls relay — the browser never touches the CDN
    // directly (its requests would 403).
    const embedMatch = playerHtml.match(/var\s+EMBED_URL='([^']+)'/);
    if (embedMatch) {
        try {
            const direct = await resolveDirectEmbed(embedMatch[1]);
            if (direct) {
                const wrapped = `${RELAY_BASE}/hls?u=${Buffer.from(direct).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
                return { name: srv.name || srv.platform || 'Server', streamUrl: wrapped, subtitles };
            }
        } catch (e) { /* fall back to legacy proxy m3u8 */ }
    }

    // Legacy: modiplay proxy m3u8 (works for residential IPs on healthy CDNs).
    const sm = playerHtml.match(/var\s+src\s*=\s*"([^"]+serve_m3u8[^"]+)"/);
    if (!sm) return null;
    let url = sm[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (url.startsWith('/')) url = host + url;

    return { name: srv.name || srv.platform || 'Server', streamUrl: url, subtitles };
}

export default async function handler(req, res) {
    if (!requireAuth(req, res)) return;

    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ error: 'Missing type or id' });

    const season = req.query.s || 1;
    const episode = req.query.e || 1;

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Preferred: resolve via the stable-IP relay (tokens bound to the VM's
    // egress IP, so the relay can always fetch master/variant/segments).
    try {
        const url = `${RELAY_BASE}/resolve?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}` +
            `&s=${encodeURIComponent(season)}&e=${encodeURIComponent(episode)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
        clearTimeout(timer);
        const data = await r.json();
        if (r.ok && data.sources && data.sources.length) {
            const wrap = (u) => (/^https?:\/\//.test(u) && !u.includes('rozgarlelo.modiplay.xyz'))
                ? `${RELAY_BASE}/hls?u=${Buffer.from(u).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
                : u;
            const sources = data.sources.map((s) => ({ ...s, streamUrl: wrap(s.streamUrl) }));
            return res.status(200).json({
                success: true, type,
                sources,
                streamUrl: sources[0].streamUrl,
                subtitles: sources[0].subtitles,
            });
        }
        if (data.error === 'no_source') return res.status(404).json({ error: 'no_source' });
        // fall through to local resolution
    } catch (e) { /* relay unreachable -> local resolution below */ }

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
