// [Instance-2] Google Sheets latency exporter
// Appends one row per conversation turn to a configured Google Sheet.
// Fully optional — if GOOGLE_SHEET_ID is absent the module is a no-op.
import { google } from "googleapis";
import { existsSync, readFileSync } from "fs";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = process.env.GOOGLE_CREDENTIALS_PATH ?? "./google-credentials.json";
const SHEET_TAB  = process.env.GOOGLE_SHEET_TAB ?? "Latency";

const HEADERS = [
  "Timestamp",
  "Call SID",
  "User Text",
  "LLM Model",
  "ms Speech→First Token",
  "ms Speech→Last Token",
  "ms Total Response",
  "Interrupted",
];

export type LatencyRow = {
  callSid:      string;
  userText:     string;
  llmModel:     string;
  msFirstToken: number;
  msLastToken:  number;
  msTotal:      number;
  interrupted:  boolean;
};

// --- Lazy client init --------------------------------------------------------

type SheetsClient = ReturnType<typeof google.sheets>;
let _sheets: SheetsClient | null = null;
let _ready = false;

function getClient(): SheetsClient | null {
  if (_ready) return _sheets;
  _ready = true;

  if (!SHEET_ID) return null; // silently skip — not configured

  try {
    let credentials: Record<string, unknown>;

    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) as Record<string, unknown>;
    } else if (existsSync(CREDS_PATH)) {
      credentials = JSON.parse(readFileSync(CREDS_PATH, "utf-8")) as Record<string, unknown>;
    } else {
      console.error(`[SHEETS] No credentials found — set GOOGLE_CREDENTIALS_JSON or place key file at ${CREDS_PATH}`);
      return null;
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    _sheets = google.sheets({ version: "v4", auth });
    console.log(`[SHEETS] Client ready — sheet id: ${SHEET_ID}`);
    return _sheets;
  } catch (err) {
    console.error("[SHEETS] Init failed:", err);
    return null;
  }
}

// --- Header guard ------------------------------------------------------------

let _headerDone = false;

async function ensureHeader(client: SheetsClient): Promise<void> {
  if (_headerDone) return;
  _headerDone = true;

  try {
    const res = await client.spreadsheets.values.get({
      spreadsheetId: SHEET_ID!,
      range: `${SHEET_TAB}!A1`,
    });
    const firstCell = res.data.values?.[0]?.[0] ?? "";
    if (firstCell !== "Timestamp") {
      await client.spreadsheets.values.append({
        spreadsheetId: SHEET_ID!,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [HEADERS] },
      });
      console.log("[SHEETS] Header row written");
    }
  } catch (err) {
    console.error("[SHEETS] Failed to write header:", err);
    _headerDone = false; // retry next call
  }
}

// --- Public API --------------------------------------------------------------

/**
 * Appends one latency data row to the Google Sheet.
 * Fire-and-forget — errors are logged, never thrown.
 */
export async function appendToSheet(row: LatencyRow): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    await ensureHeader(client);

    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID!,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toISOString(),
          row.callSid,
          row.userText,
          row.llmModel,
          row.msFirstToken,
          row.msLastToken,
          row.msTotal,
          row.interrupted ? 1 : 0,
        ]],
      },
    });

    console.log(`[SHEETS] Row appended — first-token: ${row.msFirstToken}ms | total: ${row.msTotal}ms`);
  } catch (err) {
    console.error("[SHEETS] Append failed:", err);
  }
}
