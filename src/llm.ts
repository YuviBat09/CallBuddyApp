import OpenAI from "openai";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are a calm, patient AI phone assistant named Buddy.
Keep every response to 1 short sentence — 15 words maximum. Never use lists or markdown.
Do NOT use filler affirmations like "Awesome", "Great", "Sure!", "Of course", "I'm all ears", or "I'm still listening".
Only speak when you have something genuinely useful to say. If the user is mid-thought, wait.
Speak naturally as if in a real phone conversation.`;

// Groq: OpenAI-compatible API, ~150-250ms first token vs Haiku's ~650ms
// Model: llama-3.3-70b-versatile — best quality/speed on Groq
const client = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

export class LLM {
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  async *stream(userText: string): AsyncGenerator<string> {
    this.history.push({ role: "user", content: userText });
    let fullResponse = "";

    const stream = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 80,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...this.history,
      ],
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) {
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
