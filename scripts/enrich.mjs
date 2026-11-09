// Enrich data/films.json with TMDb: rating, poster, overview, trailer, age limit, director + cast.
// Usage: TMDB_API_KEY=... node scripts/enrich.mjs
// Cache: data/tmdb-cache.json (keyed by library key) so nightly runs only query new titles.
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_API_KEY;
if (!KEY) throw new Error('TMDB_API_KEY missing');
const API = 'https://api.themoviedb.org/3';
const CONCURRENCY = 8;
// Bump when matching improves: cached *misses* from older versions get retried (hits are kept).
const MATCHER_VERSION = 2;
const MATCH_THRESHOLD = 0.75; // below this, spot checks were mostly wrong

const dataUrl = new URL('../data/films.json', import.meta.url);
const cacheUrl = new URL('../data/tmdb-cache.json', import.meta.url);
const data = JSON.parse(await readFile(dataUrl, 'utf8'));
let cache = {};
try { cache = JSON.parse(await readFile(cacheUrl, 'utf8')); } catch {}

async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ api_key: KEY, ...params });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}?${qs}`);
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`TMDb ${res.status} ${path}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 404) return null;
    throw new Error(`TMDb ${res.status} ${path}`);
  }
}

// --- matching ---------------------------------------------------------------
const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/\b(the|a|an|en|ett|den|det)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Library titles often carry subtitles/edition noise: "Dune : part two", "X (Blu-ray)"
const cleanTitle = (t) => (t || '')
  .replace(/["“”«»]/g, '')
  .replace(/\[.*?\]|\(.*?\)/g, ' ')
  .replace(/\b(blu-?ray|dvd|4k|uhd|collector'?s edition|special edition)\b/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) || 0);
  return (2 * inter) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1));
}

const dvdYear = (f) => parseInt(String(f.year || '').match(/\d{4}/)?.[0] || '0', 10) || null;
const isSeries = (f) => f.series || f.genre.some((g) => /tv-serie/i.test(g));

// Manual fixes for bad matches. library key -> TMDb movie id, { tv: id }, or null = no match.
// Films paired with an unrelated series ("Alien 3" -> "Alien Nine", "Paris" -> a 1994 sitcom),
// concerts/operas paired with series, and series paired with the wrong show.
// A cached entry that disagrees is redone on the next run.
const OVERRIDES = {
  8404172: 8077, // Alien 3
  8095038: 82283, // "It" (1927 comedy)
  8531546: 3019, // Dr. Jekyll and Mr. Hyde 1932 & 1941 (box holds both; 1931 film)
  8331891: 11190, // Vozvrasjtjenije (The Return)
  8095035: 513, // Fire (Deepa Mehta)
  8136431: 8355, // Ice Age 3
  8224313: 12430, // Vegas (Amir Naderi)
  8369901: 8279, // Paris (Klapisch)
  8059354: 78182, // Jelena (Elena, Zvyagintsev)
  8102880: 309373, // Super troupers (ABBA)
  8059643: null, // 40
  8246354: null, // Slas klassiska filmer
  8287451: null, // Mar
  8149327: null, // Raz
  8354660: null, // Utubus-i shab (The Night Bus)
  8346003: null, // Evolve
  8127030: null, // Zoombie
  8330354: null, // Xerxes (opera, London Coliseum)
  8146773: null, // Xerxes (opera, Semperoper Dresden)
  8325814: null, // Dixieland jazz Vol. 1 (concert compilation)
  8338758: null, // America (concert film)
  8326763: null, // Bold as brass (Cliff Richard concert)
  8067940: { tv: 3714 }, // Pippi Langstrump 1969 (not the 1997 cartoon)
  8061503: { tv: 3714 },
  8068487: { tv: 3714 },
  8162223: { tv: 3714 },
  8100525: { tv: 152643 }, // Partaj (SVT 1969)
  8320932: { tv: 15571 }, // Holocaust (1978)
  8358600: { tv: 218433 }, // The Vietnam war (CBS, Walter Cronkite)
};
const hasOverride = (f) => Object.hasOwn(OVERRIDES, f.key);
const overrideOf = (f) => { const o = OVERRIDES[f.key]; return o === null ? null : typeof o === 'number' ? { kind: 'movie', id: o } : { kind: 'tv', id: o.tv }; };
const overrideOk = (f, e) => {
  if (!hasOverride(f)) return true;
  const o = overrideOf(f);
  return o === null ? e?.matched === false : e?.kind === o.kind && e?.id === o.id;
};

// Series volumes: "Miffy 1", "Hedebyborna D. 3.", "Fellini 1."
const stripVolume = (t) => t.replace(/[\s,]*(d\.|del|vol\.?|volume|säsong|season)?\s*\d+\.?$/i, '').trim();

// All titles the library knows for a record. subTitle often holds the Swedish/English
// title of foreign films ("Hauru no ugoku shiro" -> "Det levande slottet"), sometimes
// several separated by " = "; variantTitle often holds the native script (君たちはどう生きるか).
// Returns [{ q, strong }]: strong = main titles (fuzzy match ok); weak = subtitle-derived
// (subtitles also hold junk like "in concert", "October 1966"), which must match near-exactly.
function candidates(f) {
  const out = [];
  for (const t of [f.originalTitle, f.title, f.variantTitle].filter(Boolean)) {
    const clean = cleanTitle(t);
    out.push({ q: clean, strong: true }, { q: clean.split(/\s[:\-–]\s/)[0], strong: true });
    // "Miffy 1" -> "Miffy" only makes sense for TV boxes; for films it turns "Alien 3" into "Alien"
    if (stripVolume(clean) !== clean) out.push({ q: stripVolume(clean), strong: true, tvOnly: true });
  }
  for (const part of (f.subTitle || '').split(/\s=\s/).filter((p) => p && !GENERIC_SUB.test(cleanTitle(p)))) {
    out.push({ q: cleanTitle(part), strong: false }, { q: cleanTitle(`${f.title} ${part}`), strong: false });
  }
  const seen = new Set();
  return out.filter((c) => c.q && c.q.length > 1 && !seen.has(c.q) && seen.add(c.q));
}
const WEAK_MIN = 0.9;
const GENERIC_SUB = /^(in concert|live|live at .*|concert|the movie|the film|collection|.*\bedition|bonus.*|extras?|dvd|\d{4})$/i;

function score(f, r, kind) {
  const titles = kind === 'tv' ? [r.name, r.original_name] : [r.title, r.original_title];
  let s = 0;
  for (const { q, strong, tvOnly } of candidates(f)) for (const t of titles) {
    if (tvOnly && kind !== 'tv') continue;
    const sim = similarity(q, t);
    if (strong || sim >= WEAK_MIN) s = Math.max(s, sim);
  }
  // native-script titles normalize to nothing above; compare raw
  if (f.variantTitle && titles.some((t) => t && t.trim().toLowerCase() === f.variantTitle.trim().toLowerCase())) s = Math.max(s, 1);
  if (s === 1) s += 0.2; // exact title beats near-miss sequels ("Basic instinct" vs "Basic Instinct 2")
  const released = parseInt((kind === 'tv' ? r.first_air_date : r.release_date)?.slice(0, 4) || '0', 10);
  const dy = dvdYear(f);
  if (dy && released) {
    if (released > dy + 1) return -1; // film can't be released after its own disc
    if (dy - released <= 2) s += 0.1; // typical DVD lag
    else if (dy - released > 30) s -= 0.1;
  }
  s += Math.min(r.vote_count || 0, 1000) / 20000; // tie-break toward known titles
  return s;
}

async function match(f) {
  const tries = candidates(f).map((c) => c.q).slice(0, 8); // cap API calls per title
  // likely kind first; fall back to the other (library genre tags miss many TV boxes)
  const kinds = isSeries(f) || /\d+\.?$/.test(f.title) ? ['tv', 'movie'] : ['movie', 'tv'];
  let best = null;
  if (hasOverride(f)) {
    if (OVERRIDES[f.key] === null) return { matched: false, bestScore: 0, manual: true };
    const o = overrideOf(f);
    best = { s: 1.2, r: { id: o.id }, kind: o.kind };
  }
  if (!best) outer: for (const kind of kinds) {
    for (const query of tries) {
      for (const lang of ['sv-SE', 'en-US']) {
        const res = await tmdb(`/search/${kind}`, { query, language: lang, include_adult: 'false' });
        for (const r of res?.results?.slice(0, 8) ?? []) {
          const s = score(f, r, kind);
          if (!best || s > best.s) best = { s, r, kind };
        }
        if (best?.s >= 1) break outer;
      }
    }
    if (best?.s >= MATCH_THRESHOLD) break;
  }
  if (!best || best.s < MATCH_THRESHOLD) return { matched: false, bestScore: best?.s ?? 0 };
  const kind = best.kind;

  const d = await tmdb(`/${kind}/${best.r.id}`, { language: 'sv-SE', append_to_response: `videos,${AGE_APPEND[kind]},credits`, include_video_language: 'sv,en,null' });
  const vids = d?.videos?.results ?? [];
  const trailer = vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.iso_639_1 === 'sv')
    ?? vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    ?? vids.find((v) => v.site === 'YouTube' && v.type === 'Teaser');
  let overview = d?.overview;
  if (!overview) overview = (await tmdb(`/${kind}/${best.r.id}`, { language: 'en-US' }))?.overview;
  return {
    matched: true,
    kind,
    score: Math.round(best.s * 100) / 100,
    id: best.r.id,
    tmdbTitle: kind === 'tv' ? d.name : d.title,
    released: (kind === 'tv' ? d.first_air_date : d.release_date) || null,
    rating: d.vote_average || null,
    votes: d.vote_count || 0,
    runtime: d.runtime || d.episode_run_time?.[0] || null,
    genres: (d.genres ?? []).map((g) => g.name),
    poster: /^\/[^/]/.test(d.poster_path ?? '') ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : null, // path only, never a host
    overview: overview || null,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    ...pickAge(kind, d),
    people: pickPeople(d),
  };
}

// --- people (I7): director(s) + top-billed cast as [tmdbPersonId, name]; TV creators stand in for directors ---
const CAST_MAX = 5;
const person = (p) => [p.id, p.name];
function pickPeople(d) {
  const crew = d?.credits?.crew ?? [], cast = d?.credits?.cast ?? [];
  const dir = d?.created_by?.length ? d.created_by : crew.filter((c) => c.job === 'Director');
  return {
    dir: [...new Map(dir.map((p) => [p.id, p])).values()].slice(0, 3).map(person),
    cast: cast.slice().sort((a, b) => a.order - b.order).slice(0, CAST_MAX).map(person),
  };
}

// --- age limit (åldersgräns) ------------------------------------------------------
// Swedish buckets: 0 = barntillåten, 7, 11, 15. Sweden first, then Nordic neighbours, then US/UK.
const AGE_ORDER = ['SE', 'DK', 'NO', 'FI', 'US', 'GB'];
const AGE_CODES = { // letter codes -> age; numeric codes ("7", "K12", "FSK 16") are parsed below
  SE: { BTL: 0 }, DK: { A: 0 }, NO: { A: 0 }, FI: { S: 0 },
  US: { G: 0, 'TV-Y': 0, 'TV-G': 0, PG: 7, 'TV-Y7': 7, 'TV-PG': 7, 'PG-13': 11, 'TV-14': 15, R: 15, 'NC-17': 15, 'TV-MA': 15 },
  GB: { U: 0, PG: 7 },
};
// another country's age -> the Swedish bucket that still allows it ("NO 9" isn't OK for a 7-year-old -> 11)
const bucket = (n) => (n === 0 ? 0 : n <= 7 ? 7 : n <= 11 ? 11 : 15);
function ageOf(country, cert) {
  const c = String(cert || '').trim().toUpperCase();
  if (!c) return null;
  if (c in (AGE_CODES[country] ?? {})) return AGE_CODES[country][c];
  const n = c.match(/\d+/)?.[0];
  return n == null ? null : bucket(parseInt(n, 10));
}
// movie: release_dates.results[{iso_3166_1, release_dates[{certification}]}]; tv: content_ratings.results[{iso_3166_1, rating}]
function pickAge(kind, d) {
  const by = new Map();
  if (kind === 'movie') for (const r of d?.release_dates?.results ?? []) by.set(r.iso_3166_1, r.release_dates.map((x) => x.certification));
  else for (const r of d?.content_ratings?.results ?? []) by.set(r.iso_3166_1, [r.rating]);
  for (const country of AGE_ORDER) for (const cert of by.get(country) ?? []) {
    const age = ageOf(country, cert);
    if (age != null) return { age, ageFrom: country };
  }
  return { age: null, ageFrom: null };
}
const AGE_APPEND = { movie: 'release_dates', tv: 'content_ratings' };

// --- run --------------------------------------------------------------------
const LIMIT = parseInt(process.env.LIMIT || '0', 10); // dev: only process N uncached titles
const stale = (e) => !e || (!(e.matched && e.score >= MATCH_THRESHOLD) && (e.v ?? 1) < MATCHER_VERSION);
// library says TV but we matched a film: retry once with TV searched first (seriesChecked stops nightly repeats)
const recheck = (f, e) => f.series && e?.kind === 'movie' && !e.seriesChecked && !hasOverride(f);
let todo = data.films.filter((f) => stale(cache[f.key]) || !overrideOk(f, cache[f.key]) || recheck(f, cache[f.key]));
if (LIMIT) todo = todo.sort(() => Math.random() - 0.5).slice(0, LIMIT);
console.log(`${data.films.length} films, ${todo.length} uncached`);
let done = 0, failed = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const f = queue.shift();
    try { cache[f.key] = { ...(await match(f)), v: MATCHER_VERSION, ...(f.series && { seriesChecked: true }) }; }
    catch (e) { failed++; console.warn(`${f.key} ${f.title}: ${e.message}`); }
    if (++done % 250 === 0) {
      console.log(`${done}/${todo.length}`);
      await writeFile(cacheUrl, JSON.stringify(cache));
    }
  }
}));
await writeFile(cacheUrl, JSON.stringify(cache));

// Backfill age limits for hits cached before ages existed (one cheap call each, once).
const noAge = data.films.map((f) => cache[f.key]).filter((e) => e?.matched && !('age' in e));
const ageQueue = [...new Set(noAge)];
let ageFailed = 0;
if (ageQueue.length) console.log(`backfilling age limits for ${ageQueue.length} matches`);
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (ageQueue.length) {
    const e = ageQueue.shift();
    try { const path = AGE_APPEND[e.kind]; // standalone endpoint returns { results }; wrap like append_to_response
      Object.assign(e, pickAge(e.kind, { [path]: await tmdb(`/${e.kind}/${e.id}/${path}`) })); }
    catch (err) { ageFailed++; } // retried next run: 'age' stays unset
  }
}));
if (noAge.length) await writeFile(cacheUrl, JSON.stringify(cache));

// Backfill people for hits cached before credits existed: one call per unique TMDb title, once.
const noPeople = new Map();
for (const f of data.films) {
  const e = cache[f.key];
  if (e?.matched && !e.people) (noPeople.get(`${e.kind}:${e.id}`) ?? noPeople.set(`${e.kind}:${e.id}`, []).get(`${e.kind}:${e.id}`)).push(e);
}
const peopleQueue = [...noPeople.values()];
let peopleFailed = 0;
if (peopleQueue.length) console.log(`backfilling people for ${peopleQueue.length} titles`);
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (peopleQueue.length) {
    const es = peopleQueue.shift(), { kind, id } = es[0];
    try { // TV creators only come with the show itself; films need just the credits
      const d = kind === 'tv' ? await tmdb(`/tv/${id}`, { append_to_response: 'credits' }) : { credits: await tmdb(`/movie/${id}/credits`) };
      const people = pickPeople(d);
      for (const e of es) e.people = people;
    } catch { peopleFailed++; } // retried next run: 'people' stays unset
  }
}));
if (noPeople.size) await writeFile(cacheUrl, JSON.stringify(cache));

// Health check: many request failures usually means a bad/revoked key or TMDb outage.
const MAX_FAIL_RATE = 0.05;
if (todo.length && failed / todo.length > MAX_FAIL_RATE) {
  console.error(`HEALTH CHECK FAILED: ${failed}/${todo.length} TMDb lookups failed. Not writing data.`);
  process.exit(1);
}

for (const f of data.films) f.tmdb = cache[f.key]?.matched && cache[f.key].score >= MATCH_THRESHOLD ? cache[f.key] : null;
data.enrichedAt = new Date().toISOString();
await writeFile(dataUrl, JSON.stringify(data));

const m = data.films.filter((f) => f.tmdb);
console.log(`matched ${m.length}/${data.films.length} (${((100 * m.length) / data.films.length).toFixed(1)}%)`
  + ` | trailers ${m.filter((f) => f.tmdb.trailer).length} | ages ${m.filter((f) => f.tmdb.age != null).length}`
  + ` (SE ${m.filter((f) => f.tmdb.ageFrom === 'SE').length}) | failed ${failed} | age failed ${ageFailed}`
  + ` | people ${m.filter((f) => f.tmdb.people).length} | people failed ${peopleFailed}`);
