// functions/lib/elevenlabs.js
// Streaming TTS. Pipes ElevenLabs chunks straight through to the client so the
// browser can start playing before synthesis completes.
//
// Cloud Functions (2nd gen) is backed by Cloud Run, so HTTP streaming
// passthrough works the same as in plain Express. We explicitly flushHeaders()
// before the first write so the client can begin buffering immediately.

const BASE = 'https://api.elevenlabs.io/v1';

// Whitelist for ElevenLabs `language_code` passthrough. The client may request
// any of these; anything else is silently dropped (not an error — we keep
// narration flowing in the default voice model rather than fail the request).
export const SUPPORTED_LANGUAGE_CODES = new Set(['en', 'es', 'fr', 'zh', 'hi']);

/**
 * Streams audio/mpeg from ElevenLabs to the given response.
 * @param {{text: string, voiceId: string, languageCode?: string, res: import('express').Response}} opts
 */
export async function streamSpeech({ text, voiceId, languageCode, res }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ELEVENLABS_API_KEY not set on server.' });
    return;
  }
  if (!voiceId) {
    res.status(500).json({ error: 'ELEVENLABS_VOICE_ID not set on server.' });
    return;
  }

  const url = `${BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`;

  // Use multilingual_v2 when forcing a non-English language to prevent the
  // voice identity from changing/degrading (a known turbo_v2_5 quirk).
  const isNonEnglish = languageCode && languageCode !== 'en' && SUPPORTED_LANGUAGE_CODES.has(languageCode);

  const body = {
    text,
    model_id: isNonEnglish ? 'eleven_multilingual_v2' : 'eleven_turbo_v2_5',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true
    }
  };

  // Only include language_code when the caller supplied one we trust. ElevenLabs
  // accepts `language_code` on multilingual models; invalid values get silently
  // dropped upstream of this function.
  if (languageCode && SUPPORTED_LANGUAGE_CODES.has(languageCode)) {
    body.language_code = languageCode;
  }

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify(body)
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await safeText(upstream);
    res.status(upstream.status || 502).json({
      error: `ElevenLabs ${upstream.status}: ${detail}`
    });
    return;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); // hint to any intermediary not to buffer
  // Send response headers immediately so the client (and Hosting CDN edge) start
  // forwarding bytes before synthesis is complete.
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // upstream.body is a WHATWG ReadableStream in Node 20.
  const reader = upstream.body.getReader();
  res.on('close', () => {
    try {
      reader.cancel();
    } catch {
      /* noop */
    }
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !res.writableEnded) {
        res.write(Buffer.from(value));
      }
    }
  } catch (err) {
    console.warn('[speak] stream error:', err.message);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
