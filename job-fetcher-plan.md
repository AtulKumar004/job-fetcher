# Job Fetcher — Hybrid Architecture Plan

Personal job-discovery tool. Fetches jobs from LinkedIn/Indeed/Glassdoor via
JSearch (RapidAPI) and from Naukri via a dedicated Apify actor, merges them
into one pipeline, dedupes, scores against a personal profile, and stores
results locally.

## Why hybrid

- JSearch aggregates via Google for Jobs → strong coverage for
  LinkedIn/Indeed/Glassdoor, free tier (200 req/month), single unified API.
- JSearch has weak/inconsistent Naukri coverage (Google for Jobs doesn't
  index Naukri well in India).
- Apify has dedicated Naukri scrapers that hit Naukri's public-facing API
  directly (no login) — better freshness and coverage for that one source.
- Using each tool for what it's actually good at > forcing one tool to do
  everything.

## Folder structure

```
job-fetcher/
  .env                    # API keys (gitignored, never commit)
  .env.example
  config/
    profile.json          # role variants, skills, location, exclude keywords
  src/
    fetchers/
      jsearch.js          # LinkedIn/Indeed/Glassdoor via RapidAPI
      apifyNaukri.js      # Naukri via Apify actor
    normalize.js          # maps both sources to a common Job schema
    dedupe.js             # hash-based unique check
    score.js              # keyword-overlap scoring + exclude filter
    storage.js            # SQLite read/write
    report.js             # builds "new since last run" output
    index.js              # orchestrator — runs the full pipeline
  data/
    jobs.db               # sqlite file (gitignored)
  package.json
  README.md
```

## Normalized job schema

```js
{
  id: string,          // hash of source + source_job_id (dedupe key)
  source: 'linkedin' | 'indeed' | 'glassdoor' | 'naukri',
  title: string,
  company: string,
  location: string,
  description: string,
  url: string,
  postedDate: string | null,
  salary: string | null,
  score: number,        // 0-100, computed by score.js
  status: 'new' | 'seen' | 'applied' | 'rejected',
  fetchedAt: string     // ISO timestamp
}
```

## Module responsibilities

- **fetchers/jsearch.js** — calls JSearch search endpoint per role-variant +
  location combo, handles pagination, returns raw results.
- **fetchers/apifyNaukri.js** — starts the chosen Naukri actor run via the
  official `apify-client` npm package, waits for completion, pulls the
  resulting dataset.
- **normalize.js** — converts both sources' raw shapes into the common Job
  schema above; generates the dedupe hash.
- **dedupe.js** — checks the hash against what's already in SQLite before
  inserting; treats same job appearing on two sources as one record.
- **score.js** — keyword overlap between profile skills and
  title+description, weighted must-have vs nice-to-have; drops anything
  matching an exclude keyword or below a minimum score threshold.
- **storage.js** — thin wrapper over `better-sqlite3` for insert/update/query.
- **report.js** — diffs current run against last run, outputs jobs marked
  `new` as JSON/Markdown.
- **index.js** — loads config → runs both fetchers → normalize → dedupe →
  score → store → report. This is the single entry point.

## Config — `config/profile.json` (example)

```json
{
  "roleVariants": ["Frontend Developer", "Next.js Developer", "React Developer"],
  "mustHaveSkills": ["React", "Next.js", "JavaScript"],
  "niceToHaveSkills": ["TypeScript", "Testing", "Performance", "Accessibility"],
  "experienceYears": 5,
  "locations": ["Delhi NCR", "Remote"],
  "excludeKeywords": ["Intern", "10+ years"],
  "minScore": 50
}
```

## Environment variables — `.env`

```
RAPIDAPI_KEY=your_rapidapi_key_here
APIFY_TOKEN=your_apify_token_here
APIFY_NAUKRI_ACTOR_ID=chosen_actor_id_here
```

## Setup checklist (do these before coding starts)

1. **RapidAPI**: sign up → subscribe to JSearch, free/basic plan → copy key.
2. **Apify**: sign up free account → Console → Integrations → copy API
   token. Pick one Naukri actor from the Apify Store (search "Naukri
   scraper") and note its actor ID — check current per-result pricing on
   the actor page before running, since Apify prices can change.
3. Init the project: `npm init`, install `axios`, `better-sqlite3`,
   `apify-client`, `dotenv` (add `node-cron` later for scheduling).
4. Fill in `config/profile.json` with your real role/skills/location.

## Phased build order

| Phase | Scope |
|---|---|
| 0 | JSearch fetcher only → normalize → console output. Validate the pipeline works end to end for one source. |
| 1 | Add SQLite storage + dedupe + "new since last run" diffing. |
| 2 | Add the Apify Naukri fetcher, merge into the same normalized pipeline. |
| 3 | Tune scoring/filtering against real results. |
| 4 | Output polish — Telegram bot notification or a simple HTML report. |

Build and test Phase 0 fully before adding Naukri — it isolates problems
(is JSearch working right?) from Apify-specific problems (is the actor
returning what I expect?).

## Cost estimate (personal, low volume)

- JSearch: free tier covers ~200 requests/month; a daily run uses well
  under that.
- Apify Naukri actor: pay-per-result, roughly a few hundred jobs/month —
  this lands in cents, not dollars, at personal scale. Apify's free plan
  includes some monthly usage credit; confirm the current amount on
  signup since it can change.

## Progress log

- 2026-07-11 — Phase 0 started.
- 2026-07-11 — Phase 0 validated against the live API: 6 queries, 60 jobs
  fetched and normalized. Endpoint note: the RapidAPI JSearch product now
  serves GET `/search-v2` (the old `/search` returns 404); results are
  nested under `data.jobs` with a `data.cursor` for pagination.
- 2026-07-11 — Phase 1 complete: SQLite storage (better-sqlite3, WAL), batch+DB dedupe, new-since-last-run markdown report. Mock and real runs use separate DB files.
- 2026-07-11 — Added Express API server (src/server.js): GET /api/jobs (filter/search/pagination), GET /api/jobs/:id, GET /api/sources, GET /api/health, POST /api/refresh with concurrency guard. Pipeline extracted to src/pipeline.js for CLI + API reuse.
- 2026-07-11 — Backend-first restructure: npm start now runs the API server (CLI moved to npm run fetch); added GET/PUT/PATCH /api/profile with validation; optional fetch-on-startup with staleness guard (FETCH_ON_START, FETCH_MIN_INTERVAL_HOURS).
- 2026-07-11 — Added postedWithin filter to GET /api/jobs: accepts <n><unit> (m/h/d/w) or aliases today/week/month, filters on postedDate, excludes jobs with unknown postedDate. Composes with status/source/q.
