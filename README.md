# job-fetcher

Personal job-discovery tool. Fetches jobs from LinkedIn/Indeed/Glassdoor via
JSearch (RapidAPI) and — in a later phase — from Naukri via a dedicated
Apify actor, merges them into one pipeline, dedupes, scores against a
personal profile, and stores results locally.

Full architecture and phased build plan: [job-fetcher-plan.md](./job-fetcher-plan.md).

## Setup

1. **Get a RapidAPI key**
   - Sign up (or log in) at [rapidapi.com](https://rapidapi.com).
   - Subscribe to the [JSearch API](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) on the free/basic plan (200 requests/month).
   - Copy your API key from the JSearch "Endpoints" page (the `x-rapidapi-key` value).

2. **Configure environment**
   - `.env` already exists in this project (copied from `.env.example`) — open it and paste your key:
     ```
     RAPIDAPI_KEY=your_actual_key_here
     ```
   - `.env` is gitignored and never committed.

3. **Install dependencies** (already done if you're reading this after setup)
   ```
   npm install
   ```

4. **Tune your search profile**
   - Edit `config/profile.json` with your real role variants, skills, locations, and exclusion keywords.

## Running

This is a backend-first tool: `npm start` runs the API server, which is the
normal way to run it day-to-day (it can optionally fetch on boot — see
[Fetch-on-startup](#fetch-on-startup) below). The one-shot CLI pipeline
(fetch → normalize → dedupe → store → report, printed to the console) still
exists as `npm run fetch` for scripting/cron use or ad-hoc runs outside the
server.

- **API server** (recommended):
  ```
  npm start
  ```
- **One-shot CLI, real run** (calls the JSearch API, uses your `RAPIDAPI_KEY`):
  ```
  npm run fetch
  ```
- **One-shot CLI, mock run** (no API key or network calls needed — loads `src/fixtures/jsearch-sample.json`):
  ```
  npm run mock
  ```

Both CLI variants print a summary (raw / normalized / skipped / duplicate /
already-in-DB / fresh counts and the total row count in the DB), a compact
table of the **fresh** jobs found this run, and (for ≤ 20 fresh jobs) their
full normalized JSON. A Markdown report of just the fresh jobs is also
written to disk (see below).

### What "new" means

Every job fetched gets a stable `id` (a hash of source + source job id) and
is persisted in SQLite. On each run:

1. Any job still marked `new` from the *previous* run is flipped to `seen`
   first — so `new` always means "new since the last run," not "new ever."
2. Jobs are deduped against the rest of the current batch (the same job can
   come back from two different query combos), then against everything
   already in the DB.
3. Jobs not already in the DB are inserted with `status: 'new'`. Jobs that
   re-appear (already in the DB) just get their `lastSeenAt` timestamp
   bumped — nothing else about them changes.

### Where things live

- **Database**: `data/jobs.db` for real runs, `data/jobs-mock.db` for
  `--mock` runs, so mock testing never pollutes real data.
- **Report**: `data/last-run-report.md` (real) / `data/last-run-report-mock.md`
  (mock) — a Markdown table of only the jobs that were fresh (new since the
  last run), with title, company, source, location, posted date, salary,
  and a link.
- `data/` is gitignored — the DB and report files are local-only and never
  committed.

## API server

An Express HTTP API serves the stored jobs (from `data/jobs.db`, the real
database) as JSON. It's a thin read layer over `src/storage.js` plus a
`POST /api/refresh` endpoint that re-runs the same fetch/normalize/dedupe/
store pipeline used by the CLI (`src/pipeline.js`, shared by both), and a
`GET`/`PUT`/`PATCH /api/profile` set of routes for managing
`config/profile.json` without editing the file by hand.

Start it with:

```
npm start
```

By default it listens on port `3000`; override with the `PORT` env var:

```
PORT=4000 npm start
```

On startup it logs the available routes. There's no auth — this is a
localhost personal tool.

### Fetch-on-startup

On boot, after the server starts listening, it checks whether it should kick
off a background pipeline run (same as `POST /api/refresh` without `?mock=1`)
so the data is fresh without having to remember to refresh manually. This is
controlled by two env vars (see `.env.example`):

| Var                        | Default | Meaning                                                                 |
|-----------------------------|---------|--------------------------------------------------------------------------|
| `FETCH_ON_START`            | `true`  | `"false"` disables the startup-fetch check entirely.                     |
| `FETCH_MIN_INTERVAL_HOURS`  | `6`     | Minimum age of the most recent job activity before a startup fetch runs. |

The guard looks at the most recent `lastSeenAt` (falling back to
`fetchedAt`) across every stored job. If the DB is empty, or that timestamp
is older than `FETCH_MIN_INTERVAL_HOURS`, a fetch starts in the background
(it does not block the server or delay `/api/health` from responding) and
uses the same concurrency guard as `POST /api/refresh` — a manual refresh
request that arrives while the startup fetch is still running gets `409`.
Otherwise the startup fetch is skipped and a log line explains why:

```
[server] starting background fetch (last fetch: 2026-07-10T08:00:00.000Z, 7.2h ago)
```

or

```
[server] skipping startup fetch (last fetch 0.3h ago, min interval 6h)
```

### `GET /api/health`

Basic liveness check plus a row count.

```
curl http://localhost:3000/api/health
```

```json
{ "ok": true, "totalJobs": 59, "dbPath": "D:\\...\\data\\jobs.db" }
```

### `GET /api/jobs`

List jobs with optional filtering, text search, and pagination. Results are
ordered newest-first (`fetchedAt` DESC, then `postedDate` DESC).

Query params (all optional):

| Param    | Type   | Notes                                                       |
|----------|--------|--------------------------------------------------------------|
| `status`       | string | One of `new`, `seen`, `applied`, `rejected` (exact match)    |
| `source`       | string | Exact match, e.g. `linkedin`, `indeed`                       |
| `q`            | string | Case-insensitive substring match against title OR company    |
| `postedWithin` | string | Only jobs posted in this window — see below                  |
| `limit`        | number | Default 50, capped at 200                                    |
| `offset`       | number | Default 0                                                     |

`postedWithin` filters on `postedDate` (when the job was actually posted, per
the source — not when we fetched it). Jobs where the source never reported a
`postedDate` are excluded when this filter is used, since there's no way to
know if they qualify. Accepts:

- `<number><unit>` for any granularity: `m` minutes, `h` hours, `d` days, `w` weeks
  — e.g. `5m` (last 5 minutes), `2h`, `24h`, `7d`, `4w`
- friendly aliases: `today` (= `24h`), `week` (= `7d`), `month` (= `30d`)

```
curl "http://localhost:3000/api/jobs?status=new&q=react&limit=5"
curl "http://localhost:3000/api/jobs?postedWithin=24h"
curl "http://localhost:3000/api/jobs?postedWithin=week"
curl "http://localhost:3000/api/jobs?postedWithin=5m"
```

```json
{
  "total": 3,
  "count": 3,
  "limit": 5,
  "offset": 0,
  "postedWithin": { "raw": "24h", "sinceISO": "2026-07-10T12:00:00.000Z" },
  "jobs": [
    { "id": "…", "source": "linkedin", "title": "React Developer", "company": "…", "status": "new", "...": "..." }
  ]
}
```

`postedWithin` is only included in the response when the query param was used.

An invalid `status`, `postedWithin`, or a non-numeric `limit`/`offset`, returns `400`:

```json
{ "error": "Invalid status \"bogus\". Must be one of: new, seen, applied, rejected" }
```

### `GET /api/jobs/:id`

Fetch a single job by its id.

```
curl http://localhost:3000/api/jobs/5950e8d39981f4735fe0237e0084e3c644f27a55caa6151e0592fd6150aa5cc7
```

```json
{ "id": "5950e8d3...", "source": "instahyre", "title": "Front-End Developer", "...": "..." }
```

Unknown id returns `404`: `{ "error": "not found" }`.

### `GET /api/sources`

Distinct sources currently in the DB with their job counts, most first.

```
curl http://localhost:3000/api/sources
```

```json
[
  { "source": "indeed", "count": 13 },
  { "source": "linkedin", "count": 3 }
]
```

### `GET /api/profile`

Returns the parsed contents of `config/profile.json`.

```
curl http://localhost:3000/api/profile
```

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

### `PUT /api/profile`

Full replace — the request body must be a complete profile object (every
field below required) and completely overwrites `config/profile.json`.

| Field               | Type                     |
|---------------------|--------------------------|
| `roleVariants`      | array of non-empty strings |
| `mustHaveSkills`    | array of non-empty strings |
| `niceToHaveSkills`  | array of non-empty strings |
| `locations`         | array of non-empty strings |
| `excludeKeywords`   | array of non-empty strings |
| `experienceYears`   | number >= 0              |
| `minScore`          | number 0–100             |

Unknown top-level keys are rejected.

```
curl -X PUT http://localhost:3000/api/profile \
  -H "Content-Type: application/json" \
  -d '{
    "roleVariants": ["Frontend Developer", "React Developer"],
    "mustHaveSkills": ["React", "JavaScript"],
    "niceToHaveSkills": ["TypeScript"],
    "experienceYears": 5,
    "locations": ["Delhi NCR", "Remote"],
    "excludeKeywords": ["Intern"],
    "minScore": 50
  }'
```

Returns `200` with the saved profile on success. Any validation failure
returns `400` naming the specific bad field, e.g.:

```json
{ "error": "\"roleVariants\" must be an array of non-empty strings" }
```

```json
{ "error": "unknown field \"foo\" is not allowed" }
```

### `PATCH /api/profile`

Partial update — only send the fields you want to change; each present
field is validated with the same rules as `PUT`, then merged into the
existing profile and saved.

```
curl -X PATCH http://localhost:3000/api/profile \
  -H "Content-Type: application/json" \
  -d '{ "minScore": 60 }'
```

Returns `200` with the full (merged) saved profile.

Because `src/pipeline.js` reads `config/profile.json` fresh on every run,
changes made via `PUT`/`PATCH` take effect on the very next fetch (CLI or
`POST /api/refresh`) — no server restart required.

### `POST /api/refresh`

Runs the full pipeline (same as `npm run fetch` / `npm run mock`) and returns the
run summary as JSON. Add `?mock=1` to use the local fixture instead of
calling the live JSearch API (writes to `data/jobs-mock.db`, same as
`npm run mock`) — use this for testing so you don't burn API quota.

```
curl -X POST "http://localhost:3000/api/refresh?mock=1"
```

```json
{
  "stats": {
    "rawCount": 5,
    "normalizedCount": 5,
    "skipped": 0,
    "duplicatesInBatch": 0,
    "alreadyInDb": 5,
    "freshInserted": 0,
    "totalInDb": 5
  },
  "fresh": [],
  "reportPath": "D:\\...\\data\\last-run-report-mock.md",
  "dbPath": "D:\\...\\data\\jobs-mock.db"
}
```

If a refresh is already running, a second call returns `409`:
`{ "error": "refresh already in progress" }`.

## Current status

- **Phase 0 — done**: JSearch fetcher → normalize → console output.
- **Phase 1 — done**: SQLite storage + dedupe + "new since last run" diffing.
- **API server — done**: Express API (`src/server.js`) serving stored jobs, see above.
- **Phase 2 — pending**: Apify Naukri fetcher merged into the same pipeline.
- **Phase 3 — pending**: Tune scoring/filtering against real results.
- **Phase 4 — pending**: Output polish (Telegram bot or HTML report).

See the [plan's progress log](./job-fetcher-plan.md#progress-log) for details.
