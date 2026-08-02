/**
 * Indonesian localisation for the Chinese short-drama catalogs.
 *
 * Two layers, deliberately:
 *  1. A deterministic dictionary + regex pass for the fields that are drawn
 *     from a small fixed vocabulary (status, region, genre, episode labels).
 *     No network, no cache misses, always correct.
 *  2. A batched machine translation for free-text titles and synopses, which
 *     are unbounded and cannot be dictionaried. Results are memoised per
 *     serverless instance; failures fall back to the original text so a
 *     translation outage degrades to Chinese titles rather than an error.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- layer 1: fixed vocabulary ----

const STATUS = [
    [/^已完结$/, 'Tamat'],
    [/^完结$/, 'Tamat'],
    [/^全集完结$/, 'Tamat · Full'],
    [/^全集$/, 'Full'],
    [/^正片$/, 'Full'],
    [/^更新至(\d+)集?$/, 'Update eps $1'],
    [/^连载中$/, 'Ongoing'],
    [/^全(\d+)集$/, '$1 episode'],
    [/^第(\d+)集$/, 'Eps $1'],
    [/^(\d+)集全$/, '$1 episode'],
    [/^预告$/, 'Trailer'],
    [/^抢先版$/, 'Versi Awal'],
    [/^HD$/i, 'HD'],
];

const AREA = {
    '中国大陆': 'Tiongkok', '大陆': 'Tiongkok', '中国': 'Tiongkok',
    '内地': 'Tiongkok', '香港': 'Hong Kong', '台湾': 'Taiwan',
    '韩国': 'Korea', '日本': 'Jepang', '泰国': 'Thailand',
    '美国': 'Amerika', '英国': 'Inggris', '其他': 'Lainnya',
};

const GENRE = {
    '短剧': 'Drama Pendek', '短剧大全': 'Drama Pendek', '爽文短剧': 'Drama Pendek Populer',
    '动漫短剧': 'Drama Pendek Animasi', '短片': 'Film Pendek', '微短剧': 'Mikro Drama',
    '剧情': 'Drama', '爱情': 'Romansa', '言情': 'Romansa', '恋爱': 'Romansa',
    '都市': 'Urban', '古装': 'Kostum Sejarah', '穿越': 'Time Travel', '重生': 'Reinkarnasi',
    '甜宠': 'Romantis Manis', '虐恋': 'Romansa Pahit', '逆袭': 'Comeback',
    '战神': 'Dewa Perang', '总裁': 'CEO', '豪门': 'Keluarga Kaya', '家庭': 'Keluarga',
    '悬疑': 'Misteri', '喜剧': 'Komedi', '玄幻': 'Fantasi', '仙侠': 'Xianxia',
    '武侠': 'Wuxia', '励志': 'Inspiratif', '亲情': 'Kekeluargaan',
    '奇幻': 'Fantasi', '科幻': 'Sci-Fi', '励志逆袭': 'Comeback',
    '萌宝': 'Anak Ajaib', '马甲': 'Identitas Rahasia', '复仇': 'Balas Dendam',
    '动作': 'Aksi', '冒险': 'Petualangan', '惊悚': 'Thriller', '恐怖': 'Horor',
    '犯罪': 'Kriminal', '战争': 'Perang', '历史': 'Sejarah', '古代': 'Sejarah',
    '农村': 'Pedesaan', '校园': 'Sekolah', '青春': 'Remaja', '职场': 'Kantor',
    '权谋': 'Intrik Politik', '宫廷': 'Istana', '女频': 'Fokus Wanita',
    '男频': 'Fokus Pria', '现代': 'Modern', '传奇': 'Legenda', '神豪': 'Sultan',
    '婚姻': 'Pernikahan', '亲子': 'Orang Tua & Anak', '动画': 'Animasi',
    '真人': 'Live Action', '纪录': 'Dokumenter', '音乐': 'Musik', '运动': 'Olahraga',
};

export function localizeStatus(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    for (const [re, out] of STATUS) {
        if (re.test(v)) return v.replace(re, out);
    }
    return v;
}

export function localizeArea(s) {
    const v = String(s || '').trim();
    // Upstream records occasionally put the year in vod_area (measured: 1 of 20
    // on dytt page 1), which renders as "2026 • 2026" on the card. Drop it
    // rather than showing a year where a country belongs.
    if (/^(19|20)\d{2}$/.test(v)) return '';
    return AREA[v] || v;
}

/**
 * Tidy a machine-translated title for display.
 *
 * gtx returns raw MT output: inconsistent capitalisation ("jeruk manis" next to
 * "Bunga persik…") and trailing sentence punctuation carried over from the
 * Chinese ("Sang Tiran telah dimanjakan lagi."). Neither is wrong translation,
 * but a grid of mixed-case titles reads as sloppy, so normalise to sentence
 * case and strip terminal punctuation. Words already containing an interior
 * capital (proper nouns, "NXRStream") are left alone.
 */
export function tidyTitle(s) {
    let v = String(s || '').trim();
    if (!v) return v;
    v = v.replace(/[。．.、,，;；]+$/u, '').trim();
    // Uppercase the first letter only when the first word is entirely lowercase,
    // so acronyms and mixed-case proper nouns survive untouched.
    const first = v.split(/\s+/)[0] || '';
    if (first === first.toLowerCase()) {
        v = v.charAt(0).toUpperCase() + v.slice(1);
    }
    return v;
}

export function localizeGenre(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    return v.split(/[,，/、]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => GENRE[x] || x)
        .join(' · ');
}

/** "第01集" -> "Eps 01", "全集" -> "Full", otherwise left alone. */
export function localizeEpLabel(s, index) {
    const v = String(s || '').trim();
    if (!v) return 'Eps ' + (index + 1);
    let m = v.match(/^第\s*(\d+)\s*集$/);
    if (m) return 'Eps ' + m[1];
    m = v.match(/^(\d+)$/);
    if (m) return 'Eps ' + m[1];
    if (/^全集(完结)?$/.test(v)) return 'Full';
    if (/^正片$/.test(v)) return 'Full';
    if (/^预告$/.test(v)) return 'Trailer';
    m = v.match(/^EP?\s*(\d+)$/i);
    if (m) return 'Eps ' + m[1];
    return v;
}

// ---- layer 2: batched machine translation for free text ----

const cache = new Map();
const MAX_CACHE = 4000;
const SEP = '\n';

function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) {
    if (cache.size > MAX_CACHE) {
        // Cheap eviction: drop the oldest quarter.
        let n = Math.floor(MAX_CACHE / 4);
        for (const key of cache.keys()) { cache.delete(key); if (--n <= 0) break; }
    }
    cache.set(k, v);
}

function hasCjk(s) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(s || ''));
}

async function gtxBatch(texts) {
    const q = texts.join(SEP);
    const url = 'https://translate.googleapis.com/translate_a/single'
        + '?client=gtx&sl=zh-CN&tl=id&dt=t&q=' + encodeURIComponent(q);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('gtx ' + r.status);
        const data = await r.json();
        // data[0] is an array of [translated, original, ...] segments that must
        // be concatenated before splitting back on the separator.
        const joined = (data[0] || []).map(seg => (seg && seg[0]) || '').join('');
        const parts = joined.split(SEP);
        if (parts.length !== texts.length) throw new Error('segment mismatch');
        return parts.map(p => p.trim());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Translate a list of Chinese strings to Indonesian.
 * Returns an array the same length as the input; on any failure the original
 * string is returned in place so callers never have to handle an error path.
 */
export async function translateBatch(texts) {
    const out = texts.slice();
    const need = [];
    const needIdx = [];

    texts.forEach((t, i) => {
        const s = String(t || '').trim();
        if (!s || !hasCjk(s)) { out[i] = s; return; }
        const hit = cacheGet(s);
        if (hit !== undefined) { out[i] = hit; return; }
        need.push(s);
        needIdx.push(i);
    });

    if (need.length === 0) return out;

    // Chunk so a single URL stays well inside the endpoint's practical limit.
    const CHUNK = 25;
    for (let start = 0; start < need.length; start += CHUNK) {
        const slice = need.slice(start, start + CHUNK);
        try {
            const res = await gtxBatch(slice);
            res.forEach((tr, j) => {
                const orig = slice[j];
                const val = tr || orig;
                cacheSet(orig, val);
                out[needIdx[start + j]] = val;
            });
        } catch {
            // Leave this chunk untranslated rather than failing the request.
            slice.forEach((orig, j) => { out[needIdx[start + j]] = orig; });
        }
    }
    return out;
}
