import "dotenv/config";

function require_env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  serverUrl: require_env("SERVER_URL"),

  twilio: {
    accountSid: require_env("TWILIO_ACCOUNT_SID"),
    authToken: require_env("TWILIO_AUTH_TOKEN"),
    phoneNumber: require_env("TWILIO_PHONE_NUMBER"),
  },

  groq: {
    apiKey: require_env("GROQ_API_KEY"),
  },

  openai: {
    apiKey: require_env("OPENAI_API_KEY"),
  },

  deepgram: {
    apiKey: require_env("DEEPGRAM_API_KEY"),
  },

  cartesia: {
    apiKey: process.env.CARTESIA_API_KEY ?? "",
  },

  elevenlabs: {
    apiKey: require_env("ELEVENLABS_API_KEY"),
  },
} as const;
