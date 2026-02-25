import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

// Twilio requires μ-law 8kHz. OpenAI TTS returns PCM at 24kHz.
// We downsample 24kHz → 8kHz (factor of 3) then encode to μ-law.

/** Downsample 24kHz signed 16-bit PCM → 8kHz by taking every 3rd sample */
function downsample24to8(pcm24: Buffer): Buffer {
  const factor = 3;
  const outSamples = Math.floor(pcm24.length / 2 / factor);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const sample = pcm24.readInt16LE(i * factor * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/** Encode signed 16-bit PCM to μ-law bytes */
function pcm16ToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    const sample = pcm.readInt16LE(i * 2);
    out[i] = linearToMulaw(sample);
  }
  return out;
}

function linearToMulaw(sample: number): number {
  const MULAW_BIAS = 33;
  const MULAW_CLIP = 32635;

  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Stream text → μ-law 8kHz chunks as they arrive from OpenAI.
 * Yields Buffer chunks suitable for sending directly to Twilio.
 * First chunk arrives ~150-250ms after call (vs 2000ms+ waiting for full response).
 */
export async function* streamTextToMulaw(text: string): AsyncGenerator<Buffer> {
  const t0 = Date.now();

  const response = await client.audio.speech.create({
    model: "tts-1",
    voice: "alloy",
    input: text,
    response_format: "pcm", // raw 24kHz signed 16-bit PCM
  });

  // 24kHz → 8kHz: 3 input samples per output sample = 6 bytes per output sample
  const FRAME = 6;
  let carry = Buffer.alloc(0);
  let firstChunk = true;

  for await (const raw of response.body as AsyncIterable<Uint8Array>) {
    if (firstChunk) {
      console.log(`[TTS] First chunk in ${Date.now() - t0}ms — "${text.slice(0, 40)}"`);
      firstChunk = false;
    }
    const chunk = Buffer.concat([carry, Buffer.from(raw)]);
    const usable = Math.floor(chunk.length / FRAME) * FRAME;
    carry = chunk.subarray(usable);
    if (usable > 0) {
      yield pcm16ToMulaw(downsample24to8(chunk.subarray(0, usable)));
    }
  }

  // Flush any remaining bytes
  if (carry.length >= 2) {
    const usable = carry.length - (carry.length % 2);
    if (usable > 0) yield pcm16ToMulaw(downsample24to8(carry.subarray(0, usable)));
  }
}
