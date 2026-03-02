import WebSocket from "ws";
import { config } from "./config.js";

const MODEL_ID = "eleven_flash_v2_5";
// ElevenLabs voice: "Charlie" — natural conversational American male
const VOICE_ID = "IKne3meq5aSn9XLyUdCD";

/**
 * One ElevenLabs streaming TTS session.
 * Send text tokens with send(), signal end with finish().
 * Consume μ-law 8kHz audio with audioChunks().
 */
export class ElevenLabsSession {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private isDone = false;
  private pendingResolve: (() => void) | null = null;
  private wsReady = false;
  private pending: Array<string | "__EOS__"> = [];

  constructor() {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=ulaw_8000&inactivity_timeout=180`;
    this.ws = new WebSocket(url, {
      headers: { "xi-api-key": config.elevenlabs.apiKey },
    });

    this.ws.on("open", () => {
      this.wsReady = true;
      // BOS — must be first message
      this.ws.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        generation_config: { chunk_length_schedule: [50] },
      }));
      for (const item of this.pending) this._dispatch(item);
      this.pending = [];
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          audio?: string;
          isFinal?: boolean;
          error?: string;
          message?: string;
        };
        if (msg.error || msg.message) console.error("[TTS] ElevenLabs error:", msg.error ?? msg.message);
        if (msg.audio) {
          this.queue.push(Buffer.from(msg.audio, "base64"));
          this._notify();
        }
        if (msg.isFinal) {
          this.isDone = true;
          this.ws.close(1000);
          this._notify();
        }
      } catch { /* ignore parse errors */ }
    });

    this.ws.on("close", (code) => {
      if (code !== 1000 && code !== 1005) console.error(`[TTS] ElevenLabs WS closed: ${code}`);
      this.isDone = true;
      this._notify();
    });

    this.ws.on("error", (err) => {
      console.error("[TTS] ElevenLabs WS error:", err);
      this.isDone = true;
      this._notify();
    });
  }

  /** Stream a text token. */
  send(text: string, _cont = true) {
    if (this.wsReady) this._dispatch(text);
    else this.pending.push(text);
  }

  /** Signal no more text — flushes remaining audio. */
  finish() {
    if (this.wsReady) this._dispatch("__EOS__");
    else this.pending.push("__EOS__");
  }

  /** Terminate early (on interrupt). */
  close() {
    this.isDone = true;
    this._notify();
    try { this.ws.close(1000); } catch { /* ignore */ }
  }

  /** Async generator yielding μ-law 8kHz audio chunks. */
  async *audioChunks(): AsyncGenerator<Buffer> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.isDone) break;
      await new Promise<void>(r => { this.pendingResolve = r; });
    }
  }

  private _dispatch(item: string | "__EOS__") {
    try {
      if (item === "__EOS__") {
        this.ws.send(JSON.stringify({ text: "" }));
      } else {
        this.ws.send(JSON.stringify({ text: item, try_trigger_generation: true }));
      }
    } catch { /* WS closed */ }
  }

  private _notify() {
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r();
    }
  }
}
