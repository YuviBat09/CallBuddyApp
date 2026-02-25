import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { twilioRouter } from "./twilio.js";
import { handleMediaStream } from "./stream.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Twilio routes
app.use("/", twilioRouter);

// Create HTTP server and attach WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Upgrade HTTP → WebSocket only on /stream path
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("[SERVER] New media stream WebSocket connection");
  handleMediaStream(ws);
});

server.listen(config.port, () => {
  console.log(`[SERVER] Listening on port ${config.port}`);
  console.log(`[SERVER] Public URL: ${config.serverUrl}`);
  console.log(`[SERVER] Initiate call: POST ${config.serverUrl}/call { "to": "+1xxxxxxxxxx" }`);
});
