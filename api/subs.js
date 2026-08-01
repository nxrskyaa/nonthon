// Multi-language subtitle catalog.
// Source: OpenSubtitles v3 (Stremio addon) — CORS *, no API key, 30+ languages incl. Indonesian.
// Verified: 93 subs / 34 langs for tt10872600, 94 subs for GoT S1E1.

const TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const OS = 'https://opensubtitles-v3.strem.io';

// ISO 639-2/B -> human label (Indonesian UI)
const LANGS = {
    ind: 'Indonesia', id: 'Indonesia', may: 'Melayu', msa: 'Melayu',
    eng: 'English', en: 'English',
    spa: 'Español', spl: 'Español (Latino)', glg: 'Galego', cat: 'Català', eus: 'Euskara',
    pob: 'Português (BR)', por: 'Português', fre: 'Français', fra: 'Français',
    ger: 'Deutsch', deu: 'Deutsch', ita: 'Italiano', dut: 'Nederlands', nld: 'Nederlands',
    swe: 'Svenska', dan: 'Dansk', nor: 'Norsk', fin: 'Suomi', ice: 'Íslenska',
    pol: 'Polski', cze: 'Čeština', slo: 'Slovenčina', slv: 'Slovenščina',
    hun: 'Magyar', rum: 'Română', ron: 'Română', bul: 'Български',
    srp: 'Srpski', hrv: 'Hrvatski', bos: 'Bosanski', mac: 'Македонски',
    alb: 'Shqip', sqi: 'Shqip', gre: 'Ελληνικά', ell: 'Ελληνικά',
    tur: 'Türkçe', rus: 'Русский', ukr: 'Українська', bel: 'Беларуская',
    est: 'Eesti', lav: 'Latviešu', lit: 'Lietuvių',
    ara: 'العربية', heb: 'עברית', per: 'فارسی', fas: 'فارسی', urd: 'اردو',
    hin: 'हिन्दी', ben: 'বাংলা', tam: 'தமிழ்', tel: 'తెలుగు',
    mal: 'മലയാളം', kan: 'ಕನ್ನಡ', mar: 'मराठी', nep: 'नेपाली', sin: 'සිංහල',
    tha: 'ไทย', vie: 'Tiếng Việt', khm: 'ខ្មែរ', lao: 'ລາວ', mya: 'မြန်မာ',
    jpn: '日本語', kor: '한국어',
    chi: '中文', zho: '中文', zhe: '中文 (简体)', zht: '中文 (繁體)',
    tgl: 'Tagalog', swa: 'Kiswahili', afr: 'Afrikaans',
    geo: 'ქართული', arm: 'Հայերեն', aze: 'Azərbaycan', kaz: 'Қазақша', mon: 'Монгол',
};

// Sort priority: Indonesian first, then Malay/English, then the rest alphabetically
function rank(code) {
    if (code === 'ind' || code === 'id') return 0;
    if (code === 'may' || code === 'msa') return 1;
    if (code === 'eng' || code === 'en') return 2;
    return 10;
}

export default async function handler(req, res) {
    const { type, id, s, e } = req.query;
    if (!type || !id) return res.status(400).json({ error: 'Missing type or id' });

    try {
        // TMDB id -> IMDb id (OpenSubtitles is keyed on IMDb)
        const extResp = await fetch(
            `https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=${TMDB_KEY}`
        );
        const ext = await extResp.json();
        const imdb = ext.imdb_id;
        if (!imdb) {
            return res.status(200).json({ success: true, subtitles: [], reason: 'no imdb id' });
        }

        const osUrl = type === 'movie'
            ? `${OS}/subtitles/movie/${imdb}.json`
            : `${OS}/subtitles/series/${imdb}:${s || 1}:${e || 1}.json`;

        const osResp = await fetch(osUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const os = await osResp.json();
        const raw = os.subtitles || [];

        // Group by language, keep up to 3 variants each (sync quality varies per upload)
        const byLang = new Map();
        for (const sub of raw) {
            const code = (sub.lang || '').toLowerCase();
            if (!code || !sub.url) continue;
            if (!byLang.has(code)) byLang.set(code, []);
            const list = byLang.get(code);
            if (list.length < 3) list.push(sub.url);
        }

        const subtitles = [];
        for (const [code, urls] of byLang) {
            const label = LANGS[code] || code.toUpperCase();
            urls.forEach((url, i) => {
                subtitles.push({
                    lang: code,
                    label: urls.length > 1 ? `${label} (${i + 1})` : label,
                    url,
                    srt: true, // OpenSubtitles serves SRT; converted to VTT before use
                });
            });
        }

        subtitles.sort((a, b) =>
            rank(a.lang) - rank(b.lang) || a.label.localeCompare(b.label)
        );

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        return res.status(200).json({
            success: true,
            imdb,
            count: subtitles.length,
            languages: byLang.size,
            subtitles,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
