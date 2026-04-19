# Secrets

NarrateMyWorld talks to three paid APIs from the server side only. Keys are
stored in Google Secret Manager and injected into the Cloud Functions runtime
by Firebase. The frontend never sees them.

## Production: set in Secret Manager via Firebase

Run once per key. Each command will prompt for the value (it is not echoed).

```bash
firebase functions:secrets:set GEMINI_API_KEY      --project=gen-lang-client-0465055337
firebase functions:secrets:set ELEVENLABS_API_KEY  --project=gen-lang-client-0465055337
firebase functions:secrets:set FEATHERLESS_API_KEY --project=gen-lang-client-0465055337
```

To inspect / rotate:

```bash
firebase functions:secrets:access GEMINI_API_KEY   --project=gen-lang-client-0465055337
firebase functions:secrets:destroy GEMINI_API_KEY  --project=gen-lang-client-0465055337  # then re-set
```

The functions in `functions/index.js` declare these via `defineSecret(...)` and
list them in each `onRequest` config's `secrets:` array, so Firebase grants the
function's runtime service account `roles/secretmanager.secretAccessor` on the
relevant secrets at deploy time.

## Non-secret env vars

`ELEVENLABS_VOICE_ID`, `GEMINI_MODEL`, and the three `FEATHERLESS_MODEL_*`
overrides are not sensitive. Set them in `functions/.env` (committed defaults
are fine) or in `functions/.env.<projectId>` for project-specific overrides.

## Local development (Firebase emulator)

The Firebase emulator picks up secrets from either:

1. `functions/.env` — standard dotenv format.
2. `functions/.secret.local` — only loaded by the emulator, never deployed.

Both are gitignored. Create `functions/.secret.local` with one `KEY=value` per
line:

```
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
FEATHERLESS_API_KEY=...
```

Then `npm run dev` from the repo root.

## What never to commit

`.env`, `functions/.env`, `functions/.env.local`, `functions/.secret.local`,
`functions/.runtimeconfig.json`, anything under `.firebase/`. All covered by
`.gitignore`.
