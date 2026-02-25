# CallBuddyApp — Project Memory

## Overview
Telephone-based AI assistant. Makes **outgoing calls** via Twilio, converses with the user
using Claude (Anthropic) for intelligence, Deepgram for real-time STT, and OpenAI for TTS.
**Hard latency target: < 900ms** from end of user speech to first audio response byte.

---

## Architecture

```
User speaks on phone
  → Twilio captures audio (μ-law 8kHz mono)
    → WebSocket (Twilio Media Streams) → Our Server
      → Deepgram streaming STT          (~100–200ms)
        → Claude claude-sonnet-4-6 streaming LLM    (~200–400ms to first token)
          → sentence boundary detected
            → OpenAI TTS streaming          (~150–250ms to first audio)
              → μ-law encode → Twilio → User hears response
```

**Latency budget:** STT 150ms + LLM-first-sentence 350ms + TTS 200ms + network 100ms = ~800ms ✓

### Pipelining Strategy (critical for hitting <900ms)
- Do NOT wait for full LLM response before starting TTS
- Detect sentence boundaries in LLM stream (`. ! ?` followed by space)
- Send first complete sentence to TTS immediately
- Queue subsequent sentences and stream them back-to-back

---

## Tech Stack

| Layer     | Service / Library        | Reason |
|-----------|--------------------------|--------|
| Phone     | Twilio (Media Streams)   | Industry standard, WebSocket-based real-time audio |
| STT       | Deepgram (`@deepgram/sdk`) | Fastest streaming STT available, ~100–200ms latency |
| LLM       | Anthropic Claude claude-sonnet-4-6 | Primary AI, best reasoning |
| TTS       | OpenAI `tts-1` model     | Fast, natural, streaming support |
| Server    | Node.js + TypeScript     | Great WS support, all SDKs available |
| HTTP      | Express 4                | Simple, minimal |
| WebSocket | `ws` library             | Low-level, no overhead |
| Audio     | `mulaw` npm package      | μ-law ↔ PCM conversion for Twilio |
| Tunneling | ngrok (dev only)         | Expose localhost to Twilio |

**Why not OpenAI Realtime API?** It uses GPT-4o only — we want Claude for the LLM.
**Why not OpenAI Whisper for STT?** File-upload based, adds 400–800ms — too slow for target.
**Why Deepgram?** Only streaming STT that reliably hits <200ms on end-of-utterance.

---

## Project Structure

```
CallBuddyApp/
├── src/
│   ├── index.ts       # Entry: Express server + WS upgrade handler
│   ├── config.ts      # All env vars, validated at startup
│   ├── twilio.ts      # Outgoing call initiation + TwiML route
│   ├── stream.ts      # Twilio Media Stream WS handler (core orchestrator)
│   ├── stt.ts         # Deepgram streaming STT wrapper
│   ├── llm.ts         # Claude streaming LLM wrapper
│   └── tts.ts         # OpenAI TTS streaming wrapper
├── .env               # Local secrets (never commit)
├── .env.example       # Template (commit this)
├── package.json
├── tsconfig.json
└── CLAUDE.md          # This file
```

---

## Environment Variables

```
# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=      # E.164 format: +1xxxxxxxxxx

# Anthropic
ANTHROPIC_API_KEY=

# OpenAI
OPENAI_API_KEY=

# Deepgram
DEEPGRAM_API_KEY=

# Server
PORT=3000
SERVER_URL=               # Public URL (ngrok URL in dev, e.g. https://xxxx.ngrok.io)
```

---

## Audio Format Details

- **Twilio → Server**: μ-law encoded, 8kHz, 8-bit, mono, base64-encoded in JSON payload
- **Deepgram input**: Accepts raw μ-law 8kHz directly (set encoding=mulaw&sample_rate=8000)
- **OpenAI TTS output**: Returns PCM or MP3; we request `pcm` at 8kHz for lowest latency
- **Server → Twilio**: Must be μ-law 8kHz, base64-encoded, sent as `media` event over WS

**Conversion**: `mulaw` npm package handles PCM ↔ μ-law. OpenAI returns 24kHz PCM by default;
downsample to 8kHz before μ-law encoding (use simple linear interpolation in stream.ts).

---

## Key API Notes

### Twilio Media Streams
- TwiML: `<Stream url="wss://your-server/stream" />` inside `<Connect>`
- Server receives JSON events: `connected`, `start`, `media`, `stop`
- `media.payload` = base64 μ-law audio chunk (~20ms per chunk)
- To send audio back: emit `{"event":"media","streamSid":"...","media":{"payload":"..."}}`
- To end call: emit `{"event":"stop","streamSid":"..."}`

### Deepgram Streaming
- Connect via WebSocket to `wss://api.deepgram.com/v1/listen`
- Send raw audio bytes as binary WS frames
- Receive JSON transcription events; use `is_final: true` for confirmed utterances
- Key params: `model=nova-2`, `encoding=mulaw`, `sample_rate=8000`, `endpointing=300`
  (`endpointing=300` means 300ms silence = end of utterance, balances speed vs accuracy)

### Claude Streaming
- Use `anthropic.messages.stream()` with `model: 'claude-sonnet-4-6'`
- System prompt: set assistant persona and keep responses conversational (2–3 sentences)
- Stream text_delta events; accumulate until sentence boundary, then pipe to TTS

### OpenAI TTS Streaming
- Endpoint: `POST /v1/audio/speech` with `stream: true`
- Model: `tts-1` (faster than `tts-1-hd`), voice: `alloy` or `echo`
- Response format: `pcm` at 24000Hz (downsample to 8000Hz before sending to Twilio)
- Returns a readable stream of raw PCM audio bytes

---

## To-Do List

### Phase 1: Project Setup
- [x] Write CLAUDE.md with full architecture
- [ ] `npm init`, install all dependencies
- [ ] Create `tsconfig.json`
- [ ] Create `.env.example`
- [ ] Create `src/config.ts`

### Phase 2: Server Foundation
- [ ] Create `src/index.ts` — Express server + WS upgrade on `/stream`
- [ ] Create `src/twilio.ts` — POST `/call` to initiate outgoing call, GET `/twiml`
- [ ] Test: call initiates and Twilio connects to `/stream`

### Phase 3: Audio Pipeline
- [ ] Create `src/stt.ts` — Deepgram streaming STT, emits `transcript` events
- [ ] Create `src/llm.ts` — Claude streaming, emits `sentence` events on boundaries
- [ ] Create `src/tts.ts` — OpenAI TTS, returns PCM stream
- [ ] Create `src/stream.ts` — Orchestrates: Twilio audio → STT → LLM → TTS → Twilio

### Phase 4: Validation
- [ ] Add latency logging (timestamp: speech-end → first-audio-byte)
- [ ] Run ngrok, make real call, verify <900ms latency
- [ ] Tune `endpointing` and sentence detection as needed

---

## Latency Tuning Levers

1. `endpointing` in Deepgram: lower = faster but may cut off speech (try 200–400ms)
2. Sentence detection threshold: fire TTS on first clause, not full sentence
3. Claude system prompt: instruct it to keep responses SHORT (1–2 sentences)
4. TTS model: `tts-1` > `tts-1-hd` for speed; consider ElevenLabs Turbo as alternative
5. Audio chunk size: smaller Twilio chunks = lower buffering latency
6. Node.js: run in single-threaded async mode, avoid blocking operations

---

## Development Commands

```bash
npm run dev      # ts-node-esm src/index.ts with nodemon
npm run build    # tsc
npm start        # node dist/index.js

# Tunnel (separate terminal)
ngrok http 3000
# Copy HTTPS URL → set SERVER_URL in .env
```

---

## Decisions Log

| Date       | Decision | Reason |
|------------|----------|--------|
| 2026-02-25 | Use Deepgram for STT | Only option for <200ms streaming STT |
| 2026-02-25 | Use Claude claude-sonnet-4-6 as LLM | Best reasoning, user has Anthropic API |
| 2026-02-25 | Use OpenAI tts-1 for TTS | Fast streaming, user has OpenAI API |
| 2026-02-25 | Node.js + TypeScript | Strong WS support, all SDKs first-class |
| 2026-02-25 | Sentence-level TTS pipelining | Key to hitting sub-900ms target |
