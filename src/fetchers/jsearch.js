import axios from "axios";

// JSearch (RapidAPI, publisher OpenWeb Ninja) fetcher — LinkedIn / Indeed / Glassdoor coverage.
//
// Endpoint confirmed empirically against the live API (2026-07-11): the old
// GET /search returns 404 "Endpoint '/search' does not exist"; the current
// endpoint is GET /search-v2 with params `query`, `num_pages`, `country`,
// `date_posted` and headers x-rapidapi-key / x-rapidapi-host. The response
// nests results under data.jobs and includes a data.cursor for paginating
// beyond num_pages (cursor-following not needed at Phase 0 volumes).
const JSEARCH_BASE_URL = "https://jsearch.p.rapidapi.com";
const JSEARCH_SEARCH_PATH = "/search-v2";
const JSEARCH_HOST = "jsearch.p.rapidapi.com";

const DEFAULT_MAX_REQUESTS = 6; // free tier is 200 req/month; keep a single run cheap
const DEFAULT_NUM_PAGES = 1;
const DEFAULT_COUNTRY = "in";
const DEFAULT_DATE_POSTED = "all";

function getApiKey() {
  const key = process.env.RAPIDAPI_KEY;
  if (!key || key.trim() === "" || key === "your_rapidapi_key_here") {
    throw new Error(
      [
        "RAPIDAPI_KEY is missing or still set to the placeholder value.",
        "",
        "To fix this:",
        "  1. Sign up (or log in) at https://rapidapi.com",
        "  2. Subscribe to the JSearch API (free plan): https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
        "  3. Copy your RapidAPI key from the JSearch 'Endpoints' page (the x-rapidapi-key value)",
        "  4. Paste it into .env as RAPIDAPI_KEY=<your key> (see .env.example)",
      ].join("\n")
    );
  }
  return key;
}

// Builds the list of search queries from the profile: one per
// roleVariant x location combo. "Remote" locations use the bare query text
// "remote" appended to the role, matching how JSearch/Google for Jobs
// expects remote searches to be phrased.
function buildQueries(profile) {
  const roleVariants = profile.roleVariants || [];
  const locations = profile.locations || [];
  const queries = [];

  for (const role of roleVariants) {
    for (const location of locations) {
      if (String(location).trim().toLowerCase() === "remote") {
        queries.push(`${role} remote`);
      } else {
        queries.push(`${role} in ${location}`);
      }
    }
  }

  return queries;
}

async function performRequest(axiosInstance, apiKey, query, options) {
  const params = {
    query,
    num_pages: String(options.numPages ?? DEFAULT_NUM_PAGES),
    country: options.country ?? DEFAULT_COUNTRY,
    date_posted: options.datePosted ?? DEFAULT_DATE_POSTED,
  };

  console.log(`[jsearch] request: query="${query}" num_pages=${params.num_pages}`);

  const response = await axiosInstance.get(JSEARCH_SEARCH_PATH, {
    baseURL: JSEARCH_BASE_URL,
    params,
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": JSEARCH_HOST,
    },
  });

  return response.data?.data?.jobs ?? [];
}

/**
 * Fetches raw JSearch job results for every roleVariant x location combo in
 * the profile, up to a hard request budget.
 *
 * @param {object} profile - parsed config/profile.json
 * @param {object} [options]
 * @param {number} [options.maxRequests] - hard cap on API requests this run (default 6)
 * @param {number} [options.numPages] - JSearch num_pages param (default 1)
 * @param {string} [options.country] - JSearch country param (default "in")
 * @param {string} [options.datePosted] - JSearch date_posted param (default "all")
 * @param {import('axios').AxiosInstance} [options.axiosInstance] - injectable axios instance (for testing)
 * @returns {Promise<object[]>} concatenated raw job objects from all successful requests
 */
export async function fetchJSearchJobs(profile, options = {}) {
  const apiKey = getApiKey();
  const axiosInstance = options.axiosInstance ?? axios;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;

  const queries = buildQueries(profile);
  const allJobs = [];
  let requestCount = 0;
  let successCount = 0;
  let failureCount = 0;
  const errors = [];

  for (const query of queries) {
    if (requestCount >= maxRequests) {
      console.log(
        `[jsearch] request budget reached (${maxRequests}); stopping before query="${query}"`
      );
      break;
    }

    requestCount += 1;

    try {
      const jobs = await performRequest(axiosInstance, apiKey, query, options);
      allJobs.push(...jobs);
      successCount += 1;
      console.log(`[jsearch]   -> ${jobs.length} job(s) returned`);
    } catch (err) {
      failureCount += 1;
      const message = err.response
        ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}`
        : err.message;
      errors.push({ query, message });
      console.warn(`[jsearch]   -> request failed for query="${query}": ${message}`);
    }
  }

  if (successCount === 0 && failureCount > 0) {
    throw new Error(
      `All ${failureCount} JSearch request(s) failed. Last error: ${errors[errors.length - 1]?.message
      }`
    );
  }

  console.log(
    `[jsearch] done: ${requestCount} request(s) made, ${successCount} succeeded, ${failureCount} failed, ${allJobs.length} raw job(s) collected`
  );

  return allJobs;
}
