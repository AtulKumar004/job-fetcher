import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fetchJSearchJobs } from "./fetchers/jsearch.js";
import { normalizeAll } from "./normalize.js";
import { openDb, getExistingIds, insertJobs, touchLastSeen, markNewAsSeen, countAll, close } from "./storage.js";
import { dedupeJobs } from "./dedupe.js";
import { buildReport, writeReport } from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const PROFILE_PATH = path.join(ROOT_DIR, "config", "profile.json");
const MOCK_FIXTURE_PATH = path.join(__dirname, "fixtures", "jsearch-sample.json");
const DATA_DIR = path.join(ROOT_DIR, "data");

async function loadJson(filePath) {
  const contents = await readFile(filePath, "utf-8");
  return JSON.parse(contents);
}

function truncate(str, maxLen) {
  const s = String(str ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function printJobsTable(jobs) {
  if (jobs.length === 0) {
    console.log("(no jobs to display)");
    return;
  }

  const rows = jobs.map((job) => ({
    title: truncate(job.title, 35),
    company: truncate(job.company ?? "-", 25),
    source: job.source,
    location: truncate(job.location ?? "-", 20),
    postedDate: job.postedDate ? job.postedDate.slice(0, 10) : "-",
    url: truncate(job.url ?? "-", 40),
  }));

  console.table(rows);
}

/**
 * Runs the full fetch -> normalize -> dedupe -> store -> report pipeline.
 * Shared by the CLI (src/index.js) and the HTTP API (src/server.js POST
 * /api/refresh) so both entry points behave identically.
 *
 * @param {object} [options]
 * @param {boolean} [options.useMock=false] - load the JSearch fixture instead of calling the live API
 * @returns {Promise<{
 *   stats: {
 *     rawCount: number,
 *     normalizedCount: number,
 *     skipped: number,
 *     duplicatesInBatch: number,
 *     alreadyInDb: number,
 *     freshInserted: number,
 *     totalInDb: number
 *   },
 *   fresh: object[],
 *   reportPath: string,
 *   dbPath: string
 * }>}
 */
export async function runPipeline({ useMock = false } = {}) {
  const profile = await loadJson(PROFILE_PATH);

  let rawJobs;
  if (useMock) {
    console.log("[pipeline] --mock flag set: loading fixture instead of calling JSearch API\n");
    const fixture = await loadJson(MOCK_FIXTURE_PATH);
    rawJobs = fixture.data?.jobs ?? [];
  } else {
    rawJobs = await fetchJSearchJobs(profile);
  }

  const { normalized, skipped } = normalizeAll(rawJobs);

  // Mock and real runs use separate DB/report files so testing never
  // pollutes real data (or burns through the real report history).
  const dbPath = path.join(DATA_DIR, useMock ? "jobs-mock.db" : "jobs.db");
  const reportPath = path.join(DATA_DIR, useMock ? "last-run-report-mock.md" : "last-run-report.md");

  const db = openDb(dbPath);

  try {
    // Flip any previously-'new' rows to 'seen' FIRST, so that 'new' always
    // means "new since the last run" rather than accumulating forever.
    markNewAsSeen(db);

    const existingIds = getExistingIds(db);
    const { fresh, duplicatesInBatch, alreadyInDb, seenAgainIds } = dedupeJobs(normalized, existingIds);

    const now = new Date().toISOString();

    const freshToInsert = fresh.map((job) => ({ ...job, status: "new", fetchedAt: now }));
    insertJobs(db, freshToInsert);
    touchLastSeen(db, seenAgainIds, now);

    const totalInDb = countAll(db);

    const stats = {
      rawCount: rawJobs.length,
      normalizedCount: normalized.length,
      skipped,
      duplicatesInBatch,
      alreadyInDb,
      freshInserted: freshToInsert.length,
      totalInDb,
    };

    const { consoleLines, markdown } = buildReport({
      fresh: freshToInsert,
      stats,
    });

    console.log("");
    console.log("Summary:");
    for (const line of consoleLines) {
      console.log(`  ${line}`);
    }
    console.log("");

    printJobsTable(freshToInsert);

    if (freshToInsert.length > 0 && freshToInsert.length <= 20) {
      console.log("");
      console.log("New jobs (full JSON):");
      console.log(JSON.stringify(freshToInsert, null, 2));
    }

    writeReport(markdown, reportPath);
    console.log("");
    console.log(`Report written to ${reportPath}`);
    console.log(`Database: ${dbPath}`);

    return {
      stats,
      fresh: freshToInsert,
      reportPath,
      dbPath,
    };
  } finally {
    close(db);
  }
}
