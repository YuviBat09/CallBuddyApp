import { Router } from "express";
import twilio from "twilio";
import { config } from "./config.js";

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

export const twilioRouter = Router();

/**
 * POST /call
 * Body: { to: "+1xxxxxxxxxx" }
 * Initiates an outgoing call from our Twilio number to the target number.
 */
twilioRouter.post("/call", async (req, res) => {
  const { to } = req.body as { to?: string };

  if (!to) {
    res.status(400).json({ error: 'Missing "to" phone number' });
    return;
  }

  try {
    const call = await client.calls.create({
      to,
      from: config.twilio.phoneNumber,
      url: `${config.serverUrl}/twiml`,
      statusCallback: `${config.serverUrl}/call-status`,
      statusCallbackMethod: "POST",
    });

    console.log(`[TWILIO] Outgoing call created — sid: ${call.sid} → ${to}`);
    res.json({ callSid: call.sid, to, status: call.status });
  } catch (err) {
    console.error("[TWILIO] Failed to create call:", err);
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

/**
 * GET /twiml
 * Returns TwiML that Twilio fetches when the call connects.
 * Connects the call to our WebSocket media stream.
 */
twilioRouter.all("/twiml", (req, res) => {
  const wsUrl = `${config.serverUrl.replace("https://", "wss://")}/stream`;

  // Custom pipeline: we handle STT (Deepgram) + TTS (Cartesia) ourselves
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * POST /call-status
 * Twilio calls this with call lifecycle events (optional logging).
 */
twilioRouter.post("/call-status", (req, res) => {
  const { CallSid, CallStatus } = req.body as Record<string, string>;
  console.log(`[TWILIO] Call ${CallSid} status: ${CallStatus}`);
  res.sendStatus(200);
});
