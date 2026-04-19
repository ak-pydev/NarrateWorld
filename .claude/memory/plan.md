# NarrateMyWorld — Project Plan

> Real-time AI-powered audio descriptions for the visually impaired, using Gemini Vision, ElevenLabs TTS, and Featherless.ai model routing.

---

## Project Overview

NarrateMyWorld is a Progressive Web App (PWA) that streams a phone's camera feed to Gemini Vision, converts the scene description to natural speech via ElevenLabs, and routes to specialized open-source models on Featherless.ai depending on the detected context (transit, medical, retail, outdoor, etc.).

**Core Value Proposition:** A blind or low-vision user holds up their phone and hears a natural-language description of their surroundings within 1–2 seconds — no app install required.

---

## Team Roles

| Role | Responsibilities |
|------|-----------------|
| Frontend Engineer | PWA shell, camera capture, audio playback, UI |
| Backend Engineer | API orchestration, Featherless routing, caching layer |
| AI / Prompt Engineer | Gemini prompt tuning, context classifier, model selection logic |
| UX / Accessibility Lead | User testing with visually impaired users, voice UX design |

> For a hackathon: 2 engineers can cover all roles. Assign frontend+UX to one, backend+AI to the other.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | HTML/CSS/JS PWA | Camera access, audio output, offline shell |
| Vision AI | Gemini 1.5 Flash API | Scene description from camera frames |
| Voice | ElevenLabs Streaming TTS | Low-latency natural speech output |
| Model Routing | Featherless.ai API | Domain-specialized open-source LLMs |
| Context Classifier | Gemini Flash (lightweight prompt) | Detect environment: transit, medical, retail, outdoor |
| Hosting | Vercel / Cloudflare Pages | Edge deployment, HTTPS required for camera API |
| Backend | Node.js + Express (or Cloudflare Workers) | Proxy API keys, orchestrate calls |

---

## API Integration Summary

### Gemini Vision (Google AI)
- Model: `gemini-1.5-flash` (fast, multimodal)
- Input: Base64 image frame (~every 1.5s)
- Output: Short spatial description (2–3 sentences max)
- Key prompt instruction: *"Describe what a blind person needs to know to navigate this scene. Be concise. Prioritize hazards, people, text, and landmarks."*

### ElevenLabs TTS
- API: Streaming TTS endpoint (`/v1/text-to-speech/{voice_id}/stream`)
- Voice: Pre-selected calm, clear voice (e.g. Rachel or custom)
- Latency target: < 500ms from text to audio start
- Feature: Use `optimize_streaming_latency=4` parameter

### Featherless.ai Model Routing
- Purpose: After Gemini classifies the context, route to a specialized model for richer descriptions
- Example routing:
  - `transit` → Mistral-7B fine-tuned on navigation data
  - `medical` → Meditron or clinical Llama variant
  - `retail` → General Llama 3 8B (product/menu reading)
  - `outdoor` → Default Gemini Flash (best for general scenes)
- All models served via Featherless OpenAI-compatible API

---

## MVP Scope (Hackathon Build)

The MVP targets a 24-hour build window. Features are ruthlessly scoped.

### In Scope
- Camera frame capture every 1.5 seconds via `getUserMedia`
- Send frame to Gemini Flash for scene description
- Stream description audio via ElevenLabs TTS
- Basic context detection (4 categories: transit, medical, retail, outdoor)
- Featherless routing for transit and retail contexts
- PWA manifest (installable, works on iOS Safari + Android Chrome)
- On-screen live transcript of what was described
- Single large "Start / Stop" button (accessible, voice-activated option)

### Out of Scope (post-hackathon)
- User accounts / saved sessions
- Offline model inference
- Custom voice training
- Multi-language support
- Wearable / AR glasses integration
- Native iOS / Android app

---

## Key Constraints and Risks

| Constraint | Mitigation |
|-----------|-----------|
| Camera API requires HTTPS | Deploy to Vercel/Cloudflare from hour 1 |
| ElevenLabs latency | Use streaming endpoint + buffer audio chunks |
| Gemini rate limits | Cache repeated scene types; throttle to 1 req/1.5s |
| Featherless cold starts | Pre-warm by sending dummy request at app load |
| Frame too large, slow upload | Resize to 512x512 before base64 encoding |
| API keys exposed in frontend | All keys live server-side; frontend hits own backend proxy |

---

## Success Metrics (Demo Day)

- End-to-end latency (camera to audio) under 2 seconds
- Correct context detection in 3 out of 4 test environments
- Live demo runs for 5 minutes without crash
- Judges can use it themselves in 30 seconds with no instructions

---

## Accessibility Commitments

- No touch required: large tap zones (min 64x64px), voice-activated start/stop
- Screen reader compatible UI with ARIA labels on all controls
- High-contrast UI with dark mode default
- Audio-only mode: screen can be off while app runs

---

## Development Environment Setup

```bash
# Clone repo
git clone https://github.com/your-org/narratemyworld
cd narratemyworld

# Install dependencies
npm install

# Create .env file with the following keys:
# GEMINI_API_KEY=your_key
# ELEVENLABS_API_KEY=your_key
# ELEVENLABS_VOICE_ID=your_voice_id
# FEATHERLESS_API_KEY=your_key

# Run dev server (HTTPS required for camera)
npm run dev -- --https
```

---

## Folder Structure

```
narratemyworld/
├── public/
│   ├── index.html          # PWA shell
│   ├── manifest.json       # PWA manifest
│   └── sw.js               # Service worker (offline shell)
├── src/
│   ├── camera.js           # getUserMedia, frame capture, resize
│   ├── gemini.js           # Gemini Vision API client
│   ├── elevenlabs.js       # TTS streaming client
│   ├── featherless.js      # Model routing client
│   ├── classifier.js       # Context detection logic
│   └── app.js              # Main orchestration loop
├── server/
│   ├── index.js            # Express proxy server
│   └── routes/
│       ├── describe.js     # /api/describe endpoint
│       └── speak.js        # /api/speak endpoint
├── .env
└── package.json
```

---

## High-Impact Ideas

> Prioritized by **demo impact × implementation speed**. Tier 1 = do during the hackathon. Tier 2 = if time allows. Tier 3 = post-hackathon growth levers.

### Tier 1 — High impact, low effort (implement now)

#### 1. Hazard-First Priority Queue
Before sending a frame description to TTS, run a lightweight regex/keyword check on Gemini's output for danger words (`step`, `stairs`, `car`, `dog`, `wet floor`, `person approaching`, etc.). If a hazard is detected, skip the queue and interrupt any current audio immediately with the alert. **Demo impact:** judges see the app proactively warn about danger, not just describe art.

#### 2. Smart De-duplication — "Only speak what changed"
Compute a cosine similarity between the current Gemini embedding and the previous one (store last description text). If similarity > 0.85 → skip TTS. This makes the narration feel intelligent instead of a noisy ticker. **Demo impact:** app goes quiet when user stands still; speaks the moment something changes.

#### 3. Object Distance Estimation (monocular depth cue)
Add a prompt modifier: *"Estimate relative distance: far (>5 m), mid (1–5 m), near (<1 m). Prefix each object with its distance tag."* No extra API call — just prompt engineering. **Demo impact:** user hears "Near: fire hydrant. Mid: parked car. Far: crosswalk" — immediately useful for navigation.

#### 4. Confidence-Gated Featherless Routing
Only invoke the specialized Featherless model when Gemini's context classifier confidence string contains `"high"`. Otherwise fall back to Gemini's own description. Eliminates Featherless latency spikes on ambiguous frames and keeps the demo fast.

#### 5. Haptic Pulse on Hazard (mobile only)
Call `navigator.vibrate([200, 50, 200])` whenever a hazard keyword fires. Zero extra latency, zero extra API calls. **Demo impact:** multisensory — judges feel the alert in their hand.

#### 6. "What is this?" One-Tap Deep Dive
Add a floating button: "Describe in detail". On tap, send the current frame to Gemini with an enriched prompt: *"Give a detailed description including any text you can read, brand names, distances, and recommended next action for a blind user."* Speaks only once; does not interrupt the loop. Great for judges to interact with.

---

### Tier 2 — Medium effort, strong judging signal

#### 7. Real-Time Transcript with Hazard Highlights
The existing on-screen transcript is plain text. Wrap hazard-keyword spans in a red highlight with a pulse animation. Judges watching the screen can immediately see why the app spoke urgently. Keep the DOM update off the main audio path (requestAnimationFrame).

#### 8. Context Badge in UI
Show a live pill badge: `🚌 Transit` / `🏥 Medical` / `🛒 Retail` / `🌳 Outdoor` / `🏙 General` that updates with each frame. Judges love seeing the classifier work in real-time. One extra `<div>` and CSS; context is already returned in the `/api/describe` response.

#### 9. Session Summary (EoS Audio)
When the user presses Stop, POST the last 10 descriptions to Gemini with: *"Summarize the journey this person just took in 2 sentences."* Read the summary aloud. **Demo impact:** memorable ending — "You walked through a busy intersection, past a coffee shop, and into a building lobby."

#### 10. Adaptive Frame Rate Based on Motion
Use the `ImageCapture` API or diff two consecutive frames pixel-by-pixel (in a Web Worker). High motion → 0.8 s interval. Static scene → 3 s interval. This cuts API costs by ~40 % in typical indoor use and keeps latency tight when things move.

#### 11. Emergency SOS Mode
Long-press the Stop button (800 ms) → vibrate once + read aloud current GPS coordinates (Geolocation API) + copy them to clipboard. If the user says "help" into the mic (Speech API), trigger the same flow. Zero extra APIs, massive safety value proposition.

#### 12. Multi-Language Output (one-line toggle)
ElevenLabs supports language override via `language_code`. Add a language selector (EN / ES / FR / ZH / HI). Pass `language_code` in the TTS POST body. Gemini output stays in English internally; only the spoken audio changes. **Demo impact:** shows global reach with 2 lines of code change.

---

### Tier 3 — Post-hackathon growth levers

#### 13. Personalized Scene Memory (vector store)
Store description embeddings in Firestore with a vector index. When the user returns to a known location (matched by GPS + embedding similarity), the app says *"You've been here before — last time there was a food cart on the left."* Requires Firestore vector search (preview API) + GPS.

#### 14. Caregiver Dashboard
Real-time stream of session transcripts + GPS trace to a companion web app. Caregiver sees where the user is and what they're being narrated. WebSocket channel through Firebase Realtime Database.

#### 15. AR Glasses / Smart Glasses Integration
Replace the phone camera with a WebXR stream from Ray-Ban Meta or Envision Glasses (both have camera API access). The PWA shell already works headlessly — just swap the `getUserMedia` source.

#### 16. Fine-Tuned Featherless Model for Navigation
Collect the session transcripts as training data → fine-tune a Mistral 7B on navigation-specific descriptions via Featherless's fine-tune endpoint. Over time the model learns the user's city/building layout.

#### 17. Braille Display Output
Connect via Web Bluetooth to a refreshable Braille display (HID profile). Stream description text one sentence at a time. Already possible in Chrome on Android; no native app needed.

---

### Quick Wins Checklist (copy-paste ready)

- [ ] Add `HAZARD_KEYWORDS` array to `classifier.js` and emit `hazard` event
- [ ] Wire `navigator.vibrate` to `hazard` event in `app.js`
- [ ] Add cosine similarity check in `app.js` before each TTS call (use `@xenova/transformers` embeddings or simple Jaccard as a proxy)
- [ ] Add distance-estimation prompt modifier in `functions/lib/gemini.js`
- [ ] Add context badge `<div id="context-badge">` to `public/index.html` + CSS
- [ ] Wire badge update from `/api/describe` response in `src/app.js`
- [ ] Add "What is this?" button to `public/index.html` + handler in `src/app.js`
- [ ] Add language selector `<select id="lang-select">` + pass to `/api/speak`
- [ ] Long-press handler on stop button → read GPS coords
- [ ] Session summary: collect descriptions array, POST on stop, speak result

---

*Plan version 1.1 — NarrateMyWorld Hackathon Build + High-Impact Ideas*
