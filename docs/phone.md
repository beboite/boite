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

The `listenOnLan` switch in General settings is the same decision without a
command line: the core reads it from the journal at start, before it binds, and
`0.0.0.0` is what it binds when the switch is on. A `--host` or a `--lan` on the
command line always wins over it, because the person who typed the flag meant it.
The address is read once and a running core never rebinds, so a switch flipped
while the core is up takes effect the next time it starts. That is what the line
under the switch says, and one `core.log` line at start names the address and the
setting that chose it.

Two things guard the socket whatever it is bound to. The `Origin` header must be
absent, one of the shell origins, or the core's own HTTP origin, and the first
frame must be `hello` carrying a credential within five seconds, or the socket
closes with `4001`. A phone reaching the core over the LAN passes the first check
with the core's own origin, and the second with the session key its pairing link
became.

## Pairing

A pairing link is minted from the desktop app, in Settings under "Phones and
other devices", drawn beside a QR code the phone's camera opens:

```
http://192.168.1.20:53421/?grant=<32 random bytes, hex>
```

Asking is the only way to get one. The core used to print a live grant on its
ready line at every start, which put a working session key in every log file and
every terminal scrollback that had seen the core boot.

The grant inside it is not the core token. It is a one-time id the core
remembers for ten minutes: the page that opens the link says `hello` with it,
the core exchanges it for a session key of that device's own, and the grant is
forgotten on the spot. A link opened twice, or after its time, is refused by
name. The core token itself stays in `<dataDir>/core.json`, where the shell
reads it, and travels nowhere.

A link carries a role. `device` is the default and the only one the QR code is
drawn for: a phone, whose key says hello as `session` and reaches the list below.
`owner` is for another computer of the owner's that drives a core running
elsewhere, a server say: its key says hello as `owner` and reaches every method,
minting links and revoking included. The "Full control" switch of the pairing
card mints one, `boite-core pair --owner` mints one on a machine with no window
([server.md](server.md)), and the Connection card of the other computer takes it
pasted. A role anything but those two is refused by name.

Session keys are stored hashed in the journal, so a core restart keeps every
pairing and a copy of the journal holds no credential. `sessions.list` shows
every paired device with the client it said it was, its role and when it was last seen;
`sessions.revoke`, the Revoke button of the same card, closes its sockets and
deletes the row, after which its key opens nothing.

## What a paired device may call

`packages/core/src/access.ts` holds the whole boundary, as one list the router
checks before any handler runs. Read it as the phone's screen: the sidebar, a
thread, the composer, the cards an agent raises, and the settings it only
displays. Nothing on that list writes outside a thread, names a path on the
machine, starts a process of its own or changes what the core trusts.

A method absent from the list is the owner's, and a method added tomorrow is
refused to a device until someone puts it there on purpose. That is the point of
the shape: the gate is deny by default, so the boundary cannot be widened by
forgetting. A refusal names the method (`projects.add is for the owner only`).

The owner is whoever holds the core token, which means the desktop shell and
anything else that can read `core.json`, or a key paired with the `owner` role. Until this list existed, a paired phone
could add a project pointing anywhere on the machine, start a thread with a
working directory of its own, turn on `listenOnLan` and read files through a
provider dry run: everything the owner could do except pairing another device.

The link carries `?grant=` alone, with no `core=`, because the page it opens is
the one the core is serving: an absent `core` parameter means the origin of this
page. `?core=<url>` is the other form, for a UI served from somewhere else and
pointed at a core elsewhere, and `?token=` opens a page on a token one already
holds. The UI strips all three from the address bar on the first load, stores
the endpoint in `localStorage`, and never stores a grant: what it keeps is the
session key that came back.

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
- Pairing is a link somebody carries over, by hand or by the QR code beside it,
  and it has to be opened within ten minutes. There is no discovery on the
  network.
- There is no Android or iOS package. The phone runs the web app, and a Tauri
  mobile build is a later job.
- Nothing pushes: a notification while the app is closed does not exist, because
  the only live channel is the WebSocket the page holds.
- The core must be reachable. A different network, a VPN, or a firewall that
  blocks the port all end at the same screen.
