// Rehost server: static files, the chat channel, custom game lobbies,
// and a relay that lets players' game tabs talk to each other.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, "public");
const RESUME_GRACE_MS = 20_000;   // how long a dropped player keeps their name and slot
const MAX_PLAYERS = 12;
const HISTORY = 50;               // chat lines replayed to new arrivals

const id = (n = 12) => crypto.randomBytes(n).toString("base64url");
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const validNick = (s) => /^[A-Za-z0-9_\-]{3,15}$/.test(s);

function gameUrlOk(u) {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname);
  } catch { return false; }
}

/* ---------- state (in memory; see README for scaling) ---------- */
const sessions = new Map(); // sessionId -> { id, nick, ws, lobbyId, dropTimer, bucket }
const lobbies = new Map();  // lobbyId -> lobby
const tickets = new Map();  // game ticket -> { lobbyId, sessionId }
const chatLog = [];

/* ---------- static files ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.end("ok"); return; }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
    if (file.endsWith("sdk.js")) headers["Access-Control-Allow-Origin"] = "*";
    res.writeHead(200, headers).end(buf);
  });
});

/* ---------- helpers ---------- */
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function everyone(msg) { for (const s of sessions.values()) send(s.ws, msg); }
function online() { return [...sessions.values()].filter((s) => s.ws); }

function publicLobby(l) {
  return {
    id: l.id, name: l.name, game: l.game, url: l.url, max: l.max, speed: l.speed, desc: l.desc,
    hostId: l.hostId, hostNick: sessions.get(l.hostId)?.nick || "?", createdAt: l.createdAt, status: l.status,
    players: l.players.map((pid) => ({ id: pid, nick: sessions.get(pid)?.nick || "?", away: !sessions.get(pid)?.ws, inGame: l.gameSockets.has(pid) })),
  };
}
function userList() {
  return online().map((s) => {
    const l = s.lobbyId && lobbies.get(s.lobbyId);
    return { id: s.id, nick: s.nick, game: l ? l.game : null };
  });
}
function broadcastUsers() { everyone({ t: "users", users: userList() }); }
function broadcastLobbies() {
  everyone({ t: "lobbies", lobbies: [...lobbies.values()].filter((l) => l.status === "open").map(publicLobby) });
}
function pushLobby(l) {
  const pl = publicLobby(l);
  for (const pid of l.players) send(sessions.get(pid)?.ws, { t: "lobby", lobby: pl });
  for (const [, g] of l.gameSockets) send(g, { t: "players", players: pl.players, hostId: l.hostId });
}
function lobbyInfo(l, text) {
  for (const pid of l.players) send(sessions.get(pid)?.ws, { t: "gchat", sys: true, text });
}

function leaveLobby(s, reason) {
  const l = s.lobbyId && lobbies.get(s.lobbyId);
  s.lobbyId = null;
  if (!l) return;
  l.players = l.players.filter((p) => p !== s.id);
  l.gameSockets.get(s.id)?.close(4000, "left");
  l.gameSockets.delete(s.id);
  if (l.hostId === s.id || l.players.length === 0) {
    lobbies.delete(l.id);
    for (const pid of l.players) {
      const p = sessions.get(pid);
      if (p) { p.lobbyId = null; send(p.ws, { t: "closed", reason: "The host closed the game." }); }
    }
    for (const [, g] of l.gameSockets) g.close(4001, "closed");
    for (const [k, v] of tickets) if (v.lobbyId === l.id) tickets.delete(k);
  } else {
    lobbyInfo(l, `${s.nick} ${reason || "has left the game."}`);
    pushLobby(l);
  }
  broadcastLobbies();
}

function dropSession(s) {
  leaveLobby(s, "has left the game.");
  sessions.delete(s.id);
  for (const [k, v] of tickets) if (v.sessionId === s.id) tickets.delete(k);
  broadcastUsers();
}

// Simple token bucket: 5 messages, refills 1 per second.
function allow(s) {
  const now = Date.now();
  s.bucket.tokens = Math.min(5, s.bucket.tokens + (now - s.bucket.at) / 1000);
  s.bucket.at = now;
  if (s.bucket.tokens < 1) return false;
  s.bucket.tokens -= 1;
  return true;
}

/* ---------- client (lobby UI) socket ---------- */
function onClient(ws) {
  let s = null;
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!s) {
      if (m.t !== "hello") return;
      // Resume a session that dropped a moment ago (refresh, flaky wifi).
      const prev = m.resume && sessions.get(m.resume);
      if (prev && !prev.ws && prev.nick.toLowerCase() === String(m.nick).toLowerCase()) {
        s = prev; clearTimeout(s.dropTimer); s.ws = ws;
      } else {
        const nick = clean(m.nick, 15);
        if (!validNick(nick)) return send(ws, { t: "error", code: "nick", msg: "Account names use 3–15 letters, numbers, _ or -." });
        if ([...sessions.values()].some((x) => x.nick.toLowerCase() === nick.toLowerCase()))
          return send(ws, { t: "error", code: "nick", msg: "That name is in use. Pick another one." });
        s = { id: id(), nick, ws, lobbyId: null, dropTimer: null, bucket: { tokens: 5, at: Date.now() } };
        sessions.set(s.id, s);
      }
      const l = s.lobbyId && lobbies.get(s.lobbyId);
      send(ws, { t: "welcome", you: { id: s.id, nick: s.nick }, history: chatLog, users: userList(),
        lobbies: [...lobbies.values()].filter((x) => x.status === "open").map(publicLobby), lobby: l ? publicLobby(l) : null });
      if (l) { pushLobby(l); if (l.status === "started" && l.tickets.has(s.id)) send(ws, { t: "started", ticket: l.tickets.get(s.id) }); }
      broadcastUsers();
      return;
    }

    switch (m.t) {
      case "chat": {
        const text = clean(m.text, 300); if (!text) return;
        if (!allow(s)) return send(ws, { t: "error", msg: "You're sending messages too fast." });
        const line = { t: "chat", nick: s.nick, text, emote: !!m.emote, at: Date.now() };
        chatLog.push(line); if (chatLog.length > HISTORY) chatLog.shift();
        everyone(line);
        break;
      }
      case "create": {
        if (s.lobbyId) leaveLobby(s);
        const url = clean(m.url, 500);
        const name = clean(m.name, 36), game = clean(m.game, 30);
        if (!name || !game) return send(ws, { t: "error", code: "create", msg: "Give the game a name and say which game it is." });
        if (!gameUrlOk(url)) return send(ws, { t: "error", code: "create", msg: "The game link has to start with https://." });
        const l = {
          id: id(6), name, game, url, max: Math.min(MAX_PLAYERS, Math.max(2, Number(m.max) || 4)),
          speed: ["Fast", "Normal", "Chill"].includes(m.speed) ? m.speed : "Fast", desc: clean(m.desc, 100),
          hostId: s.id, players: [s.id], status: "open", createdAt: Date.now(), gameSockets: new Map(), tickets: new Map(),
        };
        lobbies.set(l.id, l); s.lobbyId = l.id;
        pushLobby(l); broadcastLobbies(); broadcastUsers();
        break;
      }
      case "join": {
        const l = lobbies.get(m.id);
        if (!l || l.status !== "open") return send(ws, { t: "error", code: "join", msg: "That game is no longer available." });
        if (l.players.length >= l.max) return send(ws, { t: "error", code: "join", msg: "That game is full." });
        if (s.lobbyId && s.lobbyId !== l.id) leaveLobby(s);
        if (!l.players.includes(s.id)) l.players.push(s.id);
        s.lobbyId = l.id;
        lobbyInfo(l, `${s.nick} has joined the game.`);
        pushLobby(l); broadcastLobbies(); broadcastUsers();
        break;
      }
      case "bye": s.ws = null; dropSession(s); ws.close(); return;
      case "leave": leaveLobby(s); broadcastUsers(); send(ws, { t: "lobby", lobby: null }); break;
      case "kick": {
        const l = lobbies.get(s.lobbyId);
        if (!l || l.hostId !== s.id || m.id === s.id) return;
        const p = sessions.get(m.id); if (!p || p.lobbyId !== l.id) return;
        leaveLobby(p, "was kicked by the host.");
        send(p.ws, { t: "closed", reason: "The host removed you from the game." });
        broadcastUsers();
        break;
      }
      case "gchat": {
        const l = lobbies.get(s.lobbyId); if (!l) return;
        const text = clean(m.text, 300); if (!text) return;
        if (!allow(s)) return send(ws, { t: "error", msg: "You're sending messages too fast." });
        for (const pid of l.players) send(sessions.get(pid)?.ws, { t: "gchat", nick: s.nick, text, emote: !!m.emote });
        break;
      }
      case "start": {
        const l = lobbies.get(s.lobbyId);
        if (!l || l.hostId !== s.id || l.status !== "open") return;
        l.status = "started";
        // Every player gets a personal ticket; the game passes it to sdk.js to join the relay.
        for (const pid of l.players) {
          const ticket = id(18);
          tickets.set(ticket, { lobbyId: l.id, sessionId: pid });
          l.tickets.set(pid, ticket);
          send(sessions.get(pid)?.ws, { t: "started", ticket });
        }
        lobbyInfo(l, "The host started the game.");
        pushLobby(l); broadcastLobbies();
        break;
      }
    }
  });
  ws.on("close", () => {
    if (!s || s.ws !== ws) return;
    s.ws = null;
    const l = s.lobbyId && lobbies.get(s.lobbyId);
    if (l) pushLobby(l);
    broadcastUsers();
    s.dropTimer = setTimeout(() => dropSession(s), RESUME_GRACE_MS);
  });
}

/* ---------- game relay socket (used by public/sdk.js inside games) ---------- */
function onGame(ws, ticket) {
  const tk = tickets.get(ticket);
  const l = tk && lobbies.get(tk.lobbyId);
  const s = tk && sessions.get(tk.sessionId);
  if (!l || !s || !l.players.includes(s.id)) { ws.close(4004, "invalid ticket"); return; }
  l.gameSockets.get(s.id)?.close(4002, "replaced");
  l.gameSockets.set(s.id, ws);
  const pl = publicLobby(l);
  send(ws, { t: "init", me: { id: s.id, nick: s.nick }, hostId: l.hostId, players: pl.players, lobby: { id: l.id, name: l.name, game: l.game } });
  pushLobby(l);

  let count = 0, windowStart = Date.now();
  ws.on("message", (raw) => {
    // Games may send often (positions etc.); cap at 60 msgs/sec and 16 KB each.
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > 60 || raw.length > 16_384) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== "send") return;
    const out = JSON.stringify({ t: "msg", from: s.id, data: m.data });
    if (m.to === "all" || m.to === "others") {
      for (const [pid, g] of l.gameSockets) if (m.to === "all" || pid !== s.id) g.readyState === 1 && g.send(out);
    } else {
      const target = m.to === "host" ? l.hostId : m.to;
      const g = l.gameSockets.get(target);
      if (g && g.readyState === 1) g.send(out);
    }
  });
  ws.on("close", () => {
    if (l.gameSockets.get(s.id) === ws) { l.gameSockets.delete(s.id); if (lobbies.has(l.id)) pushLobby(l); }
  });
}

const wss = new WebSocketServer({ server, maxPayload: 32_768 });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  ws.isAlive = true; ws.on("pong", () => (ws.isAlive = true));
  if (url.pathname === "/game") onGame(ws, url.searchParams.get("ticket"));
  else onClient(ws);
});
// Heartbeat so dead connections are noticed within ~30s.
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 15_000);

server.listen(PORT, () => console.log(`Rehost running on http://localhost:${PORT}`));
