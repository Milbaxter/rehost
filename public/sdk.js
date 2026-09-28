/*
 * Rehost game SDK. Add to any browser game:
 *
 *   <script src="https://YOUR-REHOST-SERVER/sdk.js"></script>
 *   const net = await Rehost.connect();   // null if the game wasn't launched from Rehost
 *   net.me        -> { id, nick }
 *   net.isHost    -> true for the player who created the game
 *   net.players   -> [{ id, nick, inGame }]
 *   net.send(data)            // to the host (typical for client -> host input)
 *   net.broadcast(data)       // to everyone else in the game
 *   net.sendTo(playerId, data)
 *   net.on("message", (data, fromId) => {})
 *   net.on("players", (players) => {})
 *   net.on("close", () => {})
 *
 * The host's tab is the authority, like a hosted WC3 game: other players send
 * their input to the host, the host broadcasts the game state.
 */
(function () {
  function connect(opts) {
    opts = opts || {};
    const params = new URLSearchParams(location.search);
    const ticket = opts.ticket || params.get("rehost_ticket");
    const server = opts.server || params.get("rehost_server");
    if (!ticket || !server) return Promise.resolve(null);

    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(server.replace(/\/$/, "") + "/game?ticket=" + encodeURIComponent(ticket));
      const handlers = { message: [], players: [], close: [] };
      const emit = function (ev) { const a = [].slice.call(arguments, 1); handlers[ev].forEach(function (h) { h.apply(null, a); }); };
      const out = function (to, data) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "send", to: to, data: data })); };
      let api = null;

      ws.onmessage = function (e) {
        const m = JSON.parse(e.data);
        if (m.t === "init") {
          api = {
            me: m.me, hostId: m.hostId, isHost: m.me.id === m.hostId, players: m.players, lobby: m.lobby,
            send: function (data) { out("host", data); },
            broadcast: function (data) { out("others", data); },
            sendTo: function (id, data) { out(id, data); },
            on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return api; },
            close: function () { ws.close(); },
          };
          resolve(api);
        } else if (m.t === "players" && api) {
          api.players = m.players; emit("players", m.players);
        } else if (m.t === "msg") {
          emit("message", m.data, m.from);
        }
      };
      ws.onclose = function (e) { if (!api) reject(new Error("Rehost: " + (e.reason || "could not connect"))); else emit("close"); };
    });
  }
  window.Rehost = { connect: connect };
})();
