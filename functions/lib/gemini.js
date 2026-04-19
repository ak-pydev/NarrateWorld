// functions/lib/gemini.js
// Thin Gemini Flash client. Two modes:
//   - "quick"    (default): one-call classifier + describer. Returns
//                {context, confidence, description} via strict JSON.
//                Description uses Near:/Mid:/Far: distance prefixes so the
//                client can speak spatially without a second round-trip.
//   - "detailed": user-initiated, richer prompt: visible text/brands, distances,
//                recommended next action. Still returns the same JSON shape
//                (context is usually "general" in this mode, but we accept
//                whatever Gemini returns and normalize).
//
// Additionally, a summarize() helper condenses a list of prior descriptions
// into a single 2-sentence journey narrative (used by /api/summarize).
//
// Node 20 ships native `fetch` — no node-fetch dep.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const VALID_CONTEXTS = new Set(['transit', 'medical', 'retail', 'outdoor', 'general']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

const LANG_NAMES = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  zh: 'Simplified Chinese (简体中文)',
  hi: 'Hindi (हिन्दी)'
};

function languageDirective(lang) {
  const name = LANG_NAMES[lang];
  if (!name || lang === 'en') return '';
  return `\n- The "description" field MUST be written in ${name}. Keep "context" and "confidence" as English enum values. Distance-prefix labels (Near:/Mid:/Far:) stay in English; everything else in ${name}.`;
}

const QUICK_SYSTEM_PROMPT = `You are a real-time scene narrator for a blind or low-vision person. You must be concise, spatial, and hazard-aware.

For EVERY input image, respond with ONLY a JSON object (no prose, no markdown fences) of the form:
{"context": "<one of: transit | medical | retail | outdoor | general>", "confidence": "<one of: high | medium | low>", "description": "<2-3 short sentences with distance tags>"}

Rules:
- "context" classifies the environment:
  - transit  = streets, crosswalks, buses, trains, stations, traffic, sidewalks
  - medical  = clinics, hospitals, pharmacies, medication labels, lab settings
  - retail   = stores, menus, product shelves, cafes, checkout counters, price tags
  - outdoor  = parks, trails, nature, buildings at a distance, generic outdoor scenes
  - general  = indoor generic, unclear, or none of the above
- "confidence" is how sure you are about the "context" classification: high | medium | low.
- "description" must estimate relative distance for every object and prefix each
  with "Near:" (<1m), "Mid:" (1-5m), or "Far:" (>5m). For example:
    "Near: fire hydrant. Mid: parked car. Far: crosswalk."
  Prioritize hazards, people, text/signs, doorways, stairs, obstacles, landmarks.
  Never mention you are an AI. Never apologize. Never hedge with "appears to be."
  Keep it under 3 sentences. Speak in present tense.`;

const DETAILED_SYSTEM_PROMPT = `You are a real-time scene narrator for a blind or low-vision person.

For EVERY input image, respond with ONLY a JSON object (no prose, no markdown fences) of the form:
{"context": "<one of: transit | medical | retail | outdoor | general>", "confidence": "<one of: high | medium | low>", "description": "<under 4 sentences>"}

For the "description" field: Give a detailed description including any visible text, brand names, distances, and recommended next action for a blind user. Keep under 4 sentences. Use "Near:" (<1m), "Mid:" (1-5m), "Far:" (>5m) prefixes when describing objects' locations. Never mention you are an AI. Never apologize.`;

/**
 * Single-call classifier + describer. Returns
 * { context, confidence, description }. On malformed JSON or upstream error,
 * throws an Error whose .status is an HTTP status — callers may catch and
 * translate to a soft fallback response.
 *
 * @param {{imageBase64: string, mimeType: string, mode?: 'quick'|'detailed', lang?: string}} opts
 */
export async function classifyAndDescribe({ imageBase64, mimeType, mode, lang }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw httpError(500, 'GEMINI_API_KEY not set on server.');
  }

  const isDetailed = mode === 'detailed';
  const base = isDetailed ? DETAILED_SYSTEM_PROMPT : QUICK_SYSTEM_PROMPT;
  const systemPrompt = base + languageDirective(lang);
  const userText = isDetailed
    ? 'Classify the context and give a detailed description of this scene.'
    : 'Classify the context and describe this scene.';

  const url = `${API_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: imageBase64
            }
          },
          { text: userText }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: isDetailed ? 600 : 512,
      responseMimeType: 'application/json'
    },
    safetySettings: []
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await safeText(resp);
    throw httpError(resp.status, `Gemini error ${resp.status}: ${detail}`);
  }

  const json = await resp.json();
  const text = extractText(json);

  // Log raw text to aid debugging (first 300 chars).
  console.log('[gemini] raw response:', String(text).slice(0, 300));

  let parsed;
  try {
    // Strategy 1: direct parse (works when responseMimeType is honoured).
    parsed = JSON.parse(text);
  } catch (_firstErr) {
    // Strategy 2: extract the JSON object between first '{' and last '}'.
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        parsed = JSON.parse(text.substring(start, end + 1));
      }
    } catch { /* fall through */ }

    // Strategy 3: rescue truncated JSON — attempt to close the object.
    if (!parsed) {
      try {
        const start = text.indexOf('{');
        if (start !== -1) {
          let fragment = text.substring(start).replace(/[\r\n]+/g, ' ');
          // Close unclosed strings and the object.
          if (!fragment.endsWith('}')) {
            // Trim any trailing partial value
            fragment = fragment.replace(/,\s*"[^"]*$/, '')  // trailing key without value
                               .replace(/,\s*$/, '');       // trailing comma
            if (!fragment.endsWith('"')) fragment += '"';
            fragment += '}';
          }
          parsed = JSON.parse(fragment);
          console.warn('[gemini] rescued truncated JSON');
        }
      } catch { /* fall through */ }
    }

    if (!parsed) {
      const pe = new Error(`Gemini returned non-JSON: ${String(text).slice(0, 300)}`);
      pe.code = 'GEMINI_PARSE_ERROR';
      pe.raw = text;
      throw pe;
    }
  }

  const context = VALID_CONTEXTS.has(parsed.context) ? parsed.context : 'general';
  const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low';
  const description =
    typeof parsed.description === 'string' ? parsed.description.trim() : '';
  return { context, confidence, description };
}

/**
 * Summarize a list of prior scene descriptions into a 2-sentence journey
 * narrative from a blind user's POV.
 * @param {{descriptions: string[]}} opts
 * @returns {Promise<string>}
 */
export async function summarizeDescriptions({ descriptions, lang }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw httpError(500, 'GEMINI_API_KEY not set on server.');
  }

  const joined = descriptions
    .map((d, i) => `${i + 1}. ${String(d).trim()}`)
    .join('\n');

  const langName = LANG_NAMES[lang];
  const langSuffix =
    langName && lang !== 'en'
      ? ` Write the summary in ${langName}.`
      : '';

  const prompt = `Summarize the following scene descriptions as a single 2-sentence journey narrative from a blind user's perspective. Be concrete about places and notable events.${langSuffix}\n\n${joined}`;

  const url = `${API_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 200
    },
    safetySettings: []
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await safeText(resp);
    throw httpError(resp.status, `Gemini error ${resp.status}: ${detail}`);
  }

  const json = await resp.json();
  const text = extractText(json);
  return String(text || '').trim();
}

function extractText(geminiResponse) {
  const cand = geminiResponse?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
