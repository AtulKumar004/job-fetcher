// Two-stage dedupe: first collapse duplicate ids within the batch itself
// (the same job can come back from two different role-variant/location
// queries in one run), then split what's left against ids already
// persisted in SQLite from prior runs.

/**
 * @param {object[]} normalizedJobs - normalized Job objects (must have .id)
 * @param {Set<string>} existingIds - ids already present in the DB
 * @returns {{
 *   fresh: object[],
 *   duplicatesInBatch: number,
 *   alreadyInDb: number,
 *   seenAgainIds: string[]
 * }}
 */
export function dedupeJobs(normalizedJobs, existingIds) {
  const jobs = normalizedJobs ?? [];

  // Stage 1: collapse duplicates within this batch, keeping the first
  // occurrence of each id.
  const seenInBatch = new Set();
  const uniqueInBatch = [];
  let duplicatesInBatch = 0;

  for (const job of jobs) {
    if (seenInBatch.has(job.id)) {
      duplicatesInBatch += 1;
      continue;
    }
    seenInBatch.add(job.id);
    uniqueInBatch.push(job);
  }

  // Stage 2: split against what's already in the DB.
  const fresh = [];
  const seenAgainIds = [];

  for (const job of uniqueInBatch) {
    if (existingIds.has(job.id)) {
      seenAgainIds.push(job.id);
    } else {
      fresh.push(job);
    }
  }

  return {
    fresh,
    duplicatesInBatch,
    alreadyInDb: seenAgainIds.length,
    seenAgainIds,
  };
}
