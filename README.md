# INKWAVE · Turf War

**English** | [简体中文](README.zh-CN.md)

A 5v5 ink turf-war shooter in the browser. Up to 10 players, 5 per team; empty slots are filled by bots. The original game's visuals, weapons, maps and rules are preserved. The UI is in English by default; use the language button on the right edge of the screen (outside matches) to switch to Chinese.

Live: <https://inkwave.teable.app>

## Multiplayer

- **Browser direct**: entry point `/?mode=public&lobby=1`. The lobby opens automatically once the game has loaded; share links carry `mode=public&room=...&lobby=1`, so friends never land in WSS by mistake. Uses the real PeerJS Cloud signaling server and WebRTC. A signaling timeout shows an error and allows a manual retry; connectivity across every NAT is not guaranteed.
- **WSS**: `socket-server.app.teable.cn:8443/ws` with a dedicated `inkwave` room protocol. Invites carry `mode=wss&server=...&room=...&key=...&lobby=1`. Explicit WSS invites never silently downgrade.
- When no mode is specified, the app only queries `/status` on the fixed default server. It picks WSS only when it reports `inkwaveProtocol:1`; otherwise it selects browser direct and clearly distinguishes "server not deployed yet" from "status unknown". The default choice is not a claim that a connection succeeded. The server and room key fields are only shown in WSS mode.
- WebRTC uses a separate unordered, no-retransmit position channel that only keeps the latest value per actor; combat events are sent reliably. Connection management follows the earlier transport-ship app (`appxgqUvkYHpGGkXtuu/lib/public-peer-client.ts`): signaling and direct-connection phases are tracked separately, each connection times out after 30 seconds, and signaling recovers at most 3 times with at least 5 seconds between attempts. Recovering signaling never creates duplicate player connections.
- The lobby can export a connection log: the browser keeps the last 5 sessions from the past 7 days, up to 400 entries each. Only connection phases and ICE states are recorded — never SDP, candidate IPs, keys or game packets.
- **LAN**: choose the LAN server in the lobby. Download `/downloads/inkwave-local.zip`, unzip it and run `node server.mjs`; everyone opens the same computer's address. The download also supports 10 players and falls back to an HTTP relay when direct connections fail.

In WSS mode the game simulation still runs in the browser and the host computes the bots. The server relays messages, and clients skip the old host re-broadcast. The full 10-actor roster is committed atomically with the start request. Positions are merged per actor, and ink packets carry at most 256 entries / 48 KiB each. A disconnect exits the match explicitly; full ink-state recovery is not claimed. The server address can be changed in the lobby.

When a match starts and the browser has not yet granted pointer lock, a **Click to Enter the Match** prompt is shown. Every player has to click it themselves, then hold the left mouse button to shoot; a network message cannot stand in for this user gesture. If permission fails you can click again, and after pressing Esc you can still continue through the regular pause menu.

The bottom-left corner shows frame rate, latency, the active channel and congestion hints during a match. Keys 1–4 super-jump to your four teammates, and 5 returns to base.

## Tests and limitations

- `node tests/ten-player-wss.cjs`: 10-seat protocol test against a mocked WebSocket — atomic start, position merging and conversion, ink packet splitting, disconnects and rejection by old servers; plus a real local API test for 10 players, rejecting an 11th player and a full 5-player team. The mocked protocol is not a production end-to-end test.
- `node tests/multiplayer-smoke.cjs`: two clients over real public signaling and WebRTC — separate position channel, congestion merging, stale packet rejection and room actions.
- `node tests/relay-smoke.cjs`: local HTTP relay.
- `node tests/lobby-entry.cjs`: invite mode priority, capability states, WSS field visibility, URL cleanup, and ink binding when a guest finishes loading first or the map changes.
- `node tests/public-scene.cjs`: full game load, two browsers joining via share link over real public signaling and WebRTC, 10-actor start, ready sync, actor positions and one ink sync. The simulation is stepped manually on a software GPU and is not a frame-rate benchmark.
- `node tests/remote-visibility.cjs`: reproduces and verifies the fix for actors hidden before their first position packet never reappearing; also checks death and respawn.
- `node tests/peer-lifecycle.cjs`: deterministic simulation of the signaling lifecycle — timeout phases, bounded reconnects, no duplicate player connections after recovery, and log persistence. Real networking is covered by separate tests.
- `node tests/pointer-control.cjs`: pointer permission denial and manual retry, acquiring lock with a real click, pressing/releasing the fire button, cleanup when lock is released, the pause menu and gamepad compatibility.
- `node tests/public-shooting.cjs`: two-player shooting in the real scene over real PeerJS/WebRTC. The host starts the match after the guest's user activation has expired; bullets, ink consumption and remote reception are verified with real mouse input, without injecting fire state. Set `GAME_BASE_URL` to run against the production site. Stepped simulation on a software GPU is not a frame-rate test.
- `node tests/game-smoke.cjs`: loads the game on a software GPU, creates a LAN room and starts a 10-actor match.

Deploying the WSS server is handled separately by the PLAYROOM app. Publishing this web app does not mean the server is deployed or that performance has been validated on 10 real devices. Game simulation and GPU load still depend on each player's device — especially the host, who runs the bots.

## License

[MIT](LICENSE)
