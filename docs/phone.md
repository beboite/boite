# The phone

The core serves the same UI build the desktop shell bundles, so a phone on the
same network opens Boite as a web app and drives the same threads. Nothing runs
on the phone: it is a client of the core, over the same authenticated WebSocket
the shell uses.

## Listening on the LAN

The core binds `127.0.0.1` by default, which no other device can reach. `--lan`
binds `0.0.0.0` instead, and `--host` takes a specific address:

```bash
bun packages/core/src/main.ts --lan
```

The bind is decided when the core starts and a running core never rebinds.
General settings carries a `listenOnLan` switch, which is stored with the rest of
the settings and read by clients; the process itself takes its address from the
flag it was launched with, so changing the switch is not what opens the port
today.

Two things guard the socket whatever it is bound to. The `Origin` header must be
absent, one of the shell origins, or the core's own HTTP origin, and the first
frame must be `hello` carrying the core token within five seconds, or the socket
closes with `4001`. A phone reaching the core over the LAN passes the first check
with the core's own origin, and the second with the token from its pairing link.

## Pairing

The core prints its pairing URL on the ready line and carries it in `CoreInfo`:

```
http://192.168.1.20:53421/?token=<32 random bytes, hex>
```

The token is generated on first start and kept in `<dataDir>/core.json` with the
port and the pid, so a restart on the same data directory keeps the same link.
The link carries `?token=` alone, with no `core=`, because the page it opens is
the one the core is serving: an absent `core` parameter means the origin of this
page. `?core=<url>` is the other form, for a UI served from somewhere else and
pointed at a core elsewhere.

The UI stores the endpoint in `localStorage` and strips both parameters from the
address bar on the first load, so the token is not left sitting in history or in
a screenshot of the address bar. Treat the pairing link itself as a credential:
whoever has it has the core.

## The app on the phone

The same build, under 720 px: the sidebar becomes a drawer opened from the title,
the trace panel becomes a sheet, and the composer sticks to the bottom above the
keyboard. Nothing else changes, which is the point of one build.

`packages/ui/public/sw.js` is what makes the second open instant. It is plain
JavaScript that Vite copies to `dist/sw.js` untouched, and `lib/sw.ts` registers
it after the first paint, never before: the registration must not delay what the
user sees. It registers only where it helps, which is the core's own http(s)
origin. The Tauri shell loads the identical build from `tauri://`, where the
files are already on disk, and `?fake=1` runs on the in-memory client with no
core behind it; both are skipped. A registration that fails is one
`console.warn`, and the app runs on.

## What is cached, and what never is

One cache, `boite-ui-v1`. Every other cache is deleted on activate before the
worker claims its clients.

| Request | Rule |
|---|---|
| a navigation | network first, the precached shell behind it |
| `/assets/` | cache first, stored on its first whole 200 |
| `/rpc` | never cached |
| anything carrying an `upgrade` header | never cached |
| `/sw.js` | never cached |
| `/manifest.webmanifest` | never cached |

The socket is the only thing that carries live state, so caching the RPC path
would mean showing a conversation that already moved. The worker and the manifest
are never cached because those two decide what the next load stores, and a stale
copy of either is a cache that can no longer be updated.

The core serves the matching headers. `/assets/`, whose names are content
hashes, is `public, max-age=31536000, immutable`. The shell, `index.html`,
`/sw.js` and `/manifest.webmanifest` are `no-cache`. `/sw.js` also carries
`Service-Worker-Allowed: /`, which is what lets a worker served from that path
take the whole origin as its scope. A header test in
`packages/core/test/server.test.ts` reads them out of the served build, and an
end to end test stops the core, reloads the page and watches the shell paint
anyway.

One consequence worth knowing before writing a test about it: a service worker
caches only what passed through it, and it passes through nothing until it
controls the page. On the load that registers it, the page and its assets were
already fetched, so the cache holds only what the install step precached. The
hashed files land on the load after that, which is also the honest shape of the
feature, the phone opening Boite a second time.

## The limits

- What a phone gets with the core asleep is the app shell painting from disk, its
  first-run card, and "Connecting" in the sidebar footer until the socket comes
  back on its own. No queued messages, no offline history: the journal is on the
  core.
- Pairing is a link somebody carries over, by hand or by a QR code they make
  themselves. There is no discovery on the network.
- There is no Android or iOS package. The phone runs the web app, and a Tauri
  mobile build is a later job.
- Nothing pushes: a notification while the app is closed does not exist, because
  the only live channel is the WebSocket the page holds.
- The core must be reachable. A different network, a VPN, or a firewall that
  blocks the port all end at the same screen.
