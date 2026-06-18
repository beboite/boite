# boite-server

Headless boite: PTY orchestration, git, fs and session detection over a single
WebSocket. The desktop app connects to it in "remote" mode; a phone reaches it
as a PWA served by the same binary. Threads survive client disconnects (the
server keeps the PTY and replays scrollback on reattach), and multiple devices
can attach to the same thread at once.

## Run with Docker (recommended)

Built and tested natively on `linux/arm64` (Orange Pi). `docker buildx` is not
required: build on the target arch.

```bash
# 1. Pick a token (this is the only credential; treat it like a root password).
echo "BOITE_TOKEN=$(openssl rand -hex 32)" > .env
# optional mobile notifications:
# echo "BOITE_WEBHOOK_URL=https://ntfy.sh/your-private-topic" >> .env
# echo "BOITE_WEBHOOK_FORMAT=ntfy" >> .env

# 2. Build + run.
docker compose up -d --build

# 3. Log claude in (one time; persisted in ./claude via the volume).
docker exec -it boite claude
#   ... or set ANTHROPIC_API_KEY in the environment instead of OAuth.

# 4. Put repos to work on under ./workspace (mounted at /workspace).
```

Then add it from the desktop app's workspace picker (titlebar) as
`ws://<host>:7337/ws` with the token, or open `http://<host>:7337/` in a
browser / install the PWA. The picker holds several boites; give each a name
and color (synced to every connected device) to tell them apart.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `BOITE_TOKEN` | generated | Bearer token; sent as the first WS frame. If unset, a 32-byte hex token is generated and written to `$BOITE_DATA_DIR/token` (chmod 600). |
| `BOITE_BIND` | `127.0.0.1:7337` | Listen address. The Docker image sets `0.0.0.0:7337`. |
| `BOITE_DATA_DIR` | `./boite-data` | SQLite DB + token file. |
| `BOITE_STATIC_DIR` | _(none)_ | Directory of the built SvelteKit SPA to serve. The image sets `/app/web`. |
| `BOITE_WORKSPACE_DIR` | _(none)_ | Base dir the web folder picker can browse to add projects. The image sets `/workspace`. |
| `BOITE_SCROLLBACK_BYTES` | `1048576` | Per-thread replay ring size. |
| `BOITE_MAX_THREADS` | `200` | Max concurrent live PTYs. |
| `BOITE_MAX_CONNECTIONS` | `64` | Max concurrent WebSocket connections. |
| `BOITE_WEBHOOK_URL` | _(none)_ | Notification webhook fired on a thread going ready / exiting. |
| `BOITE_WEBHOOK_FORMAT` | `json` | `ntfy`, `discord`, or `json`. |

## Security

The token is a **remote shell**: an authenticated client can spawn arbitrary
processes (`thread.spawn` runs any command in any cwd) and read/write files
under the project roots. Treat the token like an SSH key.

- The server binds loopback by default. When you bind a routable interface it
  warns that the token crosses the wire in clear text on plain `ws://`.
- **Always** terminate TLS in front of it (a reverse proxy) or tunnel it
  (WireGuard / Tailscale / SSH). The PWA also requires a secure context
  (HTTPS or `localhost`) to install and run its service worker; Tailscale
  Serve or Caddy with a real cert is the blessed path.
- Auth is a constant-time compare with a per-IP lockout (5 failures -> 60s, the
  count persists across lockouts so a repeat offender stays throttled).

## Mobile notifications

Set `BOITE_WEBHOOK_URL` to an [ntfy](https://ntfy.sh) topic (or a Discord /
Gotify webhook). The server POSTs when a thread finishes a turn (running ->
ready) or its process exits, so an ntfy app on the phone delivers a native
push even with the app closed. `notify.test` (RPC) fires a test notification.

Native PWA Web Push (VAPID, RFC 8291) is also wired in: the server generates a
keypair on first run, the PWA subscribes its browser push endpoint, and the
server pushes on a thread going ready or exiting. It uses `web-push-native`
(pure RustCrypto: aes-gcm + hkdf + p256), so there is no OpenSSL/C dependency
and it cross-compiles cleanly. The webhook above is the complementary path for
non-PWA targets (ntfy/Discord/Gotify).

## Workspace identity

Each server carries a cosmetic name + color, persisted in the settings table
and shared by every connected device. `workspace.info` reads it; any client
can change it with `workspace.setInfo` (name trimmed to 64 chars, color
validated as a hex string), and the server broadcasts a `workspace.info`
control event so the other devices update live. It is purely cosmetic: the
client maps it to the workspace picker label and the connection outline color.

## Build without Docker

```bash
cargo build -p boite-server --release   # boite-core only, not src-tauri
bun run build                           # SPA -> ./build
BOITE_TOKEN=dev BOITE_STATIC_DIR=./build ./target/release/boite-server
```
