# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Scaffolded end-to-end. Backend migrated from Express to **Firebase Cloud Functions (2nd gen) + Firebase Hosting**. Source of truth for scope is `.claude/memory/plan.md`; architectural rules here override plan wording where they conflict.

Firebase project: `gen-lang-client-0465055337` (display name "NarrateWorld"). Region `us-central1`. Billing enabled.

## Project: NarrateMyWorld

A Progressive Web App that streams a phone's camera feed to Gemini Vision, converts scene descriptions to speech via ElevenLabs TTS, and routes to specialized open-source models on Featherless.ai based on detected context (transit, medical, retail, outdoor). Target user: blind / low-vision people who want a live audio description of their surroundings with no app install.

## Planned Architecture

Static PWA frontend served by Firebase Hosting + two Cloud Functions (2nd gen) behind Hosting rewrites. Key architectural rules — load-bearing, do not bypass without updating this file:

- **All third-party API keys live in Firebase Secret Manager** (via `firebase functions:secrets:set`). Frontend never calls Gemini, ElevenLabs, or Featherless directly; it hits `/api/describe` and `/api/speak`, which Hosting rewrites to the `describe` and `speak` functions.
- **Frame throttling is ~1 request / 1.5 s.** Camera frames are captured on an interval, resized to 512×512 before base64 encoding, then sent to the backend. Do not raise the cadence without revisiting Gemini rate-limit mitigation.
- **Two-stage model pipeline.** Gemini Flash classifies context and describes the scene in a single JSON response; for `transit` / `retail` the description is re-routed through Featherless to a domain-specialized model. `outdoor` and `medical` use Gemini's description directly.
- **TTS uses the streaming endpoint** (`/v1/text-to-speech/{voice_id}/stream`) with `optimize_streaming_latency=4`. End-to-end latency budget: camera → audio < 2 s. Streaming passthrough from function to client (`res.flushHeaders()`, `X-Accel-Buffering: no`), not wait-for-complete.
- **`minInstances: 1` on both functions** to stay within the <2s latency budget. Cold starts otherwise blow the budget by 1–2s. Cost is ~$10/mo for two warm instances — documented tradeoff.
- **HTTPS is automatic** via Hosting and emulator. No self-signed certs needed.

Folder layout: `public/` is the Hosting root (PWA shell, manifest, service worker); `src/` holds the client modules (camera/gemini/elevenlabs/app) and is copied into `public/src/` by `scripts/sync-src.js` as a Hosting predeploy step; `functions/` holds the Cloud Functions code (`index.js` + `lib/`).

## Secrets & Environment

Production secrets live in Firebase Secret Manager (bound to functions via the `secrets: [...]` option):

- `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `FEATHERLESS_API_KEY` — set once per environment with `firebase functions:secrets:set <NAME>`.

Non-secret, overridable config lives as plain env vars (defaults baked into `functions/lib/*`):

- `ELEVENLABS_VOICE_ID`, `GEMINI_MODEL`, `FEATHERLESS_MODEL_TRANSIT`, `FEATHERLESS_MODEL_RETAIL`, `FEATHERLESS_MODEL_MEDICAL`.

Local emulator reads secrets from `functions/.secret.local` (one `KEY=value` per line, gitignored). Do not commit. See `SECRETS.md`.

## Commands

```bash
# First time
npm install && (cd functions && npm install)

# Local dev (Hosting http://localhost:5000, emulator UI http://localhost:4000)
npm run dev

# Deploy
npm run deploy              # hosting + functions
npm run deploy:hosting      # static only
npm run deploy:functions    # backend only

# Logs
npm run logs
```

No lint/test harnesses yet — add them alongside the first test rather than assuming conventions.

## Accessibility Requirements (non-negotiable)

This is a tool for blind / low-vision users, so accessibility is a correctness requirement, not polish:

- Tap targets ≥ 64×64 px; voice-activated start/stop alongside touch.
- ARIA labels on every control; screen-reader-compatible at all times.
- High-contrast, dark-mode default.
- Audio-only mode — app must keep running with the screen off.

When building UI, verify against these before calling a feature done.

## MVP Scope Discipline

The plan is explicit about what is **out of scope** for the hackathon build: user accounts, offline inference, custom voice training, multi-language, wearables, native apps. Resist scope creep into these — flag it instead.
