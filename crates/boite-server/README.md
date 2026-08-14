# boite-server

Headless boite: PTY orchestration, git, fs and session detection over a single
WebSocket. The desktop app connects to it in "remote" mode; a phone reaches it
as a PWA served by the same binary. Threads survive client disconnects (the
server keeps the PTY and replays scrollback on reattach), and multiple devices
can attach to the same thread at once.

## Run with Docker (recommended)

The image is published on every push to master that touches the server, for
`linux/arm64` only, and the package is public, so nothing needs a registry
login. On any other architecture, build it yourself as below:

```bash
docker pull ghcr.io/beboite/boite-server:latest
```

Tags are `latest`, the `package.json` version, and `sha-<commit>`. The compose
file reads `${BOITE_IMAGE_TAG:-latest}`, so pinning a version or rolling back is
`BOITE_IMAGE_TAG=1.0.2 docker compose up -d`.

Building it yourself still works and is what `--build` below does. Built and
tested natively on `linux/arm64` (Orange Pi); `docker buildx` is not required if
you build on the target arch.

```bash
# 1. Pick a bootstrap token. It pairs devices and opens nothing else, but
#    pairing a device is granting one, so treat it like a root password.
echo "BOITE_TOKEN=$(openssl rand -hex 32)" > .env
# The name this boite is reached by from outside, so a pairing link points
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

The picker holds several boites; give each a name and color (synced to every
connected device) to tell them apart.

## Pairing a device

Every device holds its own credential, so one can be revoked without touching
any other. There is no workspace-wide password any more.

```bash
boite-server pair [--label L] [--kind K] [--scopes ...] [--minutes N] [--url BASE]
boite-server devices          # what is paired, with scopes and last seen
boite-server revoke <id>      # shut one out, at once
```

These talk to the database rather than to the running server, so they work
whether or not it is up. From a device already paired with `admin`, the same
three live in Settings -> Devices.

Opening the printed link on the new device pairs it: the one-time token rides
in the URL's **hash fragment**, so it reaches no access log, no proxy log and no
`Referer` header. It is spent on first use.

Scopes, and what each one is:

| Scope | Grants |
|---|---|
| `read` | look at the workspace: rows, git status, file contents, search, the timeline |
| `write` | change something inside a project: commit, write a file, save a todo |
| `terminal` | open, drive, resize and kill a PTY |
| `approve` | answer what an agent put in front of the user |
| `admin` | reach past a project, and pair or revoke devices |

`admin` covers `write` covers `read`. Nothing implies `terminal` or `approve`:
a PTY is arbitrary code on the machine rather than a change to a project, so a
device paired to rename projects does not come away with a shell. The default
grant is everything except `admin`.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `BOITE_TOKEN` | generated | **Bootstrap** credential. It opens `POST /api/pairings` and nothing else: it cannot open a socket, call an RPC or mint a ticket. If unset, a 32-byte hex token is generated and written to `$BOITE_DATA_DIR/token` (chmod 600). |
| `BOITE_PUBLIC_URL` | _(none)_ | What this boite is reached by from outside, used only to build the text of a pairing link. Behind a reverse proxy the server cannot work it out: the `Host` header is whatever the caller sent. |
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

A device paired with `terminal` holds a **remote shell**: it can spawn arbitrary
processes (`thread.spawn` runs any command in any cwd) and read/write files
under the project roots. Pair with the scopes a device actually needs.

Three credentials, and none of them converts into another:

| | Bootstrap token | Device credential | Socket ticket |
|---|---|---|---|
| Who holds it | the operator, in the environment | one paired device | one socket, once |
| Lives | as long as the deployment | until revoked | five minutes |
| Opens | `POST /api/pairings`, nothing else | `POST /api/ticket`, nothing else | one WebSocket |

The long-lived credential never travels in a URL and never opens a socket: it
buys a ticket over authenticated HTTP, and the ticket is worth nothing once
spent. An upgrade request carrying `?token=` or `?ticket=` is refused outright,
because a query string reaches the access log of whatever proxy is in front.

- Revoking a device takes effect immediately, including on a socket it is
  already holding: the connection is hung up and the pairing row is re-read on
  every call. `boite-server revoke` is a second process and cannot tell the
  running server anything, so the two paths carrying terminal bytes re-read the
  row as well, at most once every two seconds. A device revoked from the command
  line loses its shell without the server being restarted.
- A device can never invite another with more than it holds itself. `admin` is
  what opens `pairing.create`; the scopes it asks for are intersected with the
  caller's own before the token is minted, and the answer names what was
  actually granted. The bootstrap paths (`boite-server pair`, `POST
  /api/pairings`) are not clamped, because they are the trust root.
- The database holds a SHA-256 of each secret and never the secret, so a dump of
  it opens nothing. Every comparison is constant time.
- The server binds loopback by default. When you bind a routable interface it
  warns that credentials cross the wire in clear text on plain `http://` and
  `ws://`.
- **Always** terminate TLS in front of it (a reverse proxy) or tunnel it
  (WireGuard / Tailscale / SSH). The PWA also requires a secure context
  (HTTPS or `localhost`) to install and run its service worker; Tailscale
  Serve or Caddy with a real cert is the blessed path.
- Every door shares one per-IP lockout (5 failures -> 60s, the count persists
  across lockouts so a repeat offender stays throttled), so guesses cannot be
  spread across them for three times the tries.

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

The build and the machine are the other half of that, and nobody types them in.
`hello`, the first RPC of a connection, answers `ok` and `protocol` (`1`) plus
three fields describing the server that replied: `version`, the `boite-server`
crate version the running binary was built from; `platform`, one of `windows`,
`macos`, `linux`, `unknown`; and `host`, the machine's own name, `null` when it
has none to give. A server built before these answered the protocol alone, so a
missing field means "it did not say" and is never filled in from the client
side: the settings panel used to print the version of the bundle the browser
had downloaded one row above a line saying the workspace was somewhere else.

## Build without Docker

```bash
cargo build -p boite-server --release   # boite-core only, not src-tauri
bun run build                           # SPA -> ./build
BOITE_TOKEN=dev BOITE_STATIC_DIR=./build ./target/release/boite-server

# In another shell: invite this machine's browser.
BOITE_TOKEN=dev ./target/release/boite-server pair --url http://127.0.0.1:7337
```
