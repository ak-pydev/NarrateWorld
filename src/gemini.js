// src/gemini.js — client-side wrapper around the server /api/describe proxy.
// NOTE: this file never holds a Gemini key; all auth happens server-side.

const DESCRIBE_TIMEOUT_MS = 10_000; // 10s hard timeout
const SUMMARIZE_TIMEOUT_MS = 15_000; // 15s (user-initiated, can wait a bit)

/**
 * @param {string} imageBase64 raw base64 JPEG (no data: prefix)
 * @param {AbortSignal} [signal]
 * @param {{mode?: 'quick' | 'detailed', lang?: string}} [opts]
 * @returns {Promise<{context: string, confidence?: string, description: string, hazards?: string[], source?: string, modelPath?: string}>}
 */
export async function describeFrame(imageBase64, signal, opts = {}) {
  // Send ONLY the data URI (not both raw + data URI) to halve payload size.
  const body = {
    image: `data:image/jpeg;base64,${imageBase64}`
  };
  if (opts.mode) body.mode = opts.mode;
  if (opts.lang) body.lang = opts.lang;

  // Merge caller signal with our timeout signal.
  const timeout = AbortSignal.timeout?.(DESCRIBE_TIMEOUT_MS);
  const combinedSignal = timeout && signal
    ? AbortSignal.any([signal, timeout])
    : signal || timeout;

  const resp = await fetch('/api/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combinedSignal
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`describe failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Ask the backend to summarize a session's descriptions.
 * @param {string[]} descriptions
 * @param {AbortSignal} [signal]
 * @returns {Promise<{summary: string}>}
 */
export async function summarizeSession(descriptions, signal, opts = {}) {
  const body = { descriptions };
  if (opts.lang) body.lang = opts.lang;

  const timeout = AbortSignal.timeout?.(SUMMARIZE_TIMEOUT_MS);
  const combinedSignal = timeout && signal
    ? AbortSignal.any([signal, timeout])
    : signal || timeout;

  const resp = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combinedSignal
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`summarize failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
  return resp.json();
}
