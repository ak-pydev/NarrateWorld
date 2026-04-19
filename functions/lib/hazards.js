// functions/lib/hazards.js
// Server-side hazard extraction. No extra model call — we scan the Gemini
// description against a fixed keyword list so the response comes back in the
// same round-trip. Case-insensitive substring match, deduped, order preserved
// by first occurrence in the description.
//
// Plan ref: Tier 1 #1. Keep this list in sync with the contract in CLAUDE.md /
// the task spec; the client UI keys off these exact strings for alerting.

export const HAZARD_KEYWORDS = [
  'step',
  'steps',
  'stairs',
  'staircase',
  'car',
  'vehicle',
  'bike',
  'bicycle',
  'dog',
  'wet floor',
  'wet',
  'hole',
  'curb',
  'hazard',
  'warning',
  'caution',
  'approaching',
  'oncoming',
  'traffic',
  'obstacle',
  'cone',
  'spill',
  'ice',
  'slippery',
  'person approaching'
];

/**
 * Scan `description` for hazard keywords. Returns a deduped array of the
 * matched keywords (lowercased, original casing of the keyword list).
 * @param {string} description
 * @returns {string[]}
 */
export function extractHazards(description) {
  if (typeof description !== 'string' || description.length === 0) return [];
  const haystack = description.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const kw of HAZARD_KEYWORDS) {
    if (haystack.includes(kw.toLowerCase()) && !seen.has(kw)) {
      seen.add(kw);
      out.push(kw);
    }
  }
  return out;
}
