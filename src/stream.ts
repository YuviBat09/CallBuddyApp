import WebSocket from "ws";
import { appendFileSync, existsSync } from "fs";
import { STT } from "./stt.js";
import { LLM } from "./llm.js";
import { CartesiaSession } from "./tts.js";

const CSV_PATH = "./latency.csv";
if (!existsSync(CSV_PATH)) {
  appendFileSync(CSV_PATH,
    "timestamp,call_sid,user_text,llm_model,ms_speech_to_first_token,ms_speech_to_last_token,ms_total_response,interrupted\n"
  );
}

function appendLatency(row: {
  callSid: string; userText: string; msFirstToken: number;
  msLastToken: number; msTotal: number; interrupted: boolean;
}) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  appendFileSync(CSV_PATH,
    [new Date().toISOString(), esc(row.callSid), esc(row.userText), "claude-haiku-4-5",
      row.msFirstToken, row.msLastToken, row.msTotal, row.interrupted ? 1 : 0].join(",") + "\n"
  );
}

function parseInstruction(speech: string): string | null {
  const match = speech.trim().match(/^okay[,.\s]+claude[,.]?\s*/i);
  return match ? speech.trim().slice(match[0].length).trim() : null;
}

const GREETING = "Hey, it's Buddy. What's up?";

export function handleMediaStream(ws: WebSocket) {
  const llm = new LLM();
  const stt = new STT();
  let streamSid = "";
  let callSid = "unknown";
  let currentTts: CartesiaSession | null = null;
  let isResponding = false;

  // ── STT → LLM → TTS pipeline ──────────────────────────────────────────────
  stt.on("transcript", async (text: string) => {
    // Interrupt any in-progress response
    if (isResponding && currentTts) {
      currentTts.close();
      currentTts = null;
      isResponding = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      }
    }

    isResponding = true;
    const t0 = Date.now();
    console.log(`[PIPELINE] User: "${text}"`);

    // Layer 1: LLM connect + first token
    const ttsCreatedAt = Date.now();
    const tts = new CartesiaSession();
    const ttsInitMs = Date.now() - ttsCreatedAt;
    currentTts = tts;
    void pipeAudio(tts, t0);

    let firstToken = true;
    let fullText = "";
    let wordBuf = "";
    let msFirstToken = 0;
    let msLastToken = 0;
    let msLlmConnect = 0;

    try {
      for await (const token of llm.stream(text)) {
        if (tts !== currentTts) break;
        if (firstToken) {
          msLlmConnect = Date.now() - t0;
          msFirstToken = msLlmConnect;
          console.log(`[LAYER] STT→LLM first token:  ${msLlmConnect}ms`);
          console.log(`[LAYER] Cartesia WS init:      ${ttsInitMs}ms (parallel)`);
          firstToken = false;
        }
        fullText += token;
        wordBuf += token;
        // Flush to Cartesia on word boundaries — avoids sending subword fragments
        if (/[\s,.!?;]/.test(token)) {
          tts.send(wordBuf, true);
          wordBuf = "";
        }
      }
      if (wordBuf) tts.send(wordBuf, true); // flush remainder
      msLastToken = Date.now() - t0;
      console.log(`[LAYER] LLM full response:     ${msLastToken - msLlmConnect}ms  (${msLastToken}ms total)`);
    } catch (err) {
      console.error("[LLM] Error:", err);
    } finally {
      if (tts === currentTts) {
        tts.finish();
        const msTotal = Date.now() - t0;
        if (fullText) appendLatency({ callSid, userText: text, msFirstToken, msLastToken, msTotal, interrupted: false });
      } else {
        if (fullText) appendLatency({ callSid, userText: text, msFirstToken, msLastToken, msTotal: Date.now() - t0, interrupted: true });
      }
      isResponding = false;

      const instruction = parseInstruction(text);
      if (instruction) console.log(`[INSTRUCTION] ${callSid} "${instruction}"`);
    }
  });

  // ── Pipe Cartesia audio → Twilio ───────────────────────────────────────────
  async function pipeAudio(tts: CartesiaSession, t0: number) {
    let firstChunk = true;
    for await (const chunk of tts.audioChunks()) {
      if (tts !== currentTts) break;
      if (firstChunk) {
        const msAudio = Date.now() - t0;
        console.log(`[LAYER] First token→first audio: (Cartesia) ~${msAudio}ms total`);
        console.log(`[LAYER] ─────────────────────────────────────`);
        console.log(`[LAYER] TOTAL speech→caller hears: ~${msAudio}ms`);
        firstChunk = false;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }));
      }
    }
  }

  // ── Play greeting on connect ───────────────────────────────────────────────
  function sendGreeting() {
    const tts = new CartesiaSession();
    currentTts = tts;
    void pipeAudio(tts, Date.now());
    tts.send(GREETING, false);
  }

  // ── Twilio Media Stream events ─────────────────────────────────────────────
  ws.on("message", (data: WebSocket.RawData) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;

    switch (msg.event as string) {
      case "connected":
        console.log("[RELAY] Media stream connected");
        break;

      case "start": {
        const start = msg.start as Record<string, string>;
        streamSid = start.streamSid;
        callSid = start.callSid ?? "unknown";
        console.log(`[RELAY] Call started — sid: ${callSid}`);
        console.log(`[CALL_START] ${callSid}`);
        stt.start();
        sendGreeting();
        break;
      }

      case "media": {
        const media = (msg.media as Record<string, string>);
        const audio = Buffer.from(media.payload, "base64");
        stt.send(audio);
        break;
      }

      case "stop":
        console.log("[RELAY] Call ended");
        stt.stop();
        currentTts?.close();
        break;
    }
  });

  ws.on("close", () => {
    console.log("[RELAY] WebSocket closed");
    stt.stop();
    currentTts?.close();
  });
  ws.on("error", (err) => console.error("[RELAY] WS error:", err));
}
