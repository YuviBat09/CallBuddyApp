import WebSocket from "ws";
import { config } from "./config.js";

const MODEL_ID = "sonic-2";
// Cartesia voice: "Blake - Helpful Agent" — natural male, built for conversation
const VOICE_ID = "a167e0f3-df7e-4d52-a9c3-f949145efdab";

/**
 * One Cartesia Sonic streaming TTS session.
 * Send text tokens with send(), signal end with finish().
 * Consume μ-law 8kHz audio with audioChunks().
 *
 * Uses context continuation — tokens stream in as LLM produces them,
 * audio starts arriving before the full response is generated.
 */
export class CartesiaSession {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private isDone = false;
  private pendingResolve: (() => void) | null = null;
  private contextId = Math.random().toString(36).slice(2);
  private wsReady = false;
  private pending: Array<{ text: string; cont: boolean }> = [];

  constructor() {
    this.ws = new WebSocket("wss://api.cartesia.ai/tts/websocket", {
      headers: {
        "X-API-Key": config.cartesia.apiKey,
        "Cartesia-Version": "2024-11-13",
      },
    });

    this.ws.on("open", () => {
      this.wsReady = true;
      for (const { text, cont } of this.pending) this._send(text, cont);
      this.pending = [];
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          data?: string;
          done?: boolean;
          error?: string;
        };
        if (msg.error) console.error("[TTS] Cartesia error:", msg.error);
        if (msg.data) {
          this.queue.push(Buffer.from(msg.data, "base64"));
          this._notify();
        }
        if (msg.type === "done" || msg.done) {
          this.isDone = true;
          this.ws.close(1000);
          this._notify();
        }
      } catch { /* ignore parse errors */ }
    });

    this.ws.on("close", (code) => {
      if (code !== 1000 && code !== 1005) console.error(`[TTS] Cartesia WS closed: ${code}`);
      this.isDone = true;
      this._notify();
    });

    this.ws.on("error", (err) => {
      console.error("[TTS] Cartesia WS error:", err);
      this.isDone = true;
      this._notify();
    });
  }

  /** Stream a text token. continue=true means more is coming. */
  send(text: string, cont = true) {
    if (this.wsReady) this._send(text, cont);
    else this.pending.push({ text, cont });
  }

  /** Signal no more text — flushes remaining audio. */
  finish() {
    this.send("", false);
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

  private _send(text: string, cont: boolean) {
    try {
      this.ws.send(JSON.stringify({
        model_id: MODEL_ID,
        transcript: text,
        voice: { mode: "id", id: VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
        context_id: this.contextId,
        continue: cont,
        speed: 1.3,
      }));
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
