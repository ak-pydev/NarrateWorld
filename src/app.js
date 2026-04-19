// src/app.js — orchestration loop for NarrateMyWorld.
//
// Capture a frame → /api/describe → speak the description via /api/speak.
// Throttle: 1 request per 1.5 s (plan). If speech is still playing when the
// next tick fires, we skip that tick (no overlapping utterances) — unless a
// hazard is detected, in which case we interrupt the current utterance.

import { Camera } from './camera.js';
import { describeFrame, summarizeSession } from './gemini.js';
import { speak } from './elevenlabs.js';
import { labelFor, iconFor, normalizeContext } from './classifier.js';

const FRAME_INTERVAL_MS = 1500;
const FRAME_INTERVAL_MAX_MS = 6000; // adaptive back-off ceiling
const DEDUPE_THRESHOLD = 0.85;
const DEDUPE_WINDOW = 3; // compare against last N descriptions
const LANG_STORAGE_KEY = 'narrate.lang';
const SUPPORTED_LANGS = ['en', 'es', 'fr', 'zh', 'hi'];
const MAX_RETRIES = 2;
const SOFT_FALLBACK_TEXT = 'Unable to describe this frame.';

const els = {
  startStop: document.getElementById('start-stop'),
  voiceToggle: document.getElementById('voice-toggle'),
  describeDetail: document.getElementById('describe-detail'),
  langSelect: document.getElementById('lang-select'),
  status: document.getElementById('status-value'),
  context: document.getElementById('context-value'),
  modelPath: document.getElementById('model-path'),
  transcript: document.getElementById('transcript'),
  video: document.getElementById('camera-preview'),
  canvas: document.getElementById('capture-canvas'),
  audio: document.getElementById('audio-sink'),
  hazardLive: document.getElementById('hazard-live'),
  contextBadge: document.getElementById('context-badge'),
  contextBadgeIcon: document.getElementById('context-badge-icon'),
  contextBadgeLabel: document.getElementById('context-badge-label'),
  healthDot: document.getElementById('health-dot')
};

const STATUS_TO_HEALTH = {
  idle: 'idle',
  running: 'ok',
  'starting camera…': 'slow',
  'summarizing…': 'slow',
  stopped: 'idle',
  'camera error': 'error',
  'server unreachable': 'error',
  'missing server keys': 'error',
  'error (retrying)': 'error',
  offline: 'error',
  'reconnecting…': 'slow'
};

const camera = new Camera(els.video, els.canvas);

const state = {
  running: false,
  loopTimer: null,
  inflight: null, // AbortController for in-flight describe
  speakAc: null, // AbortController for the currently-speaking utterance (main loop)
  speaking: false,
  recentDescriptions: [], // sliding window for dedupe (last N)
  lastDescriptionAt: 0,
  wakeLock: null,
  voiceEnabled: false,
  recognition: null,
  sessionDescriptions: [], // collected for /api/summarize on Stop
  language: 'en',
  detailInflight: false,
  consecutiveErrors: 0, // for adaptive back-off
  currentInterval: FRAME_INTERVAL_MS, // adaptive interval
  online: navigator.onLine !== false, // network connectivity
  transitioning: false // prevents double-tap on start/stop
};

// --- UI helpers --------------------------------------------------------------

function setStatus(s) {
  els.status.textContent = s;
  if (els.healthDot) {
    els.healthDot.dataset.state = STATUS_TO_HEALTH[s] || 'ok';
  }
}

function setContext(c) {
  const norm = normalizeContext(c);
  els.context.textContent = labelFor(norm);
  if (els.contextBadge) {
    els.contextBadge.dataset.context = norm;
    els.contextBadge.setAttribute('aria-label', `Current context: ${labelFor(norm)}`);
    els.contextBadgeIcon.textContent = iconFor(norm);
    els.contextBadgeLabel.textContent = labelFor(norm);
  }
}

function setModelPath(p) {
  els.modelPath.textContent = p || '—';
}

// Build a DocumentFragment of a description with hazard spans highlighted.
function renderDescriptionWithHazards(text, hazards) {
  const frag = document.createDocumentFragment();
  if (!hazards || hazards.length === 0) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  // Build a regex that matches any hazard phrase (case-insensitive).
  const escaped = hazards
    .filter((h) => h && typeof h === 'string')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
    }
    const mark = document.createElement('mark');
    mark.className = 'hazard';
    mark.textContent = m[0];
    frag.appendChild(mark);
    lastIdx = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
  }
  if (lastIdx < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
  return frag;
}

function pushTranscript(text, meta, { hazards = [] } = {}) {
  const li = document.createElement('li');
  li.appendChild(renderDescriptionWithHazards(text, hazards));
  if (hazards && hazards.length > 0) {
    li.classList.add('has-hazard');
  }
  if (meta) {
    const span = document.createElement('span');
    span.className = 'meta';
    span.textContent = meta;
    li.appendChild(span);
  }
  els.transcript.prepend(li);
  while (els.transcript.children.length > 20) {
    els.transcript.removeChild(els.transcript.lastChild);
  }
}

function announceHazard(text) {
  if (!els.hazardLive) return;
  // Clear then set to retrigger assertive live region announcement.
  els.hazardLive.textContent = '';
  // Forced reflow to ensure screen readers pick up the change.
  // eslint-disable-next-line no-unused-expressions
  void els.hazardLive.offsetHeight;
  els.hazardLive.textContent = text;
}

// --- Dedupe (Jaccard over lowercased, punctuation-stripped word sets) -------

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Check against a sliding window of recent descriptions. */
function isDuplicate(text) {
  for (const prev of state.recentDescriptions) {
    if (jaccard(text, prev) > DEDUPE_THRESHOLD) return true;
  }
  return false;
}

function pushDedupe(text) {
  state.recentDescriptions.push(text);
  if (state.recentDescriptions.length > DEDUPE_WINDOW) {
    state.recentDescriptions.shift();
  }
}

// --- Adaptive interval -------------------------------------------------------
// Back off on consecutive errors to reduce server hammering; reset on success.

function onSuccess() {
  state.consecutiveErrors = 0;
  state.currentInterval = FRAME_INTERVAL_MS;
}

function onError() {
  state.consecutiveErrors++;
  // Exponential back-off: 1.5s → 3s → 6s (capped)
  state.currentInterval = Math.min(
    FRAME_INTERVAL_MS * Math.pow(2, state.consecutiveErrors),
    FRAME_INTERVAL_MAX_MS
  );
}

// --- Network connectivity ---------------------------------------------------

function handleOnline() {
  state.online = true;
  if (state.running) {
    setStatus('running');
    // Immediately try a tick if we were waiting
    scheduleNext(0);
  }
}

function handleOffline() {
  state.online = false;
  if (state.running) {
    setStatus('offline');
  }
}

window.addEventListener('online', handleOnline);
window.addEventListener('offline', handleOffline);

// --- Wake lock ---------------------------------------------------------------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    }
  } catch (err) {
    console.warn('Wake lock unavailable:', err);
  }
}

function releaseWakeLock() {
  try {
    state.wakeLock?.release?.();
  } catch {
    /* noop */
  }
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (state.running && document.visibilityState === 'visible' && !state.wakeLock) {
    requestWakeLock();
  }
});

// --- Hazard interrupt -------------------------------------------------------

function interruptCurrentSpeech() {
  // Abort the in-flight speak (if any), pause the audio element, and clear
  // src so the next speak starts cleanly.
  try {
    state.speakAc?.abort();
  } catch {
    /* noop */
  }
  state.speakAc = null;
  try {
    els.audio.pause();
  } catch {
    /* noop */
  }
  try {
    els.audio.removeAttribute('src');
    els.audio.load();
  } catch {
    /* noop */
  }
  state.speaking = false;
}

function triggerHazardFeedback() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([200, 50, 200]);
    }
  } catch {
    /* noop */
  }
}

// --- Retry helper -----------------------------------------------------------

async function describeWithRetry(frame, signal, opts, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await describeFrame(frame, signal, opts);
    } catch (err) {
      lastErr = err;
      // Don't retry on abort or client errors (4xx)
      if (err.name === 'AbortError') throw err;
      if (err.message?.includes('400') || err.message?.includes('413')) throw err;
      // Retry on 5xx / network errors with a brief delay
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// --- "Describe in detail" button --------------------------------------------

function setDetailButtonEnabled(enabled) {
  if (!els.describeDetail) return;
  els.describeDetail.disabled = !enabled;
  els.describeDetail.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

async function handleDescribeInDetail() {
  if (!state.running || state.detailInflight) return;
  state.detailInflight = true;
  els.describeDetail.disabled = true;
  els.describeDetail.setAttribute('aria-disabled', 'true');
  let frame;
  try {
    frame = camera.captureBase64Jpeg();
  } catch (err) {
    console.warn('detail capture failed', err);
    state.detailInflight = false;
    setDetailButtonEnabled(state.running);
    return;
  }
  const ac = new AbortController();
  try {
    const result = await describeWithRetry(frame, ac.signal, { mode: 'detailed', lang: state.language });
    const text = (result.description || '').trim();
    if (text && text !== SOFT_FALLBACK_TEXT) {
      pushTranscript(text, 'Detailed · on demand', { hazards: result.hazards || [] });
      // Claim the shared speak-state so the main-loop tick treats us as
      // "currently speaking" and skips its next turn instead of clobbering
      // our audio element. A hazard from the main loop can still interrupt
      // us via interruptCurrentSpeech(), which is the desired behavior.
      const detailAc = new AbortController();
      state.speakAc = detailAc;
      state.speaking = true;
      try {
        await speak(text, {
          audioEl: els.audio,
          signal: detailAc.signal,
          languageCode: state.language
        });
      } catch (err) {
        console.warn('detail speak failed', err);
      } finally {
        if (state.speakAc === detailAc || state.speakAc === null) {
          state.speaking = false;
          if (state.speakAc === detailAc) state.speakAc = null;
        }
      }
    }
  } catch (err) {
    console.warn('detail describe failed', err);
    pushTranscript(`Detail error: ${err.message}`);
  } finally {
    state.detailInflight = false;
    setDetailButtonEnabled(state.running);
  }
}

// --- Start / Stop -----------------------------------------------------------

async function start() {
  if (state.running || state.transitioning) return;
  state.transitioning = true;
  setStatus('starting camera…');
  try {
    await camera.start();
  } catch (err) {
    setStatus('camera error');
    pushTranscript(`Camera error: ${err.message}`, 'Check camera permissions in your browser.');
    await speakSafe('Camera permission denied or camera not available.');
    state.transitioning = false;
    return;
  }

  state.running = true;
  state.sessionDescriptions = [];
  state.recentDescriptions = [];
  state.consecutiveErrors = 0;
  state.currentInterval = FRAME_INTERVAL_MS;
  els.startStop.setAttribute('aria-pressed', 'true');
  els.startStop.setAttribute('aria-label', 'Stop narrating my surroundings');
  els.startStop.querySelector('.primary-btn-label').textContent = 'Stop narrating';
  setStatus('running');
  setDetailButtonEnabled(true);

  await requestWakeLock();
  await speakSafe('Narration started.');
  state.transitioning = false;
  scheduleNext(0);
}

async function stop() {
  if (!state.running || state.transitioning) return;
  state.transitioning = true;
  state.running = false;
  els.startStop.setAttribute('aria-pressed', 'false');
  els.startStop.setAttribute('aria-label', 'Start narrating my surroundings');
  els.startStop.querySelector('.primary-btn-label').textContent = 'Start narrating';
  setStatus('stopped');
  setDetailButtonEnabled(false);

  clearTimeout(state.loopTimer);
  state.loopTimer = null;
  state.inflight?.abort();
  state.inflight = null;
  interruptCurrentSpeech();
  camera.stop();
  releaseWakeLock();

  // Session summary.
  const descs = state.sessionDescriptions.slice(-10);
  state.sessionDescriptions = [];
  if (descs.length >= 3) {
    try {
      setStatus('summarizing…');
      const { summary } = await summarizeSession(descs, undefined, { lang: state.language });
      if (summary && summary.trim()) {
        pushTranscript(summary.trim(), 'Session summary');
        await speakSafe(summary.trim());
      }
    } catch (err) {
      console.warn('summary failed', err);
      // Silent on failure per spec.
    } finally {
      setStatus('idle');
    }
  } else {
    await speakSafe('Narration stopped.');
  }
  state.transitioning = false;
}

els.startStop.addEventListener('click', () => {
  if (state.running) stop();
  else start();
});

if (els.describeDetail) {
  els.describeDetail.addEventListener('click', handleDescribeInDetail);
}

// --- Main loop --------------------------------------------------------------

function scheduleNext(delay) {
  clearTimeout(state.loopTimer);
  state.loopTimer = setTimeout(tick, delay);
}

async function tick() {
  if (!state.running) return;

  // If offline, wait and retry.
  if (!state.online) {
    setStatus('offline');
    scheduleNext(state.currentInterval);
    return;
  }

  // Unlike before, we DON'T bail out early if speaking — we still run the
  // describe call so a hazard has a chance to interrupt the current audio.
  // Dedupe + hazard logic decides whether to actually speak.
  const wasSpeaking = state.speaking;

  const started = performance.now();
  const ac = new AbortController();
  state.inflight = ac;

  let frame;
  try {
    frame = camera.captureBase64Jpeg();
  } catch (err) {
    console.warn('capture failed', err);
    scheduleNext(state.currentInterval);
    return;
  }

  try {
    const result = await describeWithRetry(frame, ac.signal, { lang: state.language });
    const context = result.context;
    const description = result.description;
    const hazards = Array.isArray(result.hazards) ? result.hazards : [];
    const source = result.source || result.modelPath;

    setContext(context);
    setModelPath(source);

    const trimmed = (description || '').trim();

    // Skip soft-fallback responses entirely — don't speak them, don't show them.
    if (!trimmed || trimmed === SOFT_FALLBACK_TEXT) {
      onError(); // counts toward adaptive back-off
      scheduleNext(state.currentInterval);
      return;
    }

    onSuccess(); // reset adaptive interval on a good response

    const hasHazard = hazards.length > 0;

    // If we were already speaking and there's no hazard, skip this turn — we
    // neither interrupt nor queue non-urgent speech, matching the original
    // no-overlap behavior.
    if (wasSpeaking && !hasHazard) {
      scheduleNext(state.currentInterval);
      return;
    }

    // Dedupe against a sliding window — but only if there is NO hazard.
    // Hazards always get through.
    if (!hasHazard) {
      if (isDuplicate(trimmed)) {
        // Silent skip.
        scheduleNext(state.currentInterval);
        return;
      }
    }

    // Hazard interrupt — stop any current audio, vibrate, announce.
    if (hasHazard) {
      interruptCurrentSpeech();
      triggerHazardFeedback();
      announceHazard(trimmed);
    }

    pushTranscript(
      trimmed,
      `${labelFor(context)} · ${Math.round(performance.now() - started)}ms${hasHazard ? ' · ⚠ hazard' : ''}`,
      { hazards }
    );

    state.sessionDescriptions.push(trimmed);
    pushDedupe(trimmed);
    state.lastDescriptionAt = Date.now();

    const speakAc = new AbortController();
    state.speakAc = speakAc;
    state.speaking = true;
    try {
      await speak(trimmed, {
        audioEl: els.audio,
        signal: speakAc.signal,
        languageCode: state.language
      });
    } finally {
      // Only clear `speaking` if we're still the active utterance. A hazard
      // interrupt may have aborted us and started a new speak that's already
      // holding the speaking flag; don't clobber it.
      if (state.speakAc === speakAc || state.speakAc === null) {
        state.speaking = false;
        if (state.speakAc === speakAc) state.speakAc = null;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('tick error', err);
    onError();

    // Distinguish network errors from server errors for the user
    if (!navigator.onLine) {
      setStatus('offline');
    } else if (err.message?.includes('429')) {
      // Rate limited — don't alarm the user, just slow down silently
      setStatus('running');
    } else {
      setStatus('error (retrying)');
      pushTranscript(`Error: ${err.message}`);
    }
  } finally {
    state.inflight = null;
    if (state.running) {
      const elapsed = performance.now() - started;
      const wait = Math.max(0, state.currentInterval - elapsed);
      scheduleNext(wait);
      // Only set status to running if we're not in an error/offline state
      if (state.online && state.consecutiveErrors < 3) {
        setStatus('running');
      }
    }
  }
}

// --- Speak helper that never throws -----------------------------------------

async function speakSafe(text) {
  try {
    await speak(text, { audioEl: els.audio, languageCode: state.language });
  } catch (err) {
    console.warn('speakSafe failed:', err.message);
  }
}

// --- Language selector ------------------------------------------------------

function initLangSelect() {
  if (!els.langSelect) return;
  let stored = 'en';
  try {
    stored = localStorage.getItem(LANG_STORAGE_KEY) || 'en';
  } catch {
    /* noop — localStorage may be unavailable */
  }
  if (!SUPPORTED_LANGS.includes(stored)) stored = 'en';
  state.language = stored;
  els.langSelect.value = stored;
  document.documentElement.lang = stored;
  els.langSelect.addEventListener('change', () => {
    const v = els.langSelect.value;
    if (!SUPPORTED_LANGS.includes(v)) return;
    state.language = v;
    document.documentElement.lang = v;
    // Keep voice recognition in sync with the active language.
    if (state.recognition) {
      state.recognition.lang = v;
      // Restart recognition so the new language takes effect.
      if (state.voiceEnabled) {
        try { state.recognition.stop(); } catch { /* auto-restarts via 'end' handler */ }
      }
    }
    // Reset dedupe window so the first description in the new language is spoken.
    state.recentDescriptions = [];
    try {
      localStorage.setItem(LANG_STORAGE_KEY, v);
    } catch {
      /* noop */
    }
  });
}

// --- Voice commands ---------------------------------------------------------

function initVoiceCommands() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    els.voiceToggle.disabled = true;
    els.voiceToggle.querySelector('span').textContent = 'Voice commands: unsupported';
    return;
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = state.language || 'en-US';
  rec.addEventListener('result', (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.toLowerCase();
      if (/\b(start|begin|go)\b/.test(t) && !state.running) {
        start();
      } else if (/\b(stop|pause|quiet|silence)\b/.test(t) && state.running) {
        stop();
      } else if (/\b(detail|describe|look closer)\b/.test(t) && state.running) {
        handleDescribeInDetail();
      } else if (/\b(summary|summarize|recap)\b/.test(t) && state.running) {
        stop(); // stop triggers summary automatically when ≥3 descriptions
      }
    }
  });
  rec.addEventListener('end', () => {
    if (state.voiceEnabled) {
      // Restart with a small delay to prevent rapid-restart loops on error
      setTimeout(() => {
        if (state.voiceEnabled) {
          try {
            rec.start();
          } catch {
            /* ignore */
          }
        }
      }, 250);
    }
  });
  rec.addEventListener('error', (e) => {
    console.warn('voice error', e.error);
    // 'not-allowed' means user denied mic — disable voice toggle
    if (e.error === 'not-allowed') {
      state.voiceEnabled = false;
      els.voiceToggle.setAttribute('aria-pressed', 'false');
      els.voiceToggle.querySelector('span').textContent = 'Voice commands: denied';
    }
  });
  state.recognition = rec;
}

els.voiceToggle.addEventListener('click', () => {
  if (!state.recognition) return;
  state.voiceEnabled = !state.voiceEnabled;
  els.voiceToggle.setAttribute('aria-pressed', state.voiceEnabled ? 'true' : 'false');
  els.voiceToggle.querySelector('span').textContent =
    'Voice commands: ' + (state.voiceEnabled ? 'on' : 'off');
  try {
    if (state.voiceEnabled) state.recognition.start();
    else state.recognition.stop();
  } catch (err) {
    console.warn('voice toggle failed', err);
  }
});

// --- Boot --------------------------------------------------------------------

(async function boot() {
  initLangSelect();
  initVoiceCommands();
  setDetailButtonEnabled(false);
  setStatus('idle');

  // Pre-check network state
  if (!navigator.onLine) {
    setStatus('offline');
  }
})();
