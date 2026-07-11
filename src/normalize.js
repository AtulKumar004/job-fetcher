import { createHash } from "node:crypto";

// Known publisher name fragments -> canonical source id. JSearch aggregates
// many job boards via Google for Jobs, so anything not matching one of
// these falls back to the lowercased publisher name as-is.
const KNOWN_SOURCES = ["linkedin", "indeed", "glassdoor"];

function deriveSource(jobPublisher) {
  const publisher = String(jobPublisher || "").trim().toLowerCase();
  if (!publisher) return "unknown";

  for (const known of KNOWN_SOURCES) {
    if (publisher.includes(known)) return known;
  }

  return publisher;
}

function deriveLocation(raw) {
  const parts = [raw.job_city, raw.job_state, raw.job_country].filter(
    (part) => typeof part === "string" && part.trim() !== ""
  );

  if (parts.length > 0) return parts.join(", ");
  if (typeof raw.job_location === "string" && raw.job_location.trim() !== "") {
    return raw.job_location;
  }
  if (raw.job_is_remote) return "Remote";
  return "Remote";
}

function deriveSalary(raw) {
  const { job_min_salary, job_max_salary, job_salary_period } = raw;

  if (job_min_salary == null && job_max_salary == null) {
    // search-v2 sometimes provides a pre-formatted salary string instead of
    // numeric min/max fields.
    if (typeof raw.job_salary_string === "string" && raw.job_salary_string.trim() !== "") {
      return raw.job_salary_string;
    }
    if (typeof raw.job_salary === "string" && raw.job_salary.trim() !== "") {
      return raw.job_salary;
    }
    return null;
  }

  const period = job_salary_period ? ` / ${job_salary_period}` : "";

  if (job_min_salary != null && job_max_salary != null) {
    return `${job_min_salary}-${job_max_salary}${period}`;
  }
  if (job_min_salary != null) return `${job_min_salary}+${period}`;
  return `up to ${job_max_salary}${period}`;
}

function makeId(source, jobId) {
  return createHash("sha256").update(`${source}:${jobId}`).digest("hex");
}

/**
 * Maps a single raw JSearch job object to the project's normalized Job schema.
 * Returns null if the record is missing required fields (job_id or job_title).
 *
 * @param {object} raw - a single element of a JSearch response's `data` array
 * @returns {object|null}
 */
export function normalizeJSearchJob(raw) {
  if (!raw || !raw.job_id || !raw.job_title) {
    return null;
  }

  const source = deriveSource(raw.job_publisher);

  return {
    id: makeId(source, raw.job_id),
    source,
    title: raw.job_title,
    company: raw.employer_name ?? null,
    location: deriveLocation(raw),
    description: raw.job_description ?? null,
    url: raw.job_apply_link ?? null,
    postedDate: raw.job_posted_at_datetime_utc ?? null,
    salary: deriveSalary(raw),
    score: 0,
    status: "new",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Normalizes an array of raw JSearch job objects, skipping (and counting)
 * any record missing job_id or job_title.
 *
 * @param {object[]} rawJobs
 * @returns {{ normalized: object[], skipped: number }}
 */
export function normalizeAll(rawJobs) {
  const normalized = [];
  let skipped = 0;

  for (const raw of rawJobs ?? []) {
    const job = normalizeJSearchJob(raw);
    if (job) {
      normalized.push(job);
    } else {
      skipped += 1;
    }
  }

  return { normalized, skipped };
}
