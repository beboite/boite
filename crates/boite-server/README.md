# boite-server

Headless boite: PTY orchestration, git, fs and session detection over a single
WebSocket. The desktop app connects to it in "remote" mode; a phone reaches it
as a PWA served by the same binary. Threads survive client disconnects (the
server keeps the PTY and replays scrollback on reattach), and several devices
can attach to one thread at once.

## Run with Docker

The image is published on every push to master that touches the server, for
`linux/arm64` only, and the package is public. On any other architecture, build
it yourself with `--build` below.

```bash
docker pull ghcr.io/beboite/boite-server:latest
```

Tags are `latest`, the `package.json` version, and `sha-<commit>`. The compose
file reads `${BOITE_IMAGE_TAG:-latest}`, so pinning or rolling back is
`BOITE_IMAGE_TAG=1.0.2 docker compose up -d`.

```bash
# 1. Pick a bootstrap token. It pairs devices and opens nothing else, but
#    pairing a device is granting one, so treat it like a root password.
echo "BOITE_TOKEN=$(openssl rand -hex 32)" > .env
# What this boite is reached by from outside, so a pairing link points
# somewhere. Behind a reverse proxy the server cannot work this out itself.
echo "BOITE_PUBLIC_URL=https://boite.example" >> .env
# optional mobile notifications:
# echo "BOITE_WEBHOOK_URL=https://ntfy.sh/your-private-topic" >> .env
# echo "BOITE_WEBHOOK_FORMAT=ntfy" >> .env

# 2. Build + run.
docker compose up -d --build

# 3. Log claude in (one time; persisted in ./claude via the volume).
docker exec -it boite claude
#   ... or set ANTHROPIC_API_KEY in the environment instead of OAuth.

# 4. Put repos to work on under ./workspace (mounted at /workspace).

# 5. Invite the first device. Prints a QR and a link, good once and for ten
#    minutes; open it on the phone or laptop you are adding.
docker exec boite boite-server pair --label "my phone" --kind phone
```

## Pairing a device

Every device holds its own credential, so one can be revoked without touching
another. There is no workspace-wide password.

```bash
boite-server pair [--label L] [--kind K] [--scopes ...] [--minutes N] [--url BASE]
boite-server devices          # what is paired, with scopes and last seen
boite-server revoke <id>      # shut one out, at once
```

These talk to the database rather than the running server, so they work whether
or not it is up. From a device paired with `admin`, the same three live in
Settings -> Devices.

Opening the printed link pairs the device: the one-time token rides in the URL's
**hash fragment**, so it reaches no access log, no proxy log and no `Referer`
header, and it is spent on first use.

| Scope | Grants |
|---|---|
| `read` | look at the workspace: rows, git status, file contents, search, the timeline |
| `write` | change something inside a project: commit, write a file, save a todo |
| `terminal` | open, drive, resize and kill a PTY |
| `approve` | answer what an agent put in front of the user |
| `admin` | reach past a project, and pair or revoke devices |

`admin` covers `write` covers `read`. Nothing implies `terminal` or `approve`: a
PTY is arbitrary code on the machine rather than a change to a project, so a
device paired to rename projects does not come away with a shell. The default
grant is everything except `admin`.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `BOITE_TOKEN` | generated | **Bootstrap** credential. Opens `POST /api/pairings` and nothing else: no socket, no RPC, no ticket. If unset, a 32-byte hex token is written to `$BOITE_DATA_DIR/token` (chmod 600). |
| `BOITE_PUBLIC_URL` | _(none)_ | What this boite is reached by from outside, for pairing links and notification deep links. Behind a reverse proxy the server cannot work it out: `Host` is whatever the caller sent. |
| `BOITE_BIND` | `127.0.0.1:7337` | Listen address. The Docker image sets `0.0.0.0:7337`. |
| `BOITE_DATA_DIR` | `./boite-data` | SQLite DB + token file. |
| `BOITE_STATIC_DIR` | _(none)_ | Built SvelteKit SPA to serve. The image sets `/app/web`. |
| `BOITE_WORKSPACE_DIR` | _(none)_ | Base dir the web folder picker can browse. The image sets `/workspace`. |
| `BOITE_SCROLLBACK_BYTES` | `1048576` | Per-thread replay ring size. |
| `BOITE_MAX_THREADS` | `200` | Max concurrent live PTYs. |
| `BOITE_MAX_CONNECTIONS` | `64` | Max concurrent WebSocket connections. |
| `BOITE_WEBHOOK_URL` | _(none)_ | Notification webhook, fired on ready / waiting / exit. Must be `http(s)`. |
| `BOITE_WEBHOOK_FORMAT` | `json` | `ntfy`, `discord`, or `json`. |

## Security

A device paired with `terminal` holds a **remote shell**: `thread.spawn` runs
any command in any cwd, and files under the project roots are readable and
writable. Pair with the scopes a device needs.

Three credentials, and none converts into another:

| | Bootstrap token | Device credential | Socket ticket |
|---|---|---|---|
| Who holds it | the operator, in the environment | one paired device | one socket, once |
| Lives | as long as the deployment | until revoked | five minutes |
| Opens | `POST /api/pairings`, nothing else | `POST /api/ticket`, nothing else | one WebSocket |

- The long-lived credential never travels in a URL and never opens a socket: it
  buys a ticket over authenticated HTTP. An upgrade carrying `?token=` or
  `?ticket=` is refused, since a query string reaches the proxy's access log.
- Revoking takes effect immediately, including on a socket already held: the
  connection is hung up, and the two paths carrying terminal bytes re-read the
  pairing row at most every two seconds, so a revoke from the command line
  reaches a running server without a restart.
- A device can never invite another with more than it holds: `admin` opens
  `pairing.create`, the scopes asked for are intersected with the caller's, and
  the answer names what was granted. The bootstrap paths are the trust root and
  are not clamped.
- The database holds a SHA-256 of each secret and never the secret. Every
  comparison is constant time.
- One per-IP lockout across every door (5 failures -> 60s, the count persists,
  so a repeat offender stays throttled).
- The server binds loopback by default and warns when you bind a routable
  interface. **Always** terminate TLS in front of it or tunnel it (WireGuard,
  Tailscale, SSH). The PWA needs a secure context to install its service worker,
  so Tailscale Serve or Caddy with a real cert is the blessed path.

## Mobile notifications

Set `BOITE_WEBHOOK_URL` to an [ntfy](https://ntfy.sh) topic (or a Discord /
Gotify webhook). The server POSTs when a thread finishes a turn, blocks on the
user, or exits, so an ntfy app delivers a native push with the app closed.
`notify.test` (RPC) fires one, and takes an optional `threadId` so the test
carries a real link.

Native PWA Web Push (VAPID, RFC 8291) is wired in too: a keypair is generated on
first run and the same transitions are pushed down. It uses `web-push-native`
(pure RustCrypto: aes-gcm + hkdf + p256), so there is no OpenSSL dependency and
it cross-compiles cleanly.

Both are built from one value, `boite_core::awareness`: a phase
(`starting | running | waiting_for_approval | waiting_for_input | completed |
failed | stale`), a headline, a detail, the project and thread, and a deep link.
Only the envelope differs: ntfy gets `Title`/`Tags`/`Priority`/`Click`, Discord
an embed coloured by phase, the generic JSON keeps `title`/`body`/`tag` for
consumers written against the old shape and carries the whole value under
`awareness`. Web Push sends `{title, body, tag, url, phase, threadId}` and the
service worker resolves `url` against its own origin, so the server never
guesses the address a browser reached it at.

**Answering from the notification.** A `waiting` thread has a dialog up.
`thread.reply` writes one keystroke into it: `{threadId, answer}` where `answer`
is one of `yes | no | enter | escape | 1..9` and nothing else. The vocabulary is
`boite_core::reply`, closed, every arm a one-byte constant, and only `enter`
submits a line. It is a device call, not an agent one: deliberately absent from
the command bus and the agent endpoint, because an agent that could answer its
own permission prompts would not have permission prompts. It does not require
the socket to have attached to the thread, since the caller it exists for is a
phone that never opened it.

## Workspace identity

Each server carries a cosmetic name and color, persisted in the settings table
and shared by every connected device (`workspace.info` reads it,
`workspace.setInfo` changes it and broadcasts, name trimmed to 64 chars, color
validated as hex). The client maps it to the picker label and the connection
outline.

`hello`, the first RPC of a connection, answers `ok` and `protocol` (`1`) plus
`version`, `platform` (`windows | macos | linux | unknown`) and `host`, `null`
when the machine has no name. A server built before these answered the protocol
alone, so a missing field means "it did not say" and is never filled in from the
client side: the settings panel used to print the version of the bundle the
browser had downloaded, one row above a line saying the workspace was elsewhere.

## Build without Docker

```bash
cargo build -p boite-server --release   # boite-core only, not src-tauri
bun run build                           # SPA -> ./build
BOITE_TOKEN=dev BOITE_STATIC_DIR=./build ./target/release/boite-server

# In another shell: invite this machine's browser.
BOITE_TOKEN=dev ./target/release/boite-server pair --url http://127.0.0.1:7337
```
