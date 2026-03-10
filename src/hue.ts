/**
 * Philips Hue Remote API — cloud control via api.meethue.com
 *
 * OAuth2 flow (one-time setup):
 *   1. User visits /hue/auth → redirected to Hue login
 *   2. Hue redirects to /hue/callback?code=...
 *   3. We exchange code → access + refresh tokens
 *   4. We auto-create a bridge username (no physical button press needed — remote API supports linkbutton remotely)
 *   5. Store HUE_REFRESH_TOKEN + HUE_BRIDGE_USERNAME in Azure App Service env vars
 *
 * Runtime: refresh token → access token → API calls to api.meethue.com/route/api/{username}/...
 */

import OpenAI from "openai";
import { config } from "./config.js";

const REMOTE_BASE = "https://api.meethue.com";
const TOKEN_URL   = `${REMOTE_BASE}/v2/oauth2/token`;
const API_BASE    = `${REMOTE_BASE}/route/api`;

// ── Token cache ───────────────────────────────────────────────────────────────

let _accessToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const { clientId, clientSecret, refreshToken } = config.hue;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Hue not configured — set HUE_CLIENT_ID, HUE_CLIENT_SECRET, HUE_REFRESH_TOKEN");
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });

  if (!res.ok) throw new Error(`Hue token refresh failed: ${res.status} ${await res.text()}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000 - 60_000; // 1min buffer
  return _accessToken;
}

// ── OAuth helpers (used by setup routes) ─────────────────────────────────────

export function getAuthUrl(serverUrl: string): string {
  const { clientId } = config.hue;
  if (!clientId) throw new Error("HUE_CLIENT_ID not set");
  const callback = `${serverUrl}/hue/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    state: "callbuddy",
  });
  return `${REMOTE_BASE}/v2/oauth2/authorize?${params}&appid=callbuddy&deviceid=azure&devicename=CallBuddyAzure`;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const { clientId, clientSecret } = config.hue;
  if (!clientId || !clientSecret) throw new Error("HUE_CLIENT_ID / HUE_CLIENT_SECRET not set");

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });

  if (!res.ok) throw new Error(`Hue code exchange failed: ${res.status} ${await res.text()}`);

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  // Cache it
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000 - 60_000;
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Creates a bridge username remotely (no button press required via Remote API). */
export async function createBridgeUsername(): Promise<string> {
  const token = await getAccessToken();

  // Enable link button remotely
  await fetch(`${API_BASE}/0/config`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ linkbutton: true }),
  });

  // Create username
  const res = await fetch(`${API_BASE}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ devicetype: "callbuddy#azure" }),
  });

  if (!res.ok) throw new Error(`Bridge username creation failed: ${res.status} ${await res.text()}`);

  const data = await res.json() as Array<{ success?: { username: string }; error?: { description: string } }>;
  const username = data[0]?.success?.username;
  if (!username) {
    const desc = data[0]?.error?.description ?? JSON.stringify(data);
    throw new Error(`Bridge username not returned: ${desc}`);
  }
  return username;
}

// ── Light control ─────────────────────────────────────────────────────────────

export type LightState = {
  on?: boolean;
  bri?: number;   // 0–254
  hue?: number;   // 0–65535
  sat?: number;   // 0–254
  ct?: number;    // 153–500 (cool–warm)
};

export async function setGroup(groupId: string, state: LightState): Promise<void> {
  const token = await getAccessToken();
  const username = config.hue.bridgeUsername;
  if (!username) throw new Error("HUE_BRIDGE_USERNAME not set");

  const res = await fetch(`${API_BASE}/${username}/groups/${groupId}/action`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(state),
  });
  if (!res.ok) console.error(`[HUE] setGroup ${groupId} failed: ${res.status}`);
}

/** Group 0 = all lights on the bridge. */
export async function setAll(state: LightState): Promise<void> {
  await setGroup("0", state);
}

export async function getGroups(): Promise<Record<string, { name: string; type: string }>> {
  const token = await getAccessToken();
  const username = config.hue.bridgeUsername;
  if (!username) throw new Error("HUE_BRIDGE_USERNAME not set");

  const res = await fetch(`${API_BASE}/${username}/groups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json() as Promise<Record<string, { name: string; type: string }>>;
}

// ── Color name → Hue light state ──────────────────────────────────────────────

const COLOR_MAP: Record<string, Partial<LightState>> = {
  red:      { hue: 0,     sat: 254 },
  orange:   { hue: 6500,  sat: 254 },
  yellow:   { hue: 12750, sat: 254 },
  green:    { hue: 25500, sat: 254 },
  teal:     { hue: 36210, sat: 254 },
  cyan:     { hue: 36210, sat: 254 },
  blue:     { hue: 46920, sat: 254 },
  purple:   { hue: 56100, sat: 254 },
  violet:   { hue: 56100, sat: 254 },
  pink:     { hue: 60000, sat: 200 },
  magenta:  { hue: 60000, sat: 254 },
  white:    { hue: 0,     sat: 0,   ct: 370 },  // neutral white
  warm:     { hue: 0,     sat: 0,   ct: 454 },  // warm/candlelight
  cool:     { hue: 0,     sat: 0,   ct: 153 },  // cool/daylight
  daylight: { hue: 0,     sat: 0,   ct: 153 },
};

function colorNameToState(name: string): Partial<LightState> {
  const key = name.toLowerCase().trim();
  return COLOR_MAP[key] ?? COLOR_MAP.white!;
}

// ── Intent parsing via Groq ───────────────────────────────────────────────────

type HueIntent = {
  action: "on" | "off" | "brightness" | "color" | "ignore";
  brightness?: number; // 0–100 percent
  color?: string;      // color name from COLOR_MAP
};

const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

const INTENT_SYSTEM = `You extract smart home lighting commands. Return JSON only, no explanation.

Schema: { "action": "on"|"off"|"brightness"|"color"|"ignore", "brightness": <0-100>, "color": "<name>" }

Rules:
- action "on": turn lights on (optionally also set brightness/color)
- action "off": turn lights off
- action "brightness": change brightness only (brightness field required, 0-100)
- action "color": change color (color field required: red/orange/yellow/green/teal/cyan/blue/purple/pink/magenta/white/warm/cool/daylight)
- action "ignore": not a lighting command
- If the user says something like "dim", use brightness ~30. "Bright" = 100. "Half" = 50.
- Always include the action field. Other fields only when relevant.`;

async function parseIntent(instruction: string): Promise<HueIntent | null> {
  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 60,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INTENT_SYSTEM },
        { role: "user", content: instruction },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "{}";
    const intent = JSON.parse(raw) as HueIntent;
    if (intent.action === "ignore" || !intent.action) return null;
    return intent;
  } catch (err) {
    console.error("[HUE] Intent parse error:", err);
    return null;
  }
}

// ── Public: handle a voice instruction ───────────────────────────────────────

/** Returns a short status string for logging, or null if not a light command. */
export async function handleLightInstruction(instruction: string): Promise<string | null> {
  if (!isConfigured()) return null;

  const intent = await parseIntent(instruction);
  if (!intent) return null;

  console.log(`[HUE] Intent: ${JSON.stringify(intent)}`);

  try {
    switch (intent.action) {
      case "on": {
        const state: LightState = { on: true };
        if (intent.brightness != null) state.bri = Math.round((intent.brightness / 100) * 254);
        if (intent.color) Object.assign(state, colorNameToState(intent.color));
        await setAll(state);
        return `lights on${intent.brightness != null ? ` @ ${intent.brightness}%` : ""}${intent.color ? ` (${intent.color})` : ""}`;
      }
      case "off":
        await setAll({ on: false });
        return "lights off";
      case "brightness": {
        const bri = Math.round(((intent.brightness ?? 50) / 100) * 254);
        await setAll({ bri, on: true });
        return `brightness → ${intent.brightness ?? 50}%`;
      }
      case "color": {
        const colorState = colorNameToState(intent.color ?? "white");
        await setAll({ ...colorState, on: true });
        return `color → ${intent.color ?? "white"}`;
      }
    }
  } catch (err) {
    console.error("[HUE] Control error:", err);
    return null;
  }
  return null;
}

export function isConfigured(): boolean {
  return !!(config.hue.clientId && config.hue.refreshToken && config.hue.bridgeUsername);
}
