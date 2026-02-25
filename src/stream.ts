import WebSocket from "ws";
import { STT } from "./stt.js";
import { LLM } from "./llm.js";
import { streamTextToMulaw } from "./tts.js";

/**
 * Handles one Twilio Media Stream WebSocket session.
 * This is the core pipeline: audio in → STT → LLM → TTS → audio out.
 */
export function handleMediaStream(ws: WebSocket) {
  const stt = new STT();
  const llm = new LLM();
  let streamSid: string | null = null;
  let callStartTime = Date.now();

  // Track state to avoid overlapping responses
  let isResponding = false;
  let speechEndTime = 0;

  stt.start();

  // When STT has a complete utterance, send to LLM
  stt.on("transcript", async (text: string) => {
    if (isResponding) return; // Drop input while we're speaking
    speechEndTime = Date.now();
    console.log(`[PIPELINE] Speech ended → LLM responding to: "${text}"`);
    isResponding = true;
    try {
      await llm.respond(text);
    } catch (err) {
      console.error("[PIPELINE] LLM error:", err);
      isResponding = false;
    }
  });

  // When LLM emits a sentence, stream audio chunks to Twilio as they arrive
  llm.on("sentence", async (sentence: string) => {
    if (!streamSid) return;
    const sid = streamSid;
    const capturedSpeechEnd = speechEndTime;
    speechEndTime = 0;
    let firstChunk = true;

    for await (const chunk of streamTextToMulaw(sentence)) {
      if (firstChunk && capturedSpeechEnd > 0) {
        console.log(`[LATENCY] Speech→first-audio: ${Date.now() - capturedSpeechEnd}ms`);
        firstChunk = false;
      }
      sendAudio(ws, sid, chunk);
    }
  });

  llm.on("done", () => {
    isResponding = false;
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case "connected":
        console.log(`[STREAM] Connected — protocol: ${msg.protocol}`);
        break;

      case "start":
        streamSid = msg.streamSid as string;
        callStartTime = Date.now();
        console.log(`[STREAM] Media stream started — sid: ${streamSid}`);
        greet(ws, streamSid);
        break;

      case "media":
        // Forward raw μ-law audio to Deepgram
        const audio = Buffer.from(msg.media.payload, "base64");
        stt.send(audio);
        break;

      case "stop":
        console.log(`[STREAM] Call ended after ${Date.now() - callStartTime}ms`);
        stt.stop();
        break;
    }
  });

  ws.on("close", () => {
    stt.stop();
    console.log("[STREAM] WebSocket closed");
  });

  ws.on("error", (err) => {
    console.error("[STREAM] WebSocket error:", err);
    stt.stop();
  });
}

/** Send μ-law audio buffer back to Twilio in chunks */
function sendAudio(ws: WebSocket, streamSid: string, audio: Buffer) {
  // Twilio expects audio in base64-encoded chunks
  const CHUNK_SIZE = 160; // 20ms at 8kHz μ-law (160 bytes = 160 samples)
  for (let offset = 0; offset < audio.length; offset += CHUNK_SIZE) {
    const chunk = audio.subarray(offset, offset + CHUNK_SIZE);
    const payload = chunk.toString("base64");
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload },
        })
      );
    }
  }
}

/** Play an opening greeting, streaming audio as it arrives */
async function greet(ws: WebSocket, streamSid: string) {
  const greeting = "Hello! I'm Buddy, your AI assistant. How can I help you today?";
  for await (const chunk of streamTextToMulaw(greeting)) {
    sendAudio(ws, streamSid, chunk);
  }
}
