import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Builds the console summary lines and a Markdown report listing only the
 * fresh (new-since-last-run) jobs.
 *
 * @param {object} args
 * @param {object[]} args.fresh - normalized Job objects inserted this run
 * @param {object} args.stats
 * @param {number} args.stats.rawCount
 * @param {number} args.stats.normalizedCount
 * @param {number} args.stats.skipped
 * @param {number} args.stats.duplicatesInBatch
 * @param {number} args.stats.alreadyInDb
 * @param {number} args.stats.totalInDb - total row count in the DB after this run
 * @returns {{ consoleLines: string[], markdown: string }}
 */
export function buildReport({ fresh, stats }) {
  const consoleLines = [
    `Raw jobs fetched:        ${stats.rawCount}`,
    `Normalized:              ${stats.normalizedCount} (skipped ${stats.skipped})`,
    `Duplicates within batch: ${stats.duplicatesInBatch}`,
    `Already in DB:           ${stats.alreadyInDb}`,
    `Fresh (new) inserted:    ${fresh.length}`,
    `Total rows in DB:        ${stats.totalInDb}`,
  ];

  const markdown = buildMarkdown(fresh);

  return { consoleLines, markdown };
}

function buildMarkdown(fresh) {
  const generatedAt = new Date().toISOString();
  const lines = [
    "# New jobs since last run",
    "",
    `Generated: ${generatedAt}`,
    "",
    `Found ${fresh.length} new job(s).`,
    "",
  ];

  if (fresh.length === 0) {
    lines.push("_No new jobs this run._");
    return lines.join("\n") + "\n";
  }

  lines.push("| Title | Company | Source | Location | Posted | Salary | URL |");
  lines.push("|---|---|---|---|---|---|---|");

  for (const job of fresh) {
    lines.push(
      `| ${mdEscape(job.title)} | ${mdEscape(job.company)} | ${mdEscape(job.source)} | ${mdEscape(
        job.location
      )} | ${mdEscape(job.postedDate)} | ${mdEscape(job.salary)} | ${mdLink(job.url)} |`
    );
  }

  return lines.join("\n") + "\n";
}

function mdEscape(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mdLink(url) {
  if (!url) return "-";
  return `[link](${url})`;
}

/**
 * Writes the markdown report to disk, creating the parent directory if
 * necessary.
 *
 * @param {string} markdown
 * @param {string} outPath
 */
export function writeReport(markdown, outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf-8");
}
