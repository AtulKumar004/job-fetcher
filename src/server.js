import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

import express from "express";

import { runPipeline } from "./pipeline.js";
import {
  openDb,
  queryJobs,
  countJobs,
  getJobById,
  getSourceCounts,
  countAll,
  getLastActivityTimestamp,
  close,
} from "./storage.js";
import { loadProfile, saveProfile, validateProfile } from "./profile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT_DIR, "data", "jobs.db");
const PROFILE_PATH = path.join(ROOT_DIR, "config", "profile.json");

const VALID_STATUSES = new Set(["new", "seen", "applied", "rejected"]);
const PORT = process.env.PORT || 3000;

// Fetch-on-startup staleness guard config (see maybeFetchOnStartup below).
const FETCH_ON_START = String(process.env.FETCH_ON_START ?? "true").toLowerCase() !== "false";
const FETCH_MIN_INTERVAL_HOURS = Number(process.env.FETCH_MIN_INTERVAL_HOURS) || 6;

const app = express();
app.use(express.json());

// Simple concurrency guard for POST /api/refresh (and the fetch-on-startup
// background run below). The pipeline is synchronous better-sqlite3 work
// interleaved with async axios calls, so a boolean flag (rather than a real
// lock/queue) is enough to prevent two refreshes from stepping on each other.
let refreshInProgress = false;

/**
 * Parses a pagination integer param (limit/offset). Returns null if the raw
 * value is present but not a valid non-negative integer.
 */
function parseIntParam(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw))) return null;
  return Number(raw);
}

const MS_PER_UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
// Friendly names for the common buckets, on top of raw <number><unit> so
// finer windows (e.g. "5m" for the last 5 minutes) work too.
const POSTED_WITHIN_ALIASES = { today: "24h", "24h": "24h", week: "7d", month: "30d" };

/**
 * Parses a postedWithin query value ("5m", "24h", "7d", "week", "month", ...)
 * into an ISO cutoff timestamp (now - duration). Returns null if the value
 * doesn't match a supported format.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function parsePostedWithin(raw) {
  const normalized = String(raw).trim().toLowerCase();
  const resolved = POSTED_WITHIN_ALIASES[normalized] ?? normalized;

  const match = /^(\d+)(m|h|d|w)$/.exec(resolved);
  if (!match) return null;

  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  if (amount <= 0) return null;

  const durationMs = amount * MS_PER_UNIT[unit];
  return new Date(Date.now() - durationMs).toISOString();
}

function withDb(handler) {
  return (req, res, next) => {
    let db;
    try {
      db = openDb(DB_PATH);
      handler(req, res, db);
    } catch (err) {
      next(err);
    } finally {
      if (db) close(db);
    }
  };
}

app.get(
  "/api/jobs",
  withDb((req, res, db) => {
    const { status, source, q, postedWithin } = req.query;

    if (status !== undefined && !VALID_STATUSES.has(String(status))) {
      res.status(400).json({
        error: `Invalid status "${status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`,
      });
      return;
    }

    let postedAfter;
    if (postedWithin !== undefined) {
      postedAfter = parsePostedWithin(postedWithin);
      if (postedAfter === null) {
        res.status(400).json({
          error: `Invalid postedWithin "${postedWithin}". Use <number><unit> (m/h/d/w), e.g. "5m", "24h", "7d" — or "today", "week", "month".`,
        });
        return;
      }
    }

    const limit = parseIntParam(req.query.limit, 50);
    if (limit === null) {
      res.status(400).json({ error: "Invalid limit: must be a non-negative integer" });
      return;
    }

    const offset = parseIntParam(req.query.offset, 0);
    if (offset === null) {
      res.status(400).json({ error: "Invalid offset: must be a non-negative integer" });
      return;
    }

    const filters = { status, source, q, postedAfter };
    const jobs = queryJobs(db, { ...filters, limit, offset });
    const total = countJobs(db, filters);

    res.json({
      total,
      count: jobs.length,
      limit: Math.min(limit, 200),
      offset,
      ...(postedWithin !== undefined ? { postedWithin: { raw: postedWithin, sinceISO: postedAfter } } : {}),
      jobs,
    });
  })
);

app.get(
  "/api/jobs/:id",
  withDb((req, res, db) => {
    const job = getJobById(db, req.params.id);
    if (!job) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(job);
  })
);

app.get(
  "/api/sources",
  withDb((req, res, db) => {
    res.json(getSourceCounts(db));
  })
);

app.get(
  "/api/health",
  withDb((req, res, db) => {
    res.json({ ok: true, totalJobs: countAll(db), dbPath: DB_PATH });
  })
);

app.get("/api/profile", async (req, res, next) => {
  try {
    const profile = await loadProfile(PROFILE_PATH);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

app.put("/api/profile", async (req, res, next) => {
  try {
    const body = req.body;
    const error = validateProfile(body, { partial: false });
    if (error) {
      res.status(400).json({ error });
      return;
    }
    await saveProfile(PROFILE_PATH, body);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

app.patch("/api/profile", async (req, res, next) => {
  try {
    const body = req.body;
    const error = validateProfile(body, { partial: true });
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const existing = await loadProfile(PROFILE_PATH);
    const merged = { ...existing, ...body };
    await saveProfile(PROFILE_PATH, merged);
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

app.post("/api/refresh", async (req, res, next) => {
  if (refreshInProgress) {
    res.status(409).json({ error: "refresh already in progress" });
    return;
  }

  const useMock = req.query.mock === "1" || req.query.mock === "true";

  refreshInProgress = true;
  try {
    const summary = await runPipeline({ useMock });
    res.json(summary);
  } catch (err) {
    next(err);
  } finally {
    refreshInProgress = false;
  }
});

// Unknown routes -> JSON 404 (must come after all real routes).
app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// Global error handler -> JSON 500, no stack leak. Malformed JSON bodies
// (thrown by the express.json() middleware before any route handler runs)
// get a 400 instead of a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }
  console.error("[server] error:", err);
  res.status(500).json({ error: "internal server error" });
});

/**
 * Kicks off runPipeline() in the background (fire-and-forget from the
 * caller's perspective) using the same refreshInProgress guard as
 * POST /api/refresh, so a manual refresh request that arrives while the
 * startup fetch is running correctly gets a 409 instead of racing it.
 */
function triggerBackgroundFetch() {
  if (refreshInProgress) {
    console.log("[server] startup fetch skipped: a refresh is already in progress");
    return;
  }

  refreshInProgress = true;
  runPipeline({ useMock: false })
    .then((summary) => {
      console.log(
        `[server] background startup fetch complete: ${summary.stats.freshInserted} new job(s), ${summary.stats.totalInDb} total in DB`
      );
    })
    .catch((err) => {
      console.error("[server] background startup fetch failed:", err.message);
    })
    .finally(() => {
      refreshInProgress = false;
    });
}

/**
 * Fetch-on-startup with a staleness guard. Controlled by env vars:
 *   FETCH_ON_START           - "true"/"false", default "true"
 *   FETCH_MIN_INTERVAL_HOURS - number, default 6
 *
 * If the DB is empty, or the most recent job activity (lastSeenAt, falling
 * back to fetchedAt) is older than the min interval, a background fetch is
 * started via triggerBackgroundFetch(). Otherwise the startup fetch is
 * skipped. Never blocks server startup.
 */
function maybeFetchOnStartup() {
  if (!FETCH_ON_START) {
    console.log("[server] FETCH_ON_START=false, skipping startup fetch check");
    return;
  }

  let lastActivity = null;
  let dbEmpty = true;
  try {
    const db = openDb(DB_PATH);
    try {
      dbEmpty = countAll(db) === 0;
      if (!dbEmpty) {
        lastActivity = getLastActivityTimestamp(db);
      }
    } finally {
      close(db);
    }
  } catch (err) {
    console.error("[server] failed to check DB staleness for startup fetch:", err.message);
    return;
  }

  if (dbEmpty || !lastActivity) {
    console.log("[server] starting background fetch (last fetch: never — DB is empty)");
    triggerBackgroundFetch();
    return;
  }

  const ageHours = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60);

  if (ageHours >= FETCH_MIN_INTERVAL_HOURS) {
    console.log(
      `[server] starting background fetch (last fetch: ${lastActivity}, ${ageHours.toFixed(1)}h ago)`
    );
    triggerBackgroundFetch();
  } else {
    console.log(
      `[server] skipping startup fetch (last fetch ${ageHours.toFixed(1)}h ago, min interval ${FETCH_MIN_INTERVAL_HOURS}h)`
    );
  }
}

app.listen(PORT, () => {
  console.log(`[server] job-fetcher API listening on http://localhost:${PORT}`);
  console.log("[server] routes:");
  console.log("  GET   /api/health");
  console.log("  GET   /api/jobs            ?status&source&q&postedWithin&limit&offset");
  console.log("  GET   /api/jobs/:id");
  console.log("  GET   /api/sources");
  console.log("  GET   /api/profile");
  console.log("  PUT   /api/profile         full replace, JSON body");
  console.log("  PATCH /api/profile         partial update, JSON body");
  console.log("  POST  /api/refresh         ?mock=1 to use the fixture instead of the live API");

  maybeFetchOnStartup();
});
