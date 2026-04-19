// functions/index.js
// Cloud Functions (2nd gen) entry point. Three HTTP endpoints the PWA hits via
// Firebase Hosting rewrites:
//   /api/describe  -> describe   (Gemini Vision + optional Featherless re-route)
//   /api/speak     -> speak      (ElevenLabs streaming TTS, byte-passthrough)
//   /api/summarize -> summarize  (Gemini, N descriptions -> 2-sentence journey)
//
// Architectural rules preserved from the old Express server:
//   - All third-party API keys live server-side (Secret Manager via
//     functions:secrets:set; injected as process.env at runtime).
//   - Soft rate limit on /api/describe as a safety net behind the client's
//     1.5s throttle.
//   - Two-stage pipeline: Gemini classifies + describes, then transit/retail
//     get re-routed through Featherless — but ONLY when Gemini reports
//     high confidence (else the specialized model is being asked to enrich
//     an unreliable baseline and hallucinates harder).
//   - TTS streams chunks end-to-end (no buffer-to-completion).
//
// describe + speak run with minInstances: 1 (latency budget cannot tolerate
// cold starts). summarize is user-initiated and cold start is acceptable, so
// minInstances: 0 — keeps cost down.

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';

import { classifyAndDescribe, summarizeDescriptions } from './lib/gemini.js';
import { describeWithFeatherless, FEATHERLESS_CONTEXTS } from './lib/featherless.js';
import { streamSpeech, SUPPORTED_LANGUAGE_CODES } from './lib/elevenlabs.js';
import { extractHazards } from './lib/hazards.js';

// Pin region globally so it is always the one Hosting rewrites point at.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// --- Secrets (Secret Manager-backed) ----------------------------------------
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');
const FEATHERLESS_API_KEY = defineSecret('FEATHERLESS_API_KEY');

// --- In-process soft rate limit (per warm instance) -------------------------
const RATE_WINDOW_MS = 2_000;
const RATE_MAX = 2; // 2 requests per 2s, matches the old express-rate-limit cfg
const ipHits = new Map(); // ip -> { count, windowStart }

function shouldThrottle(req) {
  const ip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) return true;
  return false;
}

// Periodic cleanup so the Map doesn't grow unbounded across the instance lifetime.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 5;
  for (const [k, v] of ipHits) {
    if (v.windowStart < cutoff) ipHits.delete(k);
  }
}, 30_000).unref?.();

// --- Helpers ---------------------------------------------------------------

/**
 * Accept either a data URI (`data:image/jpeg;base64,...`) or a raw base64
 * string + `mimeType` field. Returns { imageBase64, mimeType } with the data
 * URI prefix stripped. Returns null on invalid input.
 */
function parseImageInput(body) {
  if (!body) return null;
  const { image, imageBase64, mimeType } = body;

  // Preferred: data URI in `image`.
  if (typeof image === 'string' && image.length > 0) {
    const m = image.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (m) {
      return { imageBase64: m[2], mimeType: m[1] };
    }
    // `image` was provided but isn't a data URI — treat as raw base64.
    if (image.length > 100) {
      return { imageBase64: image, mimeType: mimeType || 'image/jpeg' };
    }
    return null;
  }

  // Legacy: raw base64 in `imageBase64`.
  if (typeof imageBase64 === 'string' && imageBase64.length >= 100) {
    return { imageBase64, mimeType: mimeType || 'image/jpeg' };
  }

  return null;
}

const SOFT_FALLBACK = {
  context: 'general',
  confidence: 'low',
  description: 'Unable to describe this frame.',
  hazards: [],
  source: 'gemini'
};

// --- /api/describe ----------------------------------------------------------
export const describe = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 30,
    minInstances: 1,
    cors: true,
    secrets: [GEMINI_API_KEY, FEATHERLESS_API_KEY]
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' });
      return;
    }

    if (shouldThrottle(req)) {
      res.status(429).json({
        error: 'Too many frame requests. Client must throttle to ~1/1.5s.'
      });
      return;
    }

    const parsed = parseImageInput(req.body);
    if (!parsed) {
      res.status(400).json({
        error:
          'image is required (data URI "data:image/...;base64,..." or raw base64 in imageBase64).'
      });
      return;
    }
    if (parsed.imageBase64.length > 2_500_000) {
      res.status(413).json({
        error: 'Image too large. Resize to 512x512 before sending.'
      });
      return;
    }

    const mode = req.body?.mode === 'detailed' ? 'detailed' : 'quick';
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'en';

    // Stage 1: Gemini (with one retry on parse error).
    let stage1;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        stage1 = await classifyAndDescribe({
          imageBase64: parsed.imageBase64,
          mimeType: parsed.mimeType,
          mode,
          lang
        });
        break; // success
      } catch (err) {
        // Malformed JSON from Gemini — retry once, then soft-fail.
        if (err?.code === 'GEMINI_PARSE_ERROR') {
          if (attempt === 0) {
            console.warn('[describe] gemini parse error, retrying…');
            continue;
          }
          console.warn('[describe] gemini JSON parse failed after retry:', err.message);
          res.json({ ...SOFT_FALLBACK });
          return;
        }
        // Upstream HTTP / network error — don't retry, fail fast.
        console.error('[describe] gemini error:', err);
        const status = Number(err?.status) || 500;
        res.status(status).json({ error: err?.message || 'Internal server error' });
        return;
      }
    }

    let description = stage1.description || '';
    let source = 'gemini';

    // Stage 2: confidence-gated Featherless re-route (transit/retail only,
    // quick mode only). If Gemini isn't confident about context, specializing
    // the prompt would just amplify the wrong domain.
    if (
      mode === 'quick' &&
      stage1.confidence === 'high' &&
      FEATHERLESS_CONTEXTS.has(stage1.context)
    ) {
      try {
        const specialized = await describeWithFeatherless({
          context: stage1.context,
          baselineDescription: description
        });
        if (specialized && specialized.trim().length > 0) {
          description = specialized.trim();
          source = 'featherless';
        }
      } catch (err) {
        // Soft-fail: keep Gemini description; surface in logs.
        console.warn('[describe] featherless fallback:', err.message);
      }
    }

    // Server-side hazard scan against the final description string — no
    // extra round-trip, no extra model call.
    const hazards = extractHazards(description);

    res.json({
      context: stage1.context,
      confidence: stage1.confidence,
      description,
      hazards,
      source
    });
  }
);

// --- /api/speak -------------------------------------------------------------
export const speak = onRequest(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    minInstances: 1,
    cors: true,
    secrets: [ELEVENLABS_API_KEY]
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' });
      return;
    }

    try {
      const { text, voiceId, language_code: languageCode } = req.body || {};
      if (typeof text !== 'string' || text.trim().length === 0) {
        res.status(400).json({ error: 'text is required.' });
        return;
      }
      if (text.length > 2_000) {
        res.status(413).json({ error: 'text too long; max 2000 chars per utterance.' });
        return;
      }

      // Validate language_code against the allowed list. Ignore silently on
      // mismatch per contract — don't error out; narration must keep flowing.
      const normalizedLang =
        typeof languageCode === 'string' && SUPPORTED_LANGUAGE_CODES.has(languageCode)
          ? languageCode
          : undefined;

      await streamSpeech({
        text: text.trim(),
        voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID,
        languageCode: normalizedLang,
        res
      });
    } catch (err) {
      console.error('[speak] unhandled error:', err);
      if (!res.headersSent) {
        const status = Number(err?.status) || 500;
        res.status(status).json({ error: err?.message || 'Internal server error' });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

// --- /api/summarize ---------------------------------------------------------
// User-initiated: "summarize my journey so far." Takes the ring buffer of
// recent descriptions the client has kept and returns a 2-sentence narrative.
// Cold start is tolerable here (user already tapped a button and will wait a
// beat for the audio), so minInstances: 0 to keep cost flat.
export const summarize = onRequest(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 15,
    minInstances: 0,
    cors: true,
    secrets: [GEMINI_API_KEY]
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' });
      return;
    }

    try {
      const { descriptions } = req.body || {};
      if (!Array.isArray(descriptions)) {
        res.status(400).json({ error: 'descriptions must be an array.' });
        return;
      }
      if (descriptions.length < 1 || descriptions.length > 50) {
        res
          .status(400)
          .json({ error: 'descriptions must contain between 1 and 50 items.' });
        return;
      }
      for (const d of descriptions) {
        if (typeof d !== 'string' || d.length === 0 || d.length > 500) {
          res.status(400).json({
            error: 'each description must be a non-empty string of <= 500 chars.'
          });
          return;
        }
      }

      const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'en';
      const summary = await summarizeDescriptions({ descriptions, lang });
      res.json({ summary });
    } catch (err) {
      console.error('[summarize] unhandled error:', err);
      const status = Number(err?.status) || 500;
      res.status(status).json({ error: err?.message || 'Internal server error' });
    }
  }
);
