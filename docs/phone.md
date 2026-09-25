# The phone

The core serves the same UI build the desktop shell bundles, so a phone on the
same network opens Boite as a web app and drives the same threads. Nothing runs
on the phone: it is a client of the core, over the same authenticated WebSocket
the shell uses.

## Settings on a phone

At phone widths, Settings opens a vertical list with separate screens for
App & notifications, Appearance, and Machines. The back button or browser Back
returns to that list. Theme and accent belong to the current device; the
notification screen names the connected machine that will send its alerts.
Machines lets the phone pair, switch, reconnect, or remove saved connections.
Voice shows the connected core's dictation readiness. Engine installation and
API credentials stay in desktop Voice settings, including for owner sessions.
Usage shows the connected core's tokens and API cost per day, provider and
model; its subscription limits need an owner session ([usage.md](usage.md)).

Provider accounts, keyboard shortcuts, plugins, resource limits, pairing
administration and server configuration stay in desktop settings. This smaller
phone menu also applies to owner sessions; it does not change RPC permissions.

Device sessions receive only events corresponding to the state they may read.
Account login output, process traces, plugin state, quotas and core diagnostics
remain owner-only. Event permissions are deny-by-default in `access.ts`, just
like RPC permissions.

[Phone settings](images/phone-settings.png) · [Desktop settings](images/phone-settings-desktop.png)

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

On a weak link the answer carrying the key can be lost after the core made it.
The page therefore sends a `nonce` with the grant, 16 random bytes it picks once
and keeps in memory, and its retry repeats both. The core keeps that exchange's
answer until the grant's ten minutes run out or the key first says hello on its
own, and hands the same key to a retry with the same nonce. Anyone else holding
the link, without the nonce, is still refused. A nonce of another length than
16 to 256 characters, or one sent with a token, is refused by name before the
grant is spent, so a client never believes a retry is safe when it is not.

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
holds. The UI strips all three from the address bar on the first load and
never stores a grant: what it keeps is the session key that came back.

A link never replaces the stored core before its target has answered a hello.
When `core=` names a core that is neither this page's origin nor one this device
already holds a key for, the page first asks whether to connect to that host.
Anyone can send a link that points at a core they run, and that core would see
every prompt typed afterwards. Cancel opens the stored core as before. A
`core=` link to a core the device already knows reuses the key it holds for it
and asks nothing.

## The app on the phone

The browser uses mobile navigation under 720 px. Conversations lists threads
across connected machines; Activity puts waiting requests first, followed by
running and queued turns. Settings is the third destination. The header names
the machine, connection and project, and starts a new conversation.

Model, effort and action menus open as bottom sheets. Back dismisses an open
sheet. Controls have 44 px touch targets; `visualViewport` keeps the composer
above the keyboard, and the bottom navigation hides while the keyboard is open.
Safe-area insets keep controls clear of the home indicator and screen cutouts.

Draft text stays with its conversation. Four recent timelines are retained in
memory, each limited to 2,000 messages and 4 MB of text/image data, to preserve
reading positions across switches. The journal remains on the core. Settings
loads on demand, separately from the chat's initial JavaScript and stylesheet.

On returning from the background or regaining a network connection, the client
replaces a socket that may have stopped responding and reloads messages and
pending requests. It never replays outstanding RPC calls. An uncertain prompt
retry keeps its `clientRequestId`: schema 11 records the accepted turn and
content fingerprint atomically, so repeating the request returns that turn.
Reusing the id with different content is refused. This applies to every driver.
Changing the thread's model, effort or other selection before retrying creates
a new request ID for that selection.

## HTTPS and installation

HTTP on a LAN opens the chat, but service workers and push need a secure origin.
Use HTTPS for a phone; `localhost` is the development exception. The core does
not terminate TLS. A reverse proxy serves the UI and `/rpc` on one HTTPS origin.
For example, with Caddy on the same machine as a core listening on port 7337:

```caddyfile
boite.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7337
}
```

Replace the example hostname with a domain pointing at the proxy. Caddy needs
access to the ports required for its certificate challenge and public HTTPS.
Keep the core bound to loopback when the proxy is local. A private VPN still
needs a certificate the phone trusts for PWA features.

Set the matching origin in General, Phone app, Public HTTPS address. A headless
core accepts `--public-url https://boite.example.com` or `BOITE_PUBLIC_URL`.
This saves `settings.publicUrl`, uses it in new pairing links, and permits that
exact browser origin at the WebSocket gate. Clearing the setting returns links
to the core's local address. No wildcard origin or forwarded header is trusted.

On iPhone, open the pairing link in Safari, choose Share, then Add to Home Screen.
On Android, use Install Boite in Phone app or the browser's installation menu.
Open the installed icon and pair there if the browser did not carry the session
across. Installing a PWA and using Web Push require no Apple Developer account.

`packages/ui/public/sw.js` caches the files for later opens. It is plain
JavaScript that Vite copies to `dist/sw.js` with one change, the build id in
its cache name, and `lib/sw.ts` registers
it after the first paint, never before: the registration must not delay what the
user sees. It registers only where it helps, which is the core's own http(s)
origin. The Tauri shell loads the identical build from `tauri://`, where the
files are already on disk, and `?fake=1` runs on the in-memory client with no
core behind it; both are skipped. A registration that fails is one
`console.warn`, and the app runs on.

## What is cached, and what never is

One cache per build, `boite-ui-v3-<build id>`. The build id is a hash of the
file names under `dist/assets`, written into `dist/sw.js` before it is
compressed (`packages/ui/vite.config.ts`). A core update therefore serves a
different `sw.js`, the browser installs it, and activation deletes older
`boite-ui-` caches, the previous build's hashed files with them. Other
applications' caches are left alone. Before this, `sw.js` was the same file in
every build, so no new worker ever installed and every update's chunks stayed
in the one cache for good. A dev server serves the unstamped `boite-ui-v3`.

| Request | Rule |
|---|---|
| a navigation | network first, the precached shell behind it |
| `/assets/` | cache first, stored on its first whole 200 |
| `/fonts/`, `/icons/` | cache first |
| `/rpc` | never cached |
| anything carrying an `upgrade: websocket` header | never cached |
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

Installation reads the entry HTML and precaches its hashed entry assets, the
fonts, icon and manifest. Every successful navigation refreshes the offline
HTML. Network errors and HTTP 5xx responses fall back to that cached shell.
Secondary screens are cached when opened; an uncached Settings screen names
the missing connection instead of silently failing.

## Notifications while closed

General, Phone app enables Web Push for the current pairing. On iPhone this
requires a Home Screen web app on iOS 16.4 or later. Permission is requested from
the Enable notifications button. Send test notification reports whether the
push service accepted a test; delivery still depends on the device and service.

The core generates VAPID keys on first use and keeps them in private journal
settings. `push.status`, `push.subscribe`, `push.unsubscribe` and `push.test`
operate only on the authenticated pairing. Subscription URLs and encryption
keys are not placed in events or logs. The encryption library loads on demand.

Finished turns, errors, permission requests and questions trigger notifications
through the shared core event bus. Stopped turns do not, and neither do the
turns under a thread that are not news of their own: a delegated agent's turns
(its parent's next turn reports the result), a parent's turn that ends while
its agents still work, a persistent agent's finished work (read in the agents
inbox; its failures still notify) and a context compaction. Permission
requests and questions notify whichever thread asks. A desktop toast follows
the same rule, from `notifiesOnFinish` in the contracts. A click opens the
conversation, preserving an existing page and its drafts. The worker only opens
URLs on its own origin. Enable notifications from the machine's own page, not
while viewing it through another machine's UI.

A connected page retains its local notification path even when push is enabled.
For its own core, it uses the service worker and the same per-thread notification
tag as push, so the latest notification replaces the previous one. A saved push
subscription is not treated as proof that a notification reached the phone.

Disabling removes the server subscription and unsubscribes the browser.
Revocation deletes the subscription with the pairing. Push services returning
404 or 410 retire the destination. Other delivery failures leave it subscribed
and write a generic diagnostic without the provider's credential-bearing body.

## The limits

- What a phone gets with the core asleep is the app shell painting from disk, an
  empty chat, and "Connecting" in the sidebar footer until the socket comes
  back on its own. No queued messages, no offline history: the journal is on the
  core.
- Pairing is a link somebody carries over, by hand or by the QR code beside it,
  and it has to be opened within ten minutes. There is no discovery on the
  network.
- There is no Android or iOS package. The phone runs the installed web app.
- Push is a notification channel, not background execution. The core must stay
  running to run agents and send notifications; delivery is not guaranteed.
- The core must be reachable. A different network, a VPN, or a firewall that
  blocks the port all end at the same screen.
