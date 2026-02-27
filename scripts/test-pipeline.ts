/**
 * Automated pipeline latency tester.
 * Tests LLM × Cartesia voice combinations, saves WAV files, reports latency.
 * Usage: npm run test:pipeline
 */
import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import WebSocket from "ws";

const CARTESIA_KEY = process.env.CARTESIA_API_KEY!;
const OUT = "./test-output";
const MAX_AUDIO_BYTES = 8000 * 7; // 7 sec of μ-law @ 8kHz

if (!existsSync(OUT)) mkdirSync(OUT);

const SYSTEM = `You are Buddy, a concise AI phone assistant. Maximum 1 sentence, 15 words. No markdown or lists.`;

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "haiku",     provider: "anthropic" as const },
  { id: "gpt-4o-mini",               label: "gpt4o-mini", provider: "openai"    as const },
];

const VOICES = [
  { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", label: "blake" },
  { id: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", label: "theo"  },
];

const PROMPTS = [
  "Hey, how's it going?",
  "Can you help me schedule a meeting for 2pm tomorrow?",
];

// ── LLM streaming ─────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function* streamLLM(model: typeof MODELS[0], prompt: string): AsyncGenerator<string> {
  if (model.provider === "anthropic") {
    const stream = anthropic.messages.stream({
      model: model.id, max_tokens: 80, system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  } else {
    const stream = await openai.chat.completions.create({
      model: model.id, max_tokens: 80, stream: true,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) yield token;
    }
  }
}

// ── Cartesia streaming ────────────────────────────────────────────────────────

interface CartesiaChunk { data?: string; type?: string; error?: string; }

function streamCartesia(voiceId: string): {
  send: (text: string, cont: boolean) => void;
  audioChunks: () => AsyncGenerator<Buffer>;
  close: () => void;
} {
  const contextId = Math.random().toString(36).slice(2);
  const ws = new WebSocket("wss://api.cartesia.ai/tts/websocket", {
    headers: { "X-API-Key": CARTESIA_KEY, "Cartesia-Version": "2024-11-13" },
  });

  const queue: Buffer[] = [];
  let done = false;
  let resolve: (() => void) | null = null;
  const pending: Array<{ text: string; cont: boolean }> = [];
  let ready = false;

  ws.on("open", () => {
    ready = true;
    for (const p of pending) _send(p.text, p.cont);
    pending.length = 0;
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString()) as CartesiaChunk;
      if (msg.error) console.error("  [Cartesia]", msg.error);
      if (msg.data) { queue.push(Buffer.from(msg.data, "base64")); resolve?.(); resolve = null; }
      if (msg.type === "done") { done = true; ws.close(1000); resolve?.(); resolve = null; }
    } catch { /* ignore */ }
  });

  ws.on("close", (code) => {
    if (code !== 1000 && code !== 1005) console.error(`  [Cartesia] WS closed: ${code}`);
    done = true; resolve?.(); resolve = null;
  });

  ws.on("error", (err) => { console.error("  [Cartesia] WS error:", err.message); done = true; resolve?.(); resolve = null; });

  function _send(text: string, cont: boolean) {
    try {
      ws.send(JSON.stringify({
        model_id: "sonic-2", transcript: text, speed: 1.3,
        voice: { mode: "id", id: voiceId },
        output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
        context_id: contextId, continue: cont,
      }));
    } catch { /* closed */ }
  }

  return {
    send: (text, cont) => ready ? _send(text, cont) : pending.push({ text, cont }),
    close: () => { done = true; try { ws.close(1000); } catch { /* */ } resolve?.(); resolve = null; },
    audioChunks: async function* () {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(r => { resolve = r; });
      }
    },
  };
}

// ── WAV writer (μ-law) ────────────────────────────────────────────────────────

function toWav(data: Buffer): Buffer {
  const hdr = Buffer.alloc(46);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(38 + data.length, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(18, 16);       // chunk size (18 for MULAW)
  hdr.writeUInt16LE(7, 20);        // MULAW format
  hdr.writeUInt16LE(1, 22);        // mono
  hdr.writeUInt32LE(8000, 24);     // sample rate
  hdr.writeUInt32LE(8000, 28);     // byte rate
  hdr.writeUInt16LE(1, 32);        // block align
  hdr.writeUInt16LE(8, 34);        // bits per sample
  hdr.writeUInt16LE(0, 36);        // cbSize
  hdr.write("data", 38);
  hdr.writeUInt32LE(data.length, 42);
  return Buffer.concat([hdr, data]);
}

// ── Run one test ──────────────────────────────────────────────────────────────

interface Result {
  model: string; voice: string; prompt: string;
  msFirstToken: number; msFirstAudio: number; msTotal: number;
  text: string; file: string;
}

async function runTest(
  model: typeof MODELS[0],
  voice: typeof VOICES[0],
  prompt: string,
  idx: number,
): Promise<Result> {
  const label = `${model.label}_${voice.label}_p${idx + 1}`;
  process.stdout.write(`  Running ${label}... `);

  const t0 = Date.now();
  let msFirstToken = 0;
  let msFirstAudio = 0;
  let fullText = "";
  let wordBuf = "";
  let firstToken = true;

  const tts = streamCartesia(voice.id);
  const audioChunks: Buffer[] = [];
  let totalAudio = 0;

  // Collect audio in parallel
  const audioDone = (async () => {
    for await (const chunk of tts.audioChunks()) {
      if (!msFirstAudio) msFirstAudio = Date.now() - t0;
      audioChunks.push(chunk);
      totalAudio += chunk.length;
      if (totalAudio >= MAX_AUDIO_BYTES) { tts.close(); break; }
    }
  })();

  // Stream LLM → word-buffered → Cartesia
  for await (const token of streamLLM(model, prompt)) {
    if (firstToken) { msFirstToken = Date.now() - t0; firstToken = false; }
    fullText += token;
    wordBuf += token;
    if (/[\s,.!?;]/.test(token)) { tts.send(wordBuf, true); wordBuf = ""; }
  }
  if (wordBuf) tts.send(wordBuf, true);
  tts.send("", false); // signal end

  await audioDone;
  const msTotal = Date.now() - t0;

  const audio = Buffer.concat(audioChunks).slice(0, MAX_AUDIO_BYTES);
  const file = `${OUT}/${label}.wav`;
  writeFileSync(file, toWav(audio));

  console.log(`✓  first-token: ${msFirstToken}ms  first-audio: ${msFirstAudio}ms  total: ${msTotal}ms`);
  return { model: model.label, voice: voice.label, prompt, msFirstToken, msFirstAudio, msTotal, text: fullText, file };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔬 CallBuddy Pipeline Latency Test");
  console.log("════════════════════════════════════════\n");

  const results: Result[] = [];

  for (const model of MODELS) {
    for (const voice of VOICES) {
      console.log(`\n[${model.label.toUpperCase()} × ${voice.label}]`);
      for (let i = 0; i < PROMPTS.length; i++) {
        results.push(await runTest(model, voice, PROMPTS[i], i));
        await new Promise(r => setTimeout(r, 500)); // brief pause between tests
      }
    }
  }

  // ── Summary table ───────────────────────────────────────────────────────────
  console.log("\n\n════════════════════════════════════════════════════════════════");
  console.log("RESULTS SUMMARY");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`${"Model".padEnd(12)} ${"Voice".padEnd(8)} ${"First Token".padEnd(13)} ${"First Audio".padEnd(13)} ${"Total".padEnd(8)} Response`);
  console.log("─".repeat(90));

  for (const r of results) {
    const p = r.prompt.slice(0, 30).padEnd(30);
    console.log(
      `${r.model.padEnd(12)} ${r.voice.padEnd(8)} ${(r.msFirstToken + "ms").padEnd(13)} ${(r.msFirstAudio + "ms").padEnd(13)} ${(r.msTotal + "ms").padEnd(8)} "${r.text.slice(0, 40)}"`
    );
  }

  // Averages per model
  console.log("\n── Averages by LLM model ────────────────────────────────────────");
  for (const model of MODELS) {
    const rs = results.filter(r => r.model === model.label);
    const avg = (fn: (r: Result) => number) => Math.round(rs.reduce((a, r) => a + fn(r), 0) / rs.length);
    console.log(`${model.label.padEnd(12)} avg first-token: ${avg(r => r.msFirstToken)}ms  avg first-audio: ${avg(r => r.msFirstAudio)}ms`);
  }

  // Save report
  const report = results.map(r =>
    `${r.model},${r.voice},"${r.prompt}",${r.msFirstToken},${r.msFirstAudio},${r.msTotal},"${r.text}"`
  ).join("\n");
  writeFileSync(`${OUT}/results.csv`,
    "model,voice,prompt,ms_first_token,ms_first_audio,ms_total,response\n" + report
  );

  console.log(`\n✅ WAV files + results.csv saved to ${OUT}/`);
  console.log("════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
