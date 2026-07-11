import { readFile, writeFile } from "node:fs/promises";

// Load/validate/save for config/profile.json, shared by the GET/PUT/PATCH
// /api/profile routes in src/server.js. The pipeline (src/pipeline.js) reads
// profile.json fresh on every runPipeline() call, so any change saved here
// takes effect on the very next fetch (CLI or POST /api/refresh) without a
// server restart.

const ARRAY_OF_STRINGS_FIELDS = [
  "roleVariants",
  "mustHaveSkills",
  "niceToHaveSkills",
  "locations",
  "excludeKeywords",
];

const NUMBER_FIELDS = ["experienceYears", "minScore"];

const ALL_FIELDS = new Set([...ARRAY_OF_STRINGS_FIELDS, ...NUMBER_FIELDS]);

/**
 * Validates a single field's value against its expected type/shape.
 *
 * @param {string} field - must already be a known field name
 * @param {*} value
 * @returns {string|null} a specific error message naming the field, or null if valid
 */
function validateField(field, value) {
  if (ARRAY_OF_STRINGS_FIELDS.includes(field)) {
    if (!Array.isArray(value)) {
      return `"${field}" must be an array of non-empty strings`;
    }
    const hasBadEntry = value.some((entry) => typeof entry !== "string" || entry.trim() === "");
    if (hasBadEntry) {
      return `"${field}" must be an array of non-empty strings`;
    }
    return null;
  }

  if (field === "experienceYears") {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      return `"experienceYears" must be a number >= 0`;
    }
    return null;
  }

  if (field === "minScore") {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 100) {
      return `"minScore" must be a number between 0 and 100`;
    }
    return null;
  }

  // Should be unreachable given ALL_FIELDS gating upstream, but fail safe.
  return `unknown field "${field}"`;
}

/**
 * Validates a profile object (full or partial).
 *
 * @param {object} body - parsed JSON request body
 * @param {object} [options]
 * @param {boolean} [options.partial=false] - if true (PATCH), only fields present in
 *   the body are validated/required; if false (PUT), every known field must be present.
 * @returns {string|null} a specific error message naming the bad/missing field, or null if valid
 */
export function validateProfile(body, { partial = false } = {}) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }

  for (const key of Object.keys(body)) {
    if (!ALL_FIELDS.has(key)) {
      return `unknown field "${key}" is not allowed`;
    }
  }

  const fieldsToValidate = partial ? Object.keys(body) : [...ALL_FIELDS];

  for (const field of fieldsToValidate) {
    if (!partial && !(field in body)) {
      return `missing required field "${field}"`;
    }
    const error = validateField(field, body[field]);
    if (error) return error;
  }

  return null;
}

/**
 * Loads and parses config/profile.json.
 *
 * @param {string} profilePath
 * @returns {Promise<object>}
 */
export async function loadProfile(profilePath) {
  const contents = await readFile(profilePath, "utf-8");
  return JSON.parse(contents);
}

/**
 * Pretty-prints and writes a profile object to config/profile.json.
 *
 * @param {string} profilePath
 * @param {object} profile
 */
export async function saveProfile(profilePath, profile) {
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}
