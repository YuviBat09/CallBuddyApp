import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are a calm, patient AI phone assistant named Buddy.
Keep every response to 1 short sentence — 15 words maximum. Never use lists or markdown.
Do NOT use filler affirmations like "Awesome", "Great", "Sure!", "Of course", "I'm all ears", or "I'm still listening".
Only speak when you have something genuinely useful to say. If the user is mid-thought, wait.
Speak naturally as if in a real phone conversation.`;

export class LLM {
  private client = new Anthropic({ apiKey: config.anthropic.apiKey });
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  /**
   * Stream the response to userText as raw text tokens.
   * Caller pipes tokens directly to TTS — no sentence boundary wait.
   */
  async *stream(userText: string): AsyncGenerator<string> {
    this.history.push({ role: "user", content: userText });
    let fullResponse = "";

    const stream = this.client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: this.history,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const token = event.delta.text;
        fullResponse += token;
        yield token;
      }
    }

    this.history.push({ role: "assistant", content: fullResponse });
  }

  resetHistory() {
    this.history = [];
  }
}
