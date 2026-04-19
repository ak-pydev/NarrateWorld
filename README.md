

# NarrateMyWorld

Real-time AI audio descriptions of your surroundings for blind and low-vision
users. A Progressive Web App that streams phone camera frames to Gemini Vision,
routes by detected context through Featherless.ai specialized models, and
speaks descriptions via ElevenLabs streaming TTS. No install required.

See `.claude/memory/plan.md` for the full hackathon plan and `CLAUDE.md` for
load-bearing architectural rules.

## Architecture

```
Phone camera ─► frame @ 1.5s ─► POST /api/describe ─► Gemini Flash
                                        │                  │ classify + describe (single call)
                                        │                  ▼
                                        │            if transit|retail:
                                        │              POST Featherless (domain model)
                                        │                  │
                                        ▼                  ▼
                                  { context, description, modelPath }
                                        │
                   POST /api/speak ◄────┘
                       │
                       ▼
         ElevenLabs /v1/text-to-speech/{voice}/stream
         optimize_streaming_latency=4 ─► chunked audio/mpeg
                       │
                       ▼
            MediaSource buffered playback
```

- **Static PWA** in `public/` (+ client modules in `src/`, copied into
  `public/src/` at predeploy time), served by **Firebase Hosting**.
- **Backend proxy** is two **Cloud Functions (2nd gen)** — `describe` and
  `speak` — in `functions/`. They hold the only copies of the API keys
  (Secret Manager). The frontend talks to `/api/describe` and `/api/speak`,
  which Hosting rewrites onto the functions.
- **Throttle:** 1 request / 1.5 s client-side; an in-process safety-net rate
  limit (2 req / 2 s) guards against client bugs.
- **HTTPS** is provided by Firebase Hosting in prod and by the Firebase
  emulator suite locally — no self-signed cert dance any more.

## Project layout

```
firebase.json          hosting + functions config + rewrites
.firebaserc            default project
public/                PWA shell, manifest, service worker, icons, styles
src/                   Client JS modules (camera, app loop, API wrappers)
public/src/            Generated copy of src/ used by Hosting (gitignored)
functions/
  package.json         Functions runtime deps (firebase-functions v6, admin v12)
  index.js             Exports `describe` + `speak` as 2nd-gen onRequest fns
  lib/gemini.js        Gemini Flash client (classify + describe in one call)
  lib/featherless.js   OpenAI-compatible client + per-context routing
  lib/elevenlabs.js    Streaming TTS passthrough
scripts/sync-src.js    Copies src/ into public/src/ (predeploy + dev)
SECRETS.md             How to set Gemini / ElevenLabs / Featherless keys
```

## Local dev

Prereqs: Node 20+, `firebase` CLI logged in (`firebase login`).

1. Create `functions/.secret.local` (gitignored) with one `KEY=value` per line:
   ```
   GEMINI_API_KEY=...
   ELEVENLABS_API_KEY=...
   ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
   FEATHERLESS_API_KEY=...
   ```
   The Firebase emulator auto-loads this file. `functions/.env` works too.

2. Install dependencies in both the root and `functions/`:
   ```bash
   npm install
   cd functions && npm install && cd ..
   ```

3. Start the emulators:
   ```bash
   npm run dev
   ```
   - Hosting: <http://localhost:5000>
   - Functions emulator: <http://localhost:5001>
   - Emulator UI: <http://localhost:4000>

   `npm run dev` runs `scripts/sync-src.js` first so the latest `src/*.js` is
   served at `/src/*` by Hosting.

> **Camera + localhost:** browsers treat `http://localhost` as a secure
> context, so `getUserMedia` works fine on your dev machine. To test on a
> phone over LAN you need real HTTPS — easiest path is to deploy to a Firebase
> Hosting preview channel (`firebase hosting:channel:deploy preview`) or
> tunnel the emulator through `ngrok http 5000`.

## Deploy

1. `firebase login` (one time).
2. Set the three secrets (see `SECRETS.md`):
   ```bash
   firebase functions:secrets:set GEMINI_API_KEY      --project=gen-lang-client-0465055337
   firebase functions:secrets:set ELEVENLABS_API_KEY  --project=gen-lang-client-0465055337
   firebase functions:secrets:set FEATHERLESS_API_KEY --project=gen-lang-client-0465055337
   ```
3. Deploy:
   ```bash
   npm run deploy             # hosting + functions
   # or
   npm run deploy:hosting     # static-only iteration
   npm run deploy:functions   # backend-only iteration
   ```

Hosted URL: `https://gen-lang-client-0465055337.web.app` (and
`*.firebaseapp.com`).

Tail logs with `npm run logs`.

## Cost / latency tradeoff

Both functions are configured with `minInstances: 1`. This is **required** to
hit the camera-to-audio < 2 s budget — cold starts on Cloud Run-backed
2nd-gen functions add 2–4 s and would blow the latency promise. The
operational cost is roughly **~$5/mo per warm instance**, so plan on
**~$10/mo** baseline for the two functions plus per-request CPU/memory and
egress on top. If demoing only intermittently you can drop `minInstances`
to 0 and accept first-frame latency, but do not do that for a live demo.

## Key pages / routes

| Path | What it is |
|------|------------|
| `/` | PWA shell |
| `/manifest.json` | Installable app manifest |
| `/sw.js` | Service worker (caches shell, never caches `/api/*`) |
| `/src/*.js` | Client modules (mirrored from `src/` by `sync-src.js`) |
| `/api/describe` | POST `{imageBase64, mimeType}` → `{context, description, modelPath}` (Cloud Function `describe`) |
| `/api/speak` | POST `{text, voiceId?}` → streamed `audio/mpeg` (Cloud Function `speak`) |

## Accessibility

- Every control has an ARIA label and an `aria-pressed` state where applicable.
- Tap targets are ≥ 64×64 px; the primary button is larger.
- Dark mode default; `prefers-contrast: more` bumps to full-contrast.
- Voice commands ("start" / "stop") work alongside the button — toggle via the
  secondary button.
- Wake Lock keeps the screen from sleeping while narrating. Audio continues if
  the screen does sleep.
- Live transcript is an `aria-live="polite"` region so screen readers announce
  new descriptions.

## Scope

Explicitly out of scope (per `plan.md`): user accounts, offline inference,
custom voice training, multi-language, wearables, native apps.

## Known limitations

- iOS Safari does not support `MediaSource` for `audio/mpeg` — the client
  falls back to Blob playback (audio starts slightly later, same final
  result).
- The Web Speech API for voice commands is Chrome / Edge / Android only. The
  voice-command button disables itself on unsupported browsers; the primary
  button still works.
- Featherless cold starts can spike first-request latency. `prewarmFeatherless`
  exists in `functions/lib/featherless.js` but is not invoked automatically;
  wire it into a 1st-request hook if you see stalls in the demo.
