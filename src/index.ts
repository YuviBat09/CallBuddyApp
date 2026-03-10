import express, { Request, Response } from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "fs";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { twilioRouter } from "./twilio.js";
import { handleMediaStream } from "./stream.js";
import { requireAuth } from "./auth.js";
import {
  getAuthUrl, exchangeCode, createBridgeUsername, getGroups, isConfigured,
} from "./hue.js";

const LATENCY_CSV = "./latency.csv";

// --- SSE log broadcast ---
const sseClients = new Set<Response>();

function broadcast(line: string) {
  const payload = `data: ${JSON.stringify({ msg: line })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

const _log = console.log.bind(console);
const _error = console.error.bind(console);
console.log = (...args: unknown[]) => { const l = args.map(String).join(" "); _log(l); broadcast(l); };
console.error = (...args: unknown[]) => { const l = "[ERROR] " + args.map(String).join(" "); _error(l); broadcast(l); };

// --- HTML UI ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Buddy Control</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f0f;color:#e0e0e0;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
    .header{padding:16px 20px;border-bottom:1px solid #1e1e1e;flex-shrink:0}
    .header h1{font-size:1.3rem;color:#fff}
    .header p{font-size:0.8rem;color:#555;margin-top:2px}
    .call-bar{padding:14px 20px;border-bottom:1px solid #1e1e1e;flex-shrink:0}
    .call-row{display:flex;gap:10px;margin-bottom:8px}
    input{flex:1;background:#1a1a1a;border:1px solid #2a2a2a;color:#fff;padding:11px 14px;border-radius:10px;font-size:1rem;outline:none}
    input:focus{border-color:#22c55e}
    .btn{border:none;padding:11px 20px;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer}
    .btn-call{background:#22c55e;color:#000}
    .btn-call:disabled{background:#1f2d21;color:#3a5e3d;cursor:not-allowed}
    .call-status{font-size:0.78rem;color:#555}
    .call-status.active{color:#22c55e}
    .call-status.ended{color:#6b7280}
    .tabs{display:flex;border-bottom:1px solid #1e1e1e;flex-shrink:0}
    .tab{flex:1;padding:11px;text-align:center;cursor:pointer;color:#555;font-size:0.85rem;border-bottom:2px solid transparent;transition:color .15s}
    .tab.active{color:#fff;border-bottom-color:#22c55e}
    .pane{flex:1;overflow-y:auto;padding:16px;display:none}
    .pane.active{display:block}
    .msg{margin-bottom:18px}
    .msg-who{font-size:0.68rem;font-weight:700;letter-spacing:.08em;margin-bottom:5px}
    .msg.user .msg-who{color:#60a5fa}
    .msg.buddy .msg-who{color:#22c55e}
    .msg-text{padding:10px 14px;border-radius:10px;font-size:0.95rem;line-height:1.55;background:#1a1a1a}
    .msg.user .msg-text{border-left:3px solid #60a5fa}
    .msg.buddy .msg-text{border-left:3px solid #22c55e}
    .call-divider{margin:20px 0 14px;display:flex;align-items:center;gap:10px}
    .call-divider-line{flex:1;height:1px;background:#1e1e1e}
    .call-divider-label{font-size:0.7rem;color:#374151;white-space:nowrap;font-family:monospace}
    .log-line{font-family:monospace;font-size:0.72rem;line-height:1.9;color:#444;word-break:break-all}
    .log-line.user{color:#60a5fa}
    .log-line.buddy{color:#22c55e}
    .log-line.latency{color:#f59e0b}
    .log-line.err{color:#ef4444}
    .log-line.relay{color:#a78bfa}
    .empty{color:#333;font-size:0.85rem;text-align:center;margin-top:40px}
  </style>
</head>
<body>
  <div class="header">
    <h1>Buddy Control</h1>
    <p id="connStatus">Connecting to log stream...</p>
  </div>
  <div class="call-bar">
    <div class="call-row">
      <input type="tel" id="phoneInput" value="+642102679425" placeholder="+1xxxxxxxxxx" />
      <button class="btn btn-call" id="callBtn" onclick="makeCall()">Call</button>
    </div>
    <div class="call-status" id="callStatus">Ready</div>
  </div>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('conv')">Instructions</div>
    <div class="tab" onclick="switchTab('logs')">System Logs</div>
  </div>
  <div class="pane active" id="pane-conv"><div class="empty" id="convEmpty">Say &ldquo;okay claude, [change request]&rdquo; on the call &mdash; it will appear here.</div></div>
  <div class="pane" id="pane-logs"></div>

  <script>
    const convPane = document.getElementById('pane-conv');
    const logsPane = document.getElementById('pane-logs');
    const callStatus = document.getElementById('callStatus');
    const callBtn = document.getElementById('callBtn');
    const connStatus = document.getElementById('connStatus');
    const convEmpty = document.getElementById('convEmpty');

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', (tab==='conv'&&i===0)||(tab==='logs'&&i===1)));
      document.getElementById('pane-conv').classList.toggle('active', tab==='conv');
      document.getElementById('pane-logs').classList.toggle('active', tab==='logs');
    }

    async function makeCall() {
      const to = document.getElementById('phoneInput').value.trim();
      if (!to) return;
      callBtn.disabled = true;
      callStatus.className = 'call-status active';
      callStatus.textContent = 'Dialling...';
      try {
        const r = await fetch('/call', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({to})});
        const d = await r.json();
        if (r.ok) {
          callStatus.textContent = 'Ringing... SID: ' + d.callSid;
        } else {
          callStatus.textContent = 'Error: ' + d.error;
          callBtn.disabled = false;
        }
      } catch(e) {
        callStatus.textContent = 'Could not reach server';
        callBtn.disabled = false;
      }
    }

    const es = new EventSource('/logs');
    es.onopen = () => { connStatus.textContent = 'Live \u2022 ' + new Date().toLocaleTimeString(); };
    es.onerror = () => { connStatus.textContent = 'Log stream disconnected — reload to reconnect'; };
    es.onmessage = (e) => {
      const { msg } = JSON.parse(e.data);
      appendLog(msg);
    };

    function appendLog(line) {
      const div = document.createElement('div');
      div.className = 'log-line';
      if (line.includes('[PIPELINE] User:')) div.className += ' user';
      else if (line.includes('[BUDDY]')) div.className += ' buddy';
      else if (line.includes('[LATENCY]')) div.className += ' latency';
      else if (line.includes('[RELAY]')) div.className += ' relay';
      else if (line.includes('[ERROR]') || line.toLowerCase().includes('error')) div.className += ' err';
      div.textContent = line;
      logsPane.appendChild(div);
      if (logsPane.classList.contains('active')) logsPane.scrollTop = logsPane.scrollHeight;

      const callStartMatch = line.match(/\\[CALL_START\\] (\\S+)/);
      if (callStartMatch) addCallDivider(callStartMatch[1]);

      const instrMatch = line.match(/\\[INSTRUCTION\\] (\\S+) "(.+)"/);
      if (instrMatch) addConvMsg(instrMatch[2]);

      if (line.includes('[RELAY] Call connected')) {
        callStatus.className = 'call-status active';
        callStatus.textContent = 'Call active';
      }
      if (line.includes('[RELAY] Call ended') || line.includes('[RELAY] WebSocket closed')) {
        callStatus.className = 'call-status ended';
        callStatus.textContent = 'Call ended';
        callBtn.disabled = false;
      }
    }

    function addCallDivider(sid) {
      const short = sid.slice(0, 16) + '\u2026';
      const now = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const div = document.createElement('div');
      div.className = 'call-divider';
      div.innerHTML = '<div class="call-divider-line"></div><div class="call-divider-label">Call ' + escHtml(short) + ' \u00B7 ' + now + '</div><div class="call-divider-line"></div>';
      convPane.appendChild(div);
    }

    function addConvMsg(text) {
      convEmpty.style.display = 'none';
      const div = document.createElement('div');
      div.className = 'msg user';
      const now = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      div.innerHTML = '<div class="msg-who">INSTRUCTION \u00B7 ' + now + '</div><div class="msg-text">' + escHtml(text) + '</div>';
      convPane.appendChild(div);
      if (convPane.classList.contains('active')) convPane.scrollTop = convPane.scrollHeight;
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  </script>
</body>
</html>`;

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CallBuddy</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f0f;color:#e0e0e0;
     min-height:100dvh;display:flex;align-items:center;justify-content:center}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:36px 32px;width:100%;max-width:360px}
h1{font-size:1.2rem;color:#fff;margin-bottom:6px;text-align:center}
p.sub{font-size:.78rem;color:#555;text-align:center;margin-bottom:28px}
input{width:100%;background:#111;border:1px solid #2a2a2a;color:#fff;
      padding:12px 14px;border-radius:8px;font-size:1rem;outline:none;margin-bottom:14px}
input:focus{border-color:#22c55e}
button{width:100%;background:#22c55e;color:#000;border:none;padding:12px;
       border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
button:hover{background:#16a34a}</style></head>
<body><div class="card">
<h1>CallBuddy</h1><p class="sub">Enter password to continue</p>
<!--ERROR-->
<form method="POST" action="/login">
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"/>
<button type="submit">Sign in</button>
</form></div></body></html>`;

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"], frameSrc: ["'none'"], objectSrc: ["'none'"],
    scriptSrcAttr: ["'unsafe-inline'"],
  }},
}));

const generalLimiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts, try again in 15 minutes" },
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: config.auth.sessionSecret,
  name: "buddy.sid",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// Auth routes (exempt from requireAuth)
app.get("/login", (req: Request, res: Response) => {
  if (req.session.authenticated) return void res.redirect("/");
  res.type("text/html").send(LOGIN_HTML);
});
app.post("/login", loginLimiter, (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (password === config.auth.adminPassword) {
    req.session.authenticated = true;
    req.session.save(() => res.redirect("/"));
  } else {
    res.type("text/html").send(LOGIN_HTML.replace("<!--ERROR-->",
      '<p style="color:#ef4444;text-align:center;margin-bottom:12px;font-size:.85rem">Incorrect password</p>'
    ));
  }
});
app.get("/logout", (req: Request, res: Response) => { req.session.destroy(() => res.redirect("/login")); });

// Health check (exempt from auth — Azure health probe)
app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// Mobile control UI
app.get("/", requireAuth, (_req: Request, res: Response) => res.type("text/html").send(HTML));

// Live log stream (SSE)
app.get("/logs", requireAuth, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Latency data — read by BatraIndustries analytics (session OR Bearer)
app.get("/api/latency", requireAuth, (_req: Request, res: Response) => {
  if (!existsSync(LATENCY_CSV)) return res.json([]);
  const lines = readFileSync(LATENCY_CSV, "utf8").trim().split("\n").slice(1);
  const rows = lines.map(line => {
    const [timestamp, callSid, userText, llmModel, msFirstToken, msLastToken, msTotal, interrupted] = line.split(",");
    return {
      timestamp: timestamp ?? "",
      callSid: (callSid ?? "").replace(/"/g, ""),
      userText: (userText ?? "").replace(/"/g, ""),
      llmModel: llmModel ?? "",
      msFirstToken: parseInt(msFirstToken ?? "0"),
      msLastToken: parseInt(msLastToken ?? "0"),
      msTotal: parseInt(msTotal ?? "0"),
      interrupted: interrupted?.trim() === "1",
    };
  }).filter(r => r.timestamp);
  res.json(rows);
});

// ── Philips Hue OAuth setup routes (behind auth) ──────────────────────────────

// Step 1: redirect to Hue login
app.get("/hue/auth", requireAuth, (_req: Request, res: Response) => {
  try {
    res.redirect(getAuthUrl(config.serverUrl));
  } catch (err) {
    res.status(500).send(`<pre>Error: ${String(err)}\n\nMake sure HUE_CLIENT_ID is set.</pre>`);
  }
});

// Step 2: Hue redirects back here with ?code=...
app.get("/hue/callback", requireAuth, async (req: Request, res: Response) => {
  const { code, error } = req.query as { code?: string; error?: string };

  if (error || !code) {
    return void res.status(400).send(`<pre>Hue OAuth error: ${error ?? "no code returned"}</pre>`);
  }

  try {
    const { refreshToken } = await exchangeCode(code);
    const username = await createBridgeUsername();

    const instructions = `
<h2>Hue connected!</h2>
<p>Set these two env vars in your Azure App Service → Configuration → Application settings, then restart:</p>
<pre>
HUE_REFRESH_TOKEN=${refreshToken}
HUE_BRIDGE_USERNAME=${username}
</pre>
<p>Once set, say <strong>"okay claude, turn on the lights"</strong> on a call to test.</p>
<p><a href="/hue/status">Check status</a></p>`.trim();

    res.type("text/html").send(instructions);
  } catch (err) {
    res.status(500).send(`<pre>Setup failed: ${String(err)}</pre>`);
  }
});

// Status / diagnostic page
app.get("/hue/status", requireAuth, async (_req: Request, res: Response) => {
  if (!isConfigured()) {
    return void res.type("text/html").send(
      `<p>Hue not configured. <a href="/hue/auth">Connect Hue →</a></p>`
    );
  }
  try {
    const groups = await getGroups();
    const list = Object.entries(groups)
      .map(([id, g]) => `  ${id}: ${g.name} (${g.type})`)
      .join("\n");
    res.type("text/html").send(`<h2>Hue connected</h2><pre>Groups:\n${list}</pre>`);
  } catch (err) {
    res.status(500).send(`<pre>Hue error: ${String(err)}</pre>`);
  }
});

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
  console.log(`[SERVER] Open UI: ${config.serverUrl}`);
});
