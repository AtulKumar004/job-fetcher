import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Thin wrapper over better-sqlite3. Table matches the normalized Job schema
// (see job-fetcher-plan.md) plus a `lastSeenAt` column that's updated every
// time a job re-appears in a later run (used to tell "still active" apart
// from "fetched once and never seen again").
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT,
  title TEXT,
  company TEXT,
  location TEXT,
  description TEXT,
  url TEXT,
  postedDate TEXT,
  salary TEXT,
  score INTEGER,
  status TEXT,
  fetchedAt TEXT,
  lastSeenAt TEXT
)
`;

/**
 * Opens (creating if necessary) the SQLite database at dbPath, ensures the
 * parent directory exists, enables WAL mode, and makes sure the jobs table
 * exists.
 *
 * @param {string} dbPath - absolute or relative path to the .db file
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE_SQL);

  return db;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>} every job id currently stored
 */
export function getExistingIds(db) {
  const rows = db.prepare("SELECT id FROM jobs").all();
  return new Set(rows.map((row) => row.id));
}

/**
 * Inserts a batch of normalized jobs inside a single transaction. Assumes
 * none of the ids already exist (callers should dedupe against
 * getExistingIds() first) — uses INSERT OR REPLACE so it's safe to call
 * again for the same id without throwing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} jobs - normalized Job objects
 */
export function insertJobs(db, jobs) {
  if (!jobs || jobs.length === 0) return;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO jobs
      (id, source, title, company, location, description, url, postedDate, salary, score, status, fetchedAt, lastSeenAt)
    VALUES
      (@id, @source, @title, @company, @location, @description, @url, @postedDate, @salary, @score, @status, @fetchedAt, @lastSeenAt)
  `);

  const insertMany = db.transaction((rows) => {
    for (const job of rows) {
      insert.run({
        ...job,
        lastSeenAt: job.fetchedAt,
      });
    }
  });

  insertMany(jobs);
}

/**
 * Updates lastSeenAt for jobs that re-appeared in this run without touching
 * any other column (status, score, etc. are left as-is).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} ids
 * @param {string} timestamp - ISO timestamp
 */
export function touchLastSeen(db, ids, timestamp) {
  if (!ids || ids.length === 0) return;

  const update = db.prepare("UPDATE jobs SET lastSeenAt = ? WHERE id = ?");
  const updateMany = db.transaction((idList) => {
    for (const id of idList) {
      update.run(timestamp, id);
    }
  });

  updateMany(ids);
}

/**
 * Flips every job currently marked 'new' to 'seen'. Call this at the START
 * of a run, before inserting this run's results, so that 'new' always means
 * "new since the last run" rather than accumulating across runs.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} number of rows updated
 */
export function markNewAsSeen(db) {
  const result = db.prepare("UPDATE jobs SET status = 'seen' WHERE status = 'new'").run();
  return result.changes;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} status
 * @returns {object[]}
 */
export function getJobsByStatus(db, status) {
  return db.prepare("SELECT * FROM jobs WHERE status = ?").all(status);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {number} total row count
 */
export function countAll(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM jobs").get();
  return row.count;
}

/**
 * Most recent activity timestamp across all jobs, used by the server's
 * fetch-on-startup staleness guard: prefers lastSeenAt (bumped every time a
 * job re-appears in a run) and falls back to fetchedAt for any row where
 * lastSeenAt is null.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null} ISO timestamp, or null if the table is empty
 */
export function getLastActivityTimestamp(db) {
  const row = db.prepare("SELECT MAX(COALESCE(lastSeenAt, fetchedAt)) AS ts FROM jobs").get();
  return row?.ts ?? null;
}

const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;

/**
 * Builds a WHERE clause + bound params array shared by queryJobs/countJobs.
 * Uses parameter placeholders only — never string-interpolates filter
 * values into the SQL text.
 *
 * @param {object} filters
 * @param {string} [filters.status]
 * @param {string} [filters.source]
 * @param {string} [filters.q]
 * @param {string} [filters.postedAfter] - ISO timestamp; only jobs with a known
 *   postedDate at or after this are matched (jobs with a null postedDate are
 *   excluded, since we can't tell when they were posted)
 * @returns {{ whereSql: string, params: object }}
 */
function buildWhere({ status, source, q, postedAfter } = {}) {
  const clauses = [];
  const params = {};

  if (status) {
    clauses.push("status = @status");
    params.status = status;
  }
  if (source) {
    clauses.push("source = @source");
    params.source = source;
  }
  if (q) {
    clauses.push("(title LIKE @q ESCAPE '\\' OR company LIKE @q ESCAPE '\\')");
    const escaped = String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.q = `%${escaped}%`;
  }
  if (postedAfter) {
    clauses.push("postedDate IS NOT NULL AND postedDate >= @postedAfter");
    params.postedAfter = postedAfter;
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { whereSql, params };
}

/**
 * Queries jobs with optional filters, ordered newest-first, with
 * limit/offset pagination. All filter values are bound as prepared-statement
 * parameters (no string interpolation of user input).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [filters]
 * @param {string} [filters.status] - exact match
 * @param {string} [filters.source] - exact match
 * @param {string} [filters.q] - case-insensitive substring match against title OR company
 * @param {string} [filters.postedAfter] - ISO timestamp lower bound on postedDate
 * @param {number} [filters.limit=50] - capped at 200
 * @param {number} [filters.offset=0]
 * @returns {object[]}
 */
export function queryJobs(db, { status, source, q, postedAfter, limit = DEFAULT_QUERY_LIMIT, offset = 0 } = {}) {
  const { whereSql, params } = buildWhere({ status, source, q, postedAfter });

  const cappedLimit = Math.max(0, Math.min(Number(limit) || 0, MAX_QUERY_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const sql = `
    SELECT * FROM jobs
    ${whereSql}
    ORDER BY fetchedAt DESC, postedDate DESC
    LIMIT @limit OFFSET @offset
  `;

  return db.prepare(sql).all({ ...params, limit: cappedLimit, offset: safeOffset });
}

/**
 * Counts jobs matching the same filters as queryJobs (ignores limit/offset).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.source]
 * @param {string} [filters.q]
 * @param {string} [filters.postedAfter]
 * @returns {number}
 */
export function countJobs(db, { status, source, q, postedAfter } = {}) {
  const { whereSql, params } = buildWhere({ status, source, q, postedAfter });
  const sql = `SELECT COUNT(*) AS count FROM jobs ${whereSql}`;
  const row = db.prepare(sql).get(params);
  return row.count;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|undefined}
 */
export function getJobById(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

/**
 * Distinct sources with their row counts, most jobs first.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ source: string, count: number }[]}
 */
export function getSourceCounts(db) {
  return db
    .prepare("SELECT source, COUNT(*) AS count FROM jobs GROUP BY source ORDER BY count DESC")
    .all();
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function close(db) {
  db.close();
}
