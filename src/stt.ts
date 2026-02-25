import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { EventEmitter } from "events";
import { config } from "./config.js";

/**
 * Wraps a Deepgram streaming session.
 * Emits:
 *   "transcript" (text: string) — final utterance ready for LLM
 */
export class STT extends EventEmitter {
  private dg = createClient(config.deepgram.apiKey);
  private live: ReturnType<typeof this.dg.listen.live> | null = null;

  start() {
    this.live = this.dg.listen.live({
      model: "nova-2",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      endpointing: 300,       // ms of silence = end of utterance
      interim_results: false, // only final results
      smart_format: true,
    });

    this.live.on(LiveTranscriptionEvents.Open, () => {
      console.log("[STT] Deepgram connection open");
    });

    this.live.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (text && data.is_final) {
        console.log(`[STT] Final transcript: "${text}"`);
        this.emit("transcript", text);
      }
    });

    this.live.on(LiveTranscriptionEvents.Error, (err) => {
      console.error("[STT] Deepgram error:", err);
    });

    this.live.on(LiveTranscriptionEvents.Close, () => {
      console.log("[STT] Deepgram connection closed");
    });
  }

  /** Send raw μ-law audio bytes to Deepgram */
  send(audio: Buffer) {
    if (this.live) {
      // Deepgram SDK expects ArrayBuffer
      this.live.send(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
    }
  }

  stop() {
    this.live?.finish();
    this.live = null;
  }
}
