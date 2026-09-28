# Rehost

Custom game lobbies for any browser game, in the spirit of the old WC3 custom games screen.

Pick a name and you're in. Chat in the channel, browse open games, create your own, wait for players to fill the slots, and hit **Start Game**. Everyone in the lobby gets a **Launch Game** button that opens the host's game, already connected to each other.

No accounts and no passwords. Your name is only held while you're connected.

## How it works

```
 Lobby page (public/index.html) ──WebSocket──┐
                                             ├── server.js  (chat, lobbies, relay)
 Game tab  (any site + sdk.js)  ──WebSocket──┘
```

1. The host creates a game and gives it a link to any browser game (https).
2. When the host starts, the server gives every player a one-time **ticket**.
3. **Launch Game** opens the game with `?rehost_ticket=…&rehost_server=…` added to the URL.
4. The game includes `sdk.js`, which uses the ticket to join a relay room with only that lobby's players.

The host's tab is the authority, like a hosted WC3 game: players send input to the host, and the host broadcasts the game state.

## Making a game Rehost-ready

```html
<script src="https://YOUR-REHOST-DOMAIN/sdk.js"></script>
<script>
  const net = await Rehost.connect();      // null when not launched from Rehost
  if (net.isHost) {
    net.on("message", (input, fromId) => { /* apply input */ });
    setInterval(() => net.broadcast({ type: "state", state }), 50);
  } else {
    net.on("message", (msg) => { if (msg.type === "state") state = msg.state; });
    net.send({ type: "input", dx, dy });    // goes to the host
  }
</script>
```

API: `net.me`, `net.isHost`, `net.players`, `net.send(data)` (to host), `net.broadcast(data)` (everyone else), `net.sendTo(id, data)`, `net.on("message" | "players" | "close", fn)`.

A game that doesn't include the SDK still works as a "meet here, play there" link.

See [`public/examples/coin-grab.html`](public/examples/coin-grab.html) for a complete multiplayer game in about 100 lines.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:8080 in two browser windows. Create a game with the link `http://localhost:8080/examples/coin-grab.html`, join it from the other window, start, and launch.

## Deploy on UpCloud

1. Create a server (Ubuntu 24.04; the smallest 1 CPU / 1 GB plan is plenty to start).
2. Point your domain's A record at the server's IP.
3. On the server:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Milbaxter/rehost.git && cd rehost
echo "DOMAIN=yourdomain.com" > .env
docker compose up -d --build
```

Caddy gets the HTTPS certificate automatically. Updating is `git pull && docker compose up -d --build`.

## Limits of this version

- All state is in memory on one server. A restart clears lobbies and chat, and players reconnect automatically.
- Game traffic goes through the server's relay. That's fine for turn-based and casual real-time games, and adds roughly one round-trip to the server for fast action games.
- The ping bars in the user list are cosmetic for now.

## License

MIT
