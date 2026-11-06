# Filmhyllan (spike)

Netflix-style shelf over Stockholms stadsbibliotek's DVD/Blu-ray catalog. Feasibility spike.

```bash
node scripts/fetch.mjs                                  # catalog -> data/films.json (~3 min, ~175 requests)
node --env-file=.env scripts/enrich.mjs                 # + TMDb rating/poster/trailer (cached in data/tmdb-cache.json)
npx serve .                                             # open http://localhost:3000
```

`.env` needs `TMDB_API_KEY=...`. CI: `.github/workflows/nightly.yml` rebuilds and deploys to GitHub Pages at 02:30 UTC (needs repo secret `TMDB_API_KEY`).

## API notes (unofficial, reverse-engineered 2026-11)

- `POST https://biblioteket.stockholm.se/graphql`, no auth, no CORS (browser can't call directly)
- Introspection off, but error messages suggest field names
- `searchWithFilter(filterQuery: { query, rows, mediaType: ["MOVIE"], branch, language, genre, subject, yearPublishedSpan: ["2005","2005"] })`
- No offset paging (`start` ignored); `rows` max ~900; `targetGroup` ignored
- `media(key: ID!)` for detail; `holdings { branch { name } nofTotal nofTotalAvailableForLoan nofTotalOrdered reservable }`
- Media fields: `key title originalTitle mediaSubTypeDisplay image languages targetGroup publisher publishedDate genre ean actors subjects classifications`
- Title page: `https://biblioteket.stockholm.se/titel/{key}`; cover: `/cdn/static/cover/t/{key}`
