import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "events";
import { config } from "./config.js";

const SENTENCE_END = /[.!?]\s/;

const SYSTEM_PROMPT = `You are a friendly, concise AI phone assistant named Buddy.
Keep every response to 1–2 short sentences. Never use lists or markdown.
Speak naturally as if in a real phone conversation.`;

/**
 * Wraps Claude streaming.
 * Emits:
 *   "sentence" (text: string) — a complete sentence ready for TTS
 *   "done" () — LLM response fully streamed
 */
export class LLM extends EventEmitter {
  private client = new Anthropic({ apiKey: config.anthropic.apiKey });
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  async respond(userText: string) {
    this.history.push({ role: "user", content: userText });

    let buffer = "";
    let fullResponse = "";

    const stream = this.client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: this.history,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const chunk = event.delta.text;
        buffer += chunk;
        fullResponse += chunk;

        // Fire TTS as soon as we have a complete sentence
        const match = buffer.search(SENTENCE_END);
        if (match !== -1) {
          const sentence = buffer.slice(0, match + 1).trim();
          buffer = buffer.slice(match + 2);
          if (sentence) {
            console.log(`[LLM] Sentence ready: "${sentence}"`);
            this.emit("sentence", sentence);
          }
        }
      }
    }

    // Emit any remaining text as a final sentence
    const remainder = buffer.trim();
    if (remainder) {
      console.log(`[LLM] Final sentence: "${remainder}"`);
      this.emit("sentence", remainder);
    }

    this.history.push({ role: "assistant", content: fullResponse });
    this.emit("done");
  }

  resetHistory() {
    this.history = [];
  }
}
