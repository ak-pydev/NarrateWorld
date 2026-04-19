// src/elevenlabs.js — client-side wrapper around /api/speak.
// Uses buffered MediaSource chunk playback so audio starts before the stream
// finishes. Falls back to Blob playback on browsers without MSE (iOS Safari).

/**
 * Speak the given text. Resolves when playback has ENDED. Rejects on error.
 * @param {string} text
 * @param {{audioEl: HTMLAudioElement, signal?: AbortSignal, onStart?: () => void, languageCode?: string}} opts
 */
export async function speak(text, { audioEl, signal, onStart, languageCode } = {}) {
  if (!audioEl) throw new Error('audioEl required');

  const body = { text };
  if (languageCode) body.language_code = languageCode;

  const resp = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`speak failed: ${resp.status} ${detail.slice(0, 200)}`);
  }

  const mime = 'audio/mpeg';
  const canMse =
    typeof window !== 'undefined' &&
    'MediaSource' in window &&
    window.MediaSource.isTypeSupported(mime);

  if (canMse) {
    await playViaMediaSource(resp.body, audioEl, mime, onStart, signal);
  } else {
    await playViaBlob(resp, audioEl, onStart, signal);
  }
}

async function playViaMediaSource(body, audioEl, mime, onStart, signal) {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  audioEl.src = url;

  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer(mime);

  const reader = body.getReader();
  const queue = [];
  let done = false;
  let started = false;

  const pump = async () => {
    while (!done && !signal?.aborted) {
      const { value, done: d } = await reader.read();
      if (d) {
        done = true;
        break;
      }
      queue.push(value);
      drain();
    }
    if (signal?.aborted) {
      try {
        reader.cancel();
      } catch {
        /* noop */
      }
      return;
    }
    // flush
    await new Promise((r) => setTimeout(r, 0));
    drain();
    // When queue empty and upstream done, close.
    const closeWhenIdle = () => {
      if (queue.length === 0 && !sb.updating && ms.readyState === 'open') {
        try {
          ms.endOfStream();
        } catch {
          /* noop */
        }
      } else {
        setTimeout(closeWhenIdle, 30);
      }
    };
    closeWhenIdle();
  };

  const drain = () => {
    if (sb.updating || queue.length === 0) return;
    try {
      sb.appendBuffer(queue.shift());
    } catch (e) {
      console.warn('appendBuffer failed', e);
    }
  };
  sb.addEventListener('updateend', drain);

  // Kick playback once we have some data.
  audioEl.addEventListener(
    'canplay',
    () => {
      if (!started) {
        started = true;
        onStart?.();
        audioEl.play().catch((err) => console.warn('play() blocked', err));
      }
    },
    { once: true }
  );

  pump().catch((err) => console.warn('pump', err));

  await new Promise((resolve) => {
    const onEnd = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audioEl.addEventListener('ended', onEnd, { once: true });
    audioEl.addEventListener('error', onEnd, { once: true });
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          try {
            audioEl.pause();
          } catch {
            /* noop */
          }
          try {
            reader.cancel();
          } catch {
            /* noop */
          }
          onEnd();
        },
        { once: true }
      );
    }
  });
}

async function playViaBlob(resp, audioEl, onStart, signal) {
  const blob = await resp.blob();
  if (signal?.aborted) return;
  const url = URL.createObjectURL(blob);
  audioEl.src = url;
  onStart?.();
  await audioEl.play().catch((err) => console.warn('play() blocked', err));
  await new Promise((resolve) => {
    const onEnd = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audioEl.addEventListener('ended', onEnd, { once: true });
    audioEl.addEventListener('error', onEnd, { once: true });
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          try {
            audioEl.pause();
          } catch {
            /* noop */
          }
          onEnd();
        },
        { once: true }
      );
    }
  });
}
