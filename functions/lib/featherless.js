// functions/lib/featherless.js
// Featherless.ai uses an OpenAI-compatible chat completions endpoint.
// We take Gemini's baseline description and ask a domain-specialized model to
// enrich it. Only transit/retail at MVP; medical has a default and outdoor
// stays on Gemini (plan §API Integration Summary).

const API_URL = 'https://api.featherless.ai/v1/chat/completions';

const MODELS = {
  transit: process.env.FEATHERLESS_MODEL_TRANSIT || 'mistralai/Mistral-7B-Instruct-v0.3',
  retail: process.env.FEATHERLESS_MODEL_RETAIL || 'meta-llama/Meta-Llama-3-8B-Instruct',
  medical: process.env.FEATHERLESS_MODEL_MEDICAL || 'epfl-llm/meditron-7b'
};

// MVP: only these two are actively routed. outdoor stays on Gemini.
export const FEATHERLESS_CONTEXTS = new Set(['transit', 'retail']);

const SYSTEM_BY_CONTEXT = {
  transit:
    'You are a navigation aid for a blind pedestrian. Given a baseline scene description, rewrite it to highlight hazards (curbs, stairs, traffic, bikes), crossing signals, bus/train indicators, and distances in steps. Keep it under 3 short sentences. Present tense. No hedging.',
  retail:
    'You are a shopping assistant for a blind user. Given a baseline scene description, rewrite it to surface any visible text: product names, prices, menu items, signs, aisle labels. Keep it under 3 short sentences. Present tense. No hedging.',
  medical:
    'You are a clinical assistant for a blind user. Given a baseline scene description, rewrite it focusing on labels, dosages, warnings, wayfinding signs, and staff presence. Keep it under 3 short sentences. Present tense. No hedging.'
};

/**
 * @param {{context: 'transit'|'retail'|'medical', baselineDescription: string}} opts
 * @returns {Promise<string>} enriched description (plain text)
 */
export async function describeWithFeatherless({ context, baselineDescription }) {
  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) {
    throw new Error('FEATHERLESS_API_KEY not set.');
  }
  const model = MODELS[context];
  const system = SYSTEM_BY_CONTEXT[context];
  if (!model || !system) {
    throw new Error(`Featherless: no routing for context "${context}".`);
  }

  const body = {
    model,
    max_tokens: 200,
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Baseline description:\n${baselineDescription}\n\nRewrite for a blind user per the system instructions. Output only the rewritten description.`
      }
    ]
  };

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error(`Featherless ${resp.status}: ${detail}`);
  }

  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content || '';
  return String(text).trim();
}

/**
 * Optional: pre-warm a Featherless model to dodge cold-start (plan §Risks).
 * Fire-and-forget from server startup or first request.
 */
export async function prewarmFeatherless(context) {
  try {
    await describeWithFeatherless({
      context,
      baselineDescription: 'A warm-up ping. Respond with the word ok.'
    });
  } catch (err) {
    console.warn(`[featherless] prewarm ${context} failed:`, err.message);
  }
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
