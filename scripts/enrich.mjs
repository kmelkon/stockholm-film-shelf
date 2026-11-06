// Enrich data/films.json with TMDb: rating, poster, overview, trailer.
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
const isSeries = (f) => f.genre.some((g) => /tv-serie/i.test(g));

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
  outer: for (const kind of kinds) {
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

  const d = await tmdb(`/${kind}/${best.r.id}`, { language: 'sv-SE', append_to_response: 'videos', include_video_language: 'sv,en,null' });
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
    poster: d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : null,
    overview: overview || null,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
  };
}

// --- run --------------------------------------------------------------------
const LIMIT = parseInt(process.env.LIMIT || '0', 10); // dev: only process N uncached titles
const stale = (e) => !e || (!(e.matched && e.score >= MATCH_THRESHOLD) && (e.v ?? 1) < MATCHER_VERSION);
let todo = data.films.filter((f) => stale(cache[f.key]));
if (LIMIT) todo = todo.sort(() => Math.random() - 0.5).slice(0, LIMIT);
console.log(`${data.films.length} films, ${todo.length} uncached`);
let done = 0, failed = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const f = queue.shift();
    try { cache[f.key] = { ...(await match(f)), v: MATCHER_VERSION }; }
    catch (e) { failed++; console.warn(`${f.key} ${f.title}: ${e.message}`); }
    if (++done % 250 === 0) {
      console.log(`${done}/${todo.length}`);
      await writeFile(cacheUrl, JSON.stringify(cache));
    }
  }
}));
await writeFile(cacheUrl, JSON.stringify(cache));

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
  + ` | trailers ${m.filter((f) => f.tmdb.trailer).length} | failed ${failed}`);
