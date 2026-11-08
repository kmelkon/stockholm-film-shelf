// Snapshot Stockholm library film catalog (DVD/Blu-ray/VHS) + per-branch availability.
// Usage: node scripts/fetch.mjs  -> writes data/films.json
//
// API quirks (unofficial, reverse-engineered 2026-11):
// - no offset paging; `rows` capped ~900 per request
// - targetGroup/yearPublished silently ignored; yearPublishedSpan works
// - so: bisect year ranges until each slice < cap, then branch slices for year-less titles; union by key
// - large rows + holdings occasionally 502 -> smaller slices + retry
import { writeFile, mkdir } from 'node:fs/promises';

// The API returns actors as an array for most records, but ~12% as one free-text string:
// "James Stewart, John Dall m.fl. ; foto: Joseph Valentine". Normalise to a list of names.
function actorList(a) {
  if (Array.isArray(a)) return a;
  if (!a) return [];
  return a.split(';')[0] // crew credits ("foto: …", "musik: …") follow the first semicolon
    .replace(/\s*(m\.\s?fl\.?|med flera)\s*$/i, '')
    .split(',').map((n) => n.trim()).filter(Boolean);
}

// The library's own word that a box is TV: "Originalfilmen (TV-serie): SVT, 1997" in notes
// (spelling varies: "Originalfilmerna: (TV-serie)", "Originalfilmen TV-serie:"), or the title/subtitle says so.
// "Bygger på en TV-serie" (a film based on a show) must not count.
const isSeries = (m) => (m.notes ?? []).some((n) => /originalfilm\w*[\s:(]*tv-serie/i.test(n))
  || /\btv-serien\b/i.test(m.title ?? '') || /\bmini-?series?\b/i.test(m.subTitle ?? '');

const EP = 'https://biblioteket.stockholm.se/graphql';
const CAP = 500; // target slice size
const HARD_CAP = 900; // API max rows
const DELAY_MS = 800;

const MEDIA_FIELDS = `key title originalTitle variantTitle subTitle mediaSubTypeDisplay image language languages
  targetGroup publisher publishedDate genre ean actors notes
  holdings { branch { name } nofTotal nofTotalAvailableForLoan reservable }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function search(filters, rows, withMedia) {
  const query = `query s($f: SearchWithFilterInput!) { searchWithFilter(filterQuery: $f) {
    totalHits
    availableFilterGroups { name filters { name count } }
    groupedMedia { mediaTypeEnum ${withMedia ? `mediaList { ${MEDIA_FIELDS} }` : ''} }
  } }`;
  let res;
  for (let attempt = 0; ; attempt++) {
    await sleep(DELAY_MS * (attempt ? 2 ** attempt * 3 : 1));
    requests++;
    res = await fetch(EP, {
      method: 'POST',
      // identify ourselves so the library's admins can find us instead of just blocking
      headers: { 'content-type': 'application/json', 'user-agent': 'Filmhyllan/1.0 (+https://github.com/kmelkon/stockholm-film-shelf)' },
      body: JSON.stringify({ query, variables: { f: { query: '', rows, mediaType: ['MOVIE'], ...filters } } }),
    });
    if (res.ok) break;
    if (attempt >= 3) throw new Error(`HTTP ${res.status} ${JSON.stringify(filters)}`);
    console.warn(`  HTTP ${res.status}, retry ${attempt + 1}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`${json.errors[0].message} ${JSON.stringify(filters)}`);
  const d = json.data.searchWithFilter;
  const movies = d.groupedMedia.find((g) => g.mediaTypeEnum === 'MOVIE');
  return { total: d.totalHits, groups: d.availableFilterGroups ?? [], list: movies?.mediaList ?? [] };
}

const byKey = new Map();
const truncated = [];

async function grab(filters, label) {
  const probe = await search(filters, 1, false);
  if (probe.total === 0) return probe;
  const { list } = await search(filters, Math.min(probe.total, HARD_CAP), true); // single-year slices may exceed CAP
  for (const m of list) byKey.set(m.key, m);
  if (probe.total > HARD_CAP) truncated.push({ filters, total: probe.total });
  console.log(`${label} -> ${list.length}/${probe.total}  unique=${byKey.size}`);
  return probe;
}

// Phase A: bisect year ranges until each slice <= CAP (yearPublishedSpan = ["from","to"] strings)
async function years(from, to) {
  const filters = { yearPublishedSpan: [String(from), String(to)] };
  const probe = await search(filters, 1, false);
  if (probe.total === 0) return;
  if (probe.total <= CAP || from === to) return grab(filters, `years ${from}-${to}`);
  const mid = Math.floor((from + to) / 2);
  await years(from, mid);
  await years(mid + 1, to);
}

// Phase B: branch slices catch titles without a year (skip branches over HARD_CAP)
async function branches() {
  const { groups } = await search({}, 1, false);
  const facet = groups.find((g) => g.name === 'Bibliotek')?.filters ?? [];
  for (const f of facet.filter((f) => f.count > 0)) {
    if (f.count > HARD_CAP) { console.log(`skip branch ${f.name} (${f.count})`); continue; }
    await grab({ branch: [f.name] }, `branch ${f.name}`);
  }
}

const { total } = await search({}, 1, false);
const thisYear = new Date().getFullYear();
await years(1890, thisYear + 1);
const afterYears = byKey.size;
await branches();
console.log(`after years=${afterYears}, after branches=${byKey.size}`);

const films = [...byKey.values()].map((m) => {
  const holdings = (m.holdings ?? []).map((h) => ({
    branch: h.branch?.name,
    total: h.nofTotal,
    available: h.nofTotalAvailableForLoan,
    reservable: h.reservable,
  }));
  return {
    key: m.key,
    title: m.title,
    originalTitle: m.originalTitle,
    variantTitle: m.variantTitle,
    subTitle: m.subTitle,
    format: m.mediaSubTypeDisplay,
    year: m.publishedDate,
    languages: m.languages ?? (m.language ? [m.language] : []),
    audience: m.targetGroup,
    genre: m.genre ?? [],
    ean: m.ean ?? [],
    actors: actorList(m.actors),
    series: isSeries(m),
    // only path-relative images: a value like "@evil.com/x" must not change the host
    cover: /^\/[^/]/.test(m.image ?? '') ? `https://biblioteket.stockholm.se${m.image}` : null,
    url: `https://biblioteket.stockholm.se/titel/${m.key}`,
    holdings,
    copies: holdings.reduce((s, h) => s + (h.total ?? 0), 0),
    availableNow: holdings.reduce((s, h) => s + (h.available ?? 0), 0),
  };
});

// Health check: fail loudly (non-zero exit -> failed CI run -> GitHub email) instead of
// deploying a gutted catalog if the unofficial API changes shape or starts blocking us.
const MIN_TOTAL = 3000;    // ~7,100 films in 2026-11
const MIN_COVERAGE = 0.9;  // normally ~98%
const coverage = total ? films.length / total : 0;
if (total < MIN_TOTAL || coverage < MIN_COVERAGE) {
  console.error(`HEALTH CHECK FAILED: ${films.length}/${total} films (${(coverage * 100).toFixed(1)}%), `
    + `need total >= ${MIN_TOTAL} and coverage >= ${MIN_COVERAGE * 100}%. Not writing data.`);
  process.exit(1);
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/films.json', import.meta.url),
  JSON.stringify({ fetchedAt: new Date().toISOString(), totalHits: total, films }),
);
console.log(`\nwrote ${films.length}/${total} films (${((100 * films.length) / total).toFixed(1)}%) in ${requests} requests`);
if (truncated.length) console.log('truncated slices:', truncated);
