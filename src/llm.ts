import OpenAI from "openai";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are Buddy, a friendly AI on a phone call with smart home control. Keep it natural and brief.

- 1 to 2 short sentences max, 20 words total
- Use contractions: I'm, you're, that's, don't, can't
- Sound warm and human — like a real person on the phone
- Never start with filler sounds like "Uhh", "Um", "Hmm" — jump straight to your response
- Never use hollow filler: "Great!", "Sure!", "Absolutely!", "Of course!", "Certainly!"
- No lists, no markdown, no formal language
- Get straight to the point
- You can control lights. When asked (via "okay claude, ..."), confirm naturally: "Done.", "Lights off.", "Dimming them now."`;

// Groq llama-3.1-8b-instant: ~80-120ms first token (3x faster than 70b for short replies)
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
      model: "llama-3.1-8b-instant",
      max_tokens: 60,
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
