# The phone

A phone opens the UI served by the core and connects over authenticated
WebSocket. Agents and the journal remain on the core machine.

## Settings on a phone

The top-right menu opens Conversations, Activity and Settings. There is no
bottom navigation bar. A conversation uses one compact header; Back returns
to the thread list, which includes a search field. The composer stays at the
bottom of the available viewport, above the keyboard when it is open.

At phone widths, Settings opens a vertical list with separate screens for
App & notifications, Appearance, and Machines. The back button or browser Back
returns to that list. Theme and accent belong to the current device; the
notification screen names the connected machine that will send its alerts.
Machines lets the phone pair, switch, reconnect, or remove saved connections.
"Scan a QR code" reads a pairing link through the camera; "Paste a pairing
link" accepts text. Chrome uses `BarcodeDetector` when available; the fallback
loads jsQR on the first scan. Decoding stays on the device. Other QR content
leaves the scanner open. The camera requires HTTPS and closing the view stops
its tracks. A new machine takes the hostname reported by its core; its card
can rename it.
Voice shows the connected core's dictation readiness. Engine installation and
API credentials stay in desktop Voice settings, including for owner sessions.
Usage shows the connected core's tokens and API cost per day, provider and
model; its subscription limits need an owner session ([usage.md](usage.md)).

Provider accounts, keyboard shortcuts, plugins, resource limits, pairing
administration and server configuration stay in desktop settings. This smaller
phone menu also applies to owner sessions; it does not change RPC permissions.

Device sessions receive only events corresponding to the state they may read.
Account login output, process traces, plugin state, quotas and core diagnostics
remain owner-only. Event permissions are deny-by-default in
`packages/contracts/src/access.ts`, just like RPC permissions, and `?fake=1`
with `principal=session` withholds the same events.

[Phone settings](images/phone-settings.png) · [Desktop settings](images/phone-settings-desktop.png)

## Listening on the LAN

The core binds `127.0.0.1` by default, which no other device can reach. `--lan`
binds `0.0.0.0` instead, and `--host` takes a specific address:

```bash
bun packages/core/src/main.ts --lan
```

Settings, Machines and updates, Listen on LAN saves `listenOnLan`. The core
reads it at startup; enabling it binds `0.0.0.0`. Explicit `--host` or `--lan`
flags take precedence. A running core never rebinds, so changing the switch
requires a restart. The startup log names the address and its source.

Without `--port`, the core reuses the port in `core.json`. If it is taken, the
core chooses another and logs it; a phone then needs a new link. An explicit
`--port` fails when occupied. A listener on all interfaces puts the machine's
LAN address in pairing links, rather than loopback.

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

Close hides the link and QR code, and New pairing link creates another one.
Closing leaves an already issued link valid until it is used or expires.

The owner must request a link. Startup logs contain no grant or session key.

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

### Pairing codes, and an owner QR code

A device link also comes with a code, `XXXX-XXXX` in Crockford base32, shown
under the QR code. **Type a pairing code** on the installed app's pairing
screen takes it, in any case, with or without the dash, `O` and `I`/`L` read as
`0` and `1`. The code names the same one-time grant: the app sends it in `hello`
as the grant, on the origin that served the page, with the same nonce retry.
The installed iPhone app needs it because the Camera app hands a link to
Safari, whose storage the home-screen app does not share.

A code is good for five minutes at most, and once: using the link spends it,
and a code typed after the link was used is refused like a wrong one, by name.
Eight letters are 40 bits; ten wrong codes in a row drop every live code (the
links keep working, a new link brings a new code), so guessing one is out of
reach. The refusal never says whether a code existed.

An owner link is pasted, not drawn, because a QR code on screen is a camera
away from any phone in the room. **QR code for a phone** on an owner link draws one
after a confirmation on the computer: that grant is minted `short`, lives five
minutes instead of ten, is still single use, and carries a code too. Expiry,
revocation and the nonce rule are unchanged for every grant.

Session keys are stored hashed in the journal, so pairings survive restart
without storing the recoverable key there. `sessions.list` shows
every paired device with the client it said it was, its role and when it was last seen;
`sessions.revoke`, the Revoke button of the same card, closes its sockets and
deletes the row, after which its key opens nothing.

## What a paired device may call

`packages/contracts/src/access.ts` defines the paired-device method/event
allowlists; the real router and in-memory client enforce them before handlers.
They cover conversation lists, prompts, agent cards and permitted read-only
settings. Methods absent from the list remain owner-only, including newly
added methods. A refusal names the method, such as
`projects.add is for the owner only`.

The Changes and Files panels are read-only on a paired device: `git.status`,
`git.diff`, `files.list` and `files.read`, never `files.write`, Tasks or the
trace. The core runs git itself, refuses a device diff against any revision but
`HEAD`, and before every read checks that the thread's real working directory is
inside its project or the core's worktree folder for it; each path is then held
inside that directory, links included. Inside it a device still cannot read
boite's data folder, folders such as `.git`, `.ssh` and `.aws`, or files that
hold credentials (`.env`, `.envrc`, `.netrc`, `.pgpass`, Terraform variables and
state, private keys, Java keystores; `workdir.ts` has the list). No list of
names covers everything: a project that is a home folder also exposes `.config`,
where many tools keep their tokens, so make a narrower folder the project when a
phone is paired. At a phone's width the Changes panel shows
the list, then one diff with Back and previous/next file; a file reads as wrapped,
numbered lines with no editor.

An owner holds the core token from `core.json` or an owner-paired session key.
Only owners can choose arbitrary host paths, administer providers or change
what the core trusts. [Machine routing](machines.md#isolation-and-tests) keeps
each connection's IDs, Store and actions on their owning core.

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
running and queued turns. A phone has no right-click, so the actions a desktop
finds there open from a tap: the conversation's title in its header lists
rename, regenerate title, pin, copy path and archive, and the `...` button of a
row in the list offers pin, regenerate title and archive. The same title sheet
holds the Agents and Terminal toggles, so the header row keeps only the title,
the context ring and the Panel button: at 360 px in French, 192 px of a 193 px
title stay visible, where 96 px did with the toggles in the row. A draft's header shows its "New thread" label. Settings is the third destination. The header names
the machine, connection and project, and starts a new conversation.

Model, effort and action menus open as bottom sheets. The browser's Back, the
Android Back gesture and a mouse's back button close the top sheet, dialog,
context popup or right panel first, then return from a conversation to the
list it was opened from. Each of those owns one history entry
(`lib/mobile-history.ts`); closing it by a button removes that entry, so Back
never lands on something already closed. The conversation the app opens on has
no list behind it, and Back from there leaves the app as before.

Every button on the chat, the list, the panel and Appearance registers a tap
19 px from its centre on either axis, and `--touch-target` is 44 px. Some controls
keep a small look and get a larger hit box, such as the project name in the
header, a panel tab's icon, which closes the tab, and the accent dots. Under a
finger, the outline rail beside the conversation gives each prompt a 44 px row
and scrolls, and the text starts past the rail. A switch sits in a label that
covers its whole row, so the row is its target. The end-to-end sweep in
`tests/e2e/mobile.test.ts` measures this with touch emulation on.
CSS `100dvh` sets the app height in a browser tab. An installed iPhone app uses
`100vh` when its top safe-area inset shows that the page extends behind the
status bar. WebKit can under-report `dvh` as well as `visualViewport.height`
on launch ([WebKit 254868](https://bugs.webkit.org/show_bug.cgi?id=254868)).
The root containers use the same height as the app. While a text field is focused and the keyboard
reduces the visible viewport, `visualViewport` keeps the composer above it and
the bottom navigation hides. Closing the keyboard restores the mode's height;
a shorter viewport reported during an iPhone app launch does not leave a gap
below the navigation.
Safe-area insets keep controls clear of the home indicator and screen cutouts:
the chat header, the full-screen right panel, and the Agents and Settings pages
all start below the status bar of an installed app on a notched iPhone.

Draft text stays with its conversation. Four recent timelines are retained in
memory, each limited to 2,000 messages and 4 MB of text/image data, to preserve
reading positions across switches. The journal remains on the core. Settings
loads on demand, separately from the chat's initial JavaScript and stylesheet.

[Reconnection and prompt retries](machines.md#connecting-a-machine) replace
unresponsive sockets and reload messages/cards without replaying arbitrary RPCs.
Uncertain prompt retries retain `clientRequestId`; schema 11 atomically records
the accepted turn and content fingerprint. Different content is refused, and
changing a selection before retry creates a new ID. This applies to every driver.

### Oldest browsers

The UI starts on Safari 15.4 (iOS and iPadOS 15.4) and Chrome 111 or newer. The
build target lowers syntax only, so what those engines lack is refused where it
would ship: `packages/ui/vite.config.ts` fails the build on a regex lookbehind or
a copying array method (`toSorted`, `toReversed`, `toSpliced`) in any chunk, and
`src/lib/browser-floor.test.ts` checks the sources the same way. A lookbehind is
a parse error before Safari 16.4, and one in a startup chunk used to leave iOS 15
with a blank page.

The floor check covers syntax and methods. The CSS/DOM features below require
Safari 17 and Chrome 114 for the complete layout:

| Feature | Safari | Chrome | Without it |
| --- | --- | --- | --- |
| `color-mix()` | 16.2 | 111 | The shared accent tint has a plain fallback; a few one-off tints are not drawn. |
| Container queries | 16.0 | 105 | The narrow rules are ignored and the wide layout stays at phone width: the panel's Agents surface and the usage limits (`<= 520px`), the usage table's hidden columns (`<= 560px`, `<= 420px`), the plugin rows (`<= 560px`), the onboarding scenes (`<= 400px`). The changes list keeps the diff under it, which is its phone layout anyway. |
| Popover API | 17.0 | 114 | `lib/floating.ts` calls `showPopover` only when it exists, so the phone menus and their backdrop are not moved to the top layer. A menu inside the composer is then placed against the composer's glass layer instead of the viewport, and can land off its anchor. |

This table describes features in the built CSS and `lib/floating.ts`. It does
not record real Safari 15/16 device testing.

A browser under the floor fails to parse the app, so `main.ts` never runs. An
inline script in `index.html` notices on `load` and writes one sentence in the
page instead: this browser cannot start Boite, and the versions it needs.

## Pictures and videos

Screenshots and photos shrink before they leave the phone: 2048 px on the long
edge, JPEG or PNG, HEIC converted to JPEG by Safari. A turn takes twenty
files ([development.md](development.md#file-attachments)). While a question
waits, the composer's paperclip attaches them to the answer.

A picture or a video in the thread opens full screen (`ImageViewer.svelte`).
Pinch or double-tap to zoom, drag a zoomed picture to pan, swipe sideways to
the thread's other pictures and videos, and drag down to close. Share opens
the system sheet with the file itself, so Save Image or Save to Files keeps it;
where the browser has no share sheet, the file downloads. A remote file is
fetched on the first tap, which may come too late for iOS to open the sheet:
the viewer then says the file is ready, and the next tap shares it.

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

### Through Tailscale

On a tailnet the phone is already on, Settings, Machines, Phone app has
**HTTPS through Tailscale**. It reads the `tailscale` CLI (found on `PATH`, or
where the installers put it on Windows, macOS and Linux; `BOITE_TAILSCALE_CLI`
names another) and says which of these it found, with the way out of each:

| State | Meaning | Offered |
|---|---|---|
| `missing` | no CLI | the download page |
| `stopped` | the daemon does not answer or is not running | connect, then **Check again** |
| `needs-login` | signed out | Tailscale's sign-in page |
| `https-disabled` | MagicDNS or HTTPS certificates off for the tailnet | the admin DNS page |
| `off` | ready, nothing served on 443 | **Enable HTTPS via Tailscale** |
| `on` | 443 proxies to this core | **Pair a phone**, **Disable** |
| `conflict` | 443 serves something else | **Replace…** after a confirmation |
| `error` | the CLI refused (operator rights) or timed out | **Check again** |

Enabling runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, sets
the public URL to `https://<machine>.<tailnet>.ts.net` (the origin gate already
admits it) and mints a phone link through it. A tailnet that never allowed Serve
answers with a consent page, offered as **Allow Serve**. Disabling runs
`tailscale serve --https=443 off` and clears the public URL if it is still the
tailnet one. Another target already on 443 is never replaced without the
owner's confirmation. The CLI's own output never reaches a client, since a
failing command can echo an auth key: failures are reduced to a label. The
three methods, `tailscale.status`, `tailscale.enable` and `tailscale.disable`,
are owner only. A machine with no window has `boite-core tailscale [status|on
[--replace]|off]` ([server.md](server.md)).

Replace the example hostname with a domain pointing at the proxy. Caddy needs
access to the ports required for its certificate challenge and public HTTPS.
Keep the core bound to loopback when the proxy is local. A private VPN still
needs a certificate the phone trusts for PWA features.

Set the matching origin in General, Phone app, Public HTTPS address. A headless
core accepts `--public-url https://boite.example.com` or `BOITE_PUBLIC_URL`.
This saves `settings.publicUrl`, uses it in new pairing links, and permits that
exact browser origin at the WebSocket gate. An address copied from the browser
bar with its trailing `/` is stored as the bare origin; an address with a path
is refused, because pairing links cannot point into a proxy's subpath. Clearing
the setting returns links to the core's local address. No wildcard origin or
forwarded header is trusted.

On iPhone, open the pairing link in Safari, choose Share, then Add to Home Screen.
On Android, use Install Boite in Phone app or the browser's installation menu,
or install the nightly APK ([android.md](android.md)).
Open the installed icon and pair from inside Boite. On iPhone, installation
does not copy the browser's localStorage, where Boite keeps its session key.
The installed app therefore needs its own pairing even if Chrome or Safari
was already connected. Its welcome screen offers **Scan a QR code**, **Type a
pairing code** and **Paste a pairing link**. Create a fresh link on the computer
and scan it with that button, or type the code under it; using the iPhone
Camera app opens the browser instead, which the installed app's screen says.

A missing or revoked key opens that recovery screen, narrow or wide (an iPhone
on its side), instead of a stale page. A network outage offers
reconnection without discarding the saved key. The pairing form stays open
while a replacement key is being exchanged, and a rejected link can be replaced
without leaving the screen. After pairing, the saved session is reused on
subsequent opens. Installing a PWA and using Web Push require no Apple Developer
account.

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

Each build uses `boite-ui-v3-<build id>`, where the build ID hashes the asset
filenames. Vite stamps it into `dist/sw.js` before compression. Activation
removes older `boite-ui-` caches, including their hashed assets, and leaves
other applications' caches alone. Development uses unstamped `boite-ui-v3`.

| Request | Rule |
|---|---|
| a navigation | network first, the precached shell behind it |
| `/assets/` | cache first, stored on its first whole 200 |
| `/fonts/`, `/icons/` | cache first |
| `/rpc` | never cached |
| anything carrying an `upgrade: websocket` header | never cached |
| `/sw.js` | never cached |
| `/manifest.webmanifest` | never cached |

Live conversation state stays on the socket. The worker and manifest must be
revalidated so a new build can replace cached assets.

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
conversation, preserving an existing page and its drafts. With no page open,
the worker opens `/?thread=<id>`: the page's own core opens that thread as it
boots, in place of the new-thread draft, and does not wait for other
remembered machines to connect. The worker only opens
URLs on its own origin. Enable notifications from the machine's own page, not
while viewing it through another machine's UI.

An event makes one notification on a device. iOS shows every push and does not
let a tag replace a notification the page shows, so a page whose own core
pushes to it stays quiet: `pushCovers` in `lib/notify.ts` requires the page's
push switch, the granted permission and a live browser subscription. A device
without push, and a page's notices about another machine, keep the local
notification, through the service worker and the per-thread tag a push would use.

No device gets a push about news someone saw on screen. A page reports its
conversation `attentive` in `threads.focus` while it is visible, in front and
used in the last 45 seconds (`lib/attention.ts`): the phone app in the
foreground on that thread, or the desktop window in front with it open. The
desktop shell answers what a webview cannot (`user_presence`): whether its
window is the one in front, and on Windows how long the whole session has gone
without a key or a mouse move (`GetLastInputInfo`), so a window left in front
of an empty chair or a locked screen stops counting. A browser counts input on
the page. The page repeats its report every 10 seconds and the core believes it
for 25, so a phone that iOS suspends before it can say so (`pagehide`,
`freeze`) stops counting within that time.

The core holds back a push about an attended thread, finished turns, questions
and permission requests alike, rather than dropping it (`PushStore.notify`).
Each report carries `idleMs`, how long ago the page was last used while
attentive; use after the news arrived means it was seen, and the held push is
dropped. The page reports its first use after a quiet spell at once, at most
every 5 seconds. Otherwise the push goes when nobody watches the thread any
more: the page looks away, goes 45 seconds without use, disconnects, or lets
its lease run out. Someone who sends from the PC and walks away gets the reply
on the phone at most 45 seconds after their last input. A locked phone, an app
in the background, a window behind another one, a PC left alone or another
thread on screen never hold anything back. The filter lives in the core: iOS
may revoke the subscription of a service worker that receives a push and shows
nothing.
The title is the thread's title. A finished turn's body is the start of the
agent's last message, markdown removed, on one line and cut at a word near 140
characters; a question or a permission request shows its text, else the tool
and its command or path (`notification-text.ts` in the contracts, shared by
the core's push and the page's notice). When there is no such text, the core
sends a generic English body with a `label` (`done`, `failed`, `needsYou`,
`connected`). The language belongs to the page, so the page writes the words
for those labels in the language it speaks to the worker's `boite-notify`
cache, again on each language change; the worker shows them in place of the
English body, which stays the fallback until the page has run once.

Disabling removes the server subscription and unsubscribes the browser.
Revocation deletes the subscription with the pairing. Push services returning
404 or 410 retire the destination. Other delivery failures leave it subscribed
and write a generic diagnostic without the provider's credential-bearing body.

### The icon badge

The installed app's icon carries the count the window title shows: the threads
of every connected machine waiting on an answer or finished unread, archived
ones aside (`lib/badge.ts`, through `navigator.setAppBadge`). A push carries
the core's own count in `badge`, which the worker sets on the icon as it shows
the notification; zero clears it, and the test notification leaves it alone.
iOS (16.4 or later, installed app, notifications allowed) only runs the worker
for a notification it shows, so with the app closed the badge moves only when
one arrives.

### iOS push, checked

The path is: the installed app's Enable notifications asks the permission from
the tap, subscribes with the core's VAPID key, and stores the subscription with
`push.subscribe` against its pairing. A notification's payload is
`{title, body, threadId, tag, label, badge}` (`PushPayload` in the contracts); tapping it focuses an open window and
posts it the thread, or, if the page refuses focus or none is open, opens
`/?thread=<id>` on the worker's own origin.

### One app, several machines

An installed web app belongs to one origin, and a subscription is bound to the
VAPID key of the core that served it. So one installed app receives the
notifications of the machine it was installed from, not of the other machines
it shows through that machine's UI; the Phone app section says so once
subscribed. Today each machine whose notifications matter needs its own
installed app, from its own HTTPS address (each one has its own icon and
pairing). Doing it with one app would need the installing core to relay: the
other cores send their events to it over coordination, and it pushes them
with its own key.

## The desktop browser on a phone

Enable **Live browser on other devices** in Settings, Experiments on the
Windows desktop. That consent alone shares the browser tabs of the
conversation the desktop shows with paired devices; it does not give agents
control, which stays behind **Agent browser control**. The phone needs no
setting and has nothing to open: like the desktop panel, it shows a browser
when the conversation has one. When an agent opens a tab in the conversation
on the desktop (`browser open`), the desktop tells the core
(`browser.host` with `live`), the core tells the conversation's subscribers
(`browser.remoteChanged`) and the phone opens its panel on that tab. A phone
that opens the conversation later asks once (`browser.remoteStatus`). When the
last browser tab of the conversation closes on the desktop, the view leaves
the phone. A view the user closed stays closed for that tab; the panel's
**Browser** card brings it back while the tab exists, and is disabled
otherwise. The phone cannot ask the desktop to open a browser or a
conversation.

The view shows the desktop's active browser tab under an address bar with
back, forward and reload. Tap to click and drag to scroll, as on the phone
itself. Tap a page field and type in the input below the preview: Return sends
the text and then Enter, and Backspace in the empty input erases on the page.
Navigation keys and scroll buttons remain available without a hardware
keyboard. When the desktop shows another surface of its panel, or another
conversation, the view waits for it.

The phone requests JPEG frames while the view is shown and the app visible,
one at a time: the next as soon as the last has arrived, at most four a second
while the page moves, slower on a still page or a slow link, sized to the
phone's screen (at most twice its CSS width) and lighter when frames take long
to arrive. Each frame is decoded before it replaces the one shown. The desktop captures its tab as shown and
shrinks the image itself: asking Chromium for a smaller capture redraws the
live tab at that size and made it flash on the PC each time the phone's
keyboard shrank the preview. A lost desktop is retried with a growing pause up
to eight seconds. Pause, closing the view or hiding the app stops those
requests; returning to the app, regaining the network or reconnecting resumes
them at once. This is a periodically refreshed preview, not a video stream
with audio. The desktop must stay awake with Boite open; a minimized window may
stop producing frames.

**Display** offers phone, tablet and PC resolutions, custom dimensions from
240 to 3840 pixels, rotation and a fit-to-screen action. Resolution changes the
shared desktop tab too; **Use the PC panel size** removes the override.
Preview zoom stays on the viewing device. At 100, 150 or 200 percent, drag to
pan the enlarged image and use the arrow buttons to scroll the web page.
Changing resolution waits for a new frame before accepting more input.

The core permits the paired device's `browser.remoteStatus`,
`browser.remoteFrame` and `browser.remoteInput` only for a subscribed
conversation, and frames only from an owner desktop that has opted in. The
status says only whether a shared tab exists, never its address. Inputs
must refer to a recent frame issued to that connection. The desktop refuses a
tap or key after the page navigates or its viewport changes; the address bar
accepts only http and https addresses. Turning off desktop sharing invalidates
frames, including captures in flight. The phone cannot use `browser.command`,
execute JavaScript or register itself as the desktop host. It can interact
with the visible web page, including sites signed in on the desktop, so pair
only devices you intend to give that control. For that reason the experiment
stays off by default. The desktop that hosts the browser shows its real panel
and never a remote view of itself.

On iPhone, use the HTTPS web app in Safari or install it on the Home Screen.
Taps map through the letterboxed preview, its zoom and rotation, and the phone's
pixel ratio, in page coordinates. Unit tests cover that arithmetic, the polling,
the reconnection and the view appearing and leaving with the tab; layout
checks at iPhone width run in Chromium. They do not establish behavior on a
physical iPhone or Safari, including keyboard, backgrounding and network
handover.

Browser recordings are MP4 in the codec chosen on the desktop. H.264, the
default, plays everywhere. HEVC plays in iPhone Safari, and on a desktop only
with a decoder: WebView2 on Windows uses the HEVC Video Extensions and a GPU
that decodes it. AV1 plays in desktop Chromium, and on an iPhone only with
hardware decoding (iPhone 15 Pro and later). A video the device reports it
cannot play, such as AV1 on an older iPhone, shows a download button instead
of a black frame; a video that fails while loading also offers it. The
desktop's review dialog does the same.

## The limits

- What a phone gets with the core asleep is the app shell painting from disk, an
  empty chat, and "Connecting" in the sidebar footer until the socket comes
  back on its own. No offline history: the journal is on the core. Prompts
  written in a thread that was open before the connection went wait in the
  device's outbox (`docs/machines.md`), and go out once it is back, even after
  the PWA was closed in between; a new thread still needs the core.
- Pairing is a link somebody carries over, by hand or by the QR code beside it,
  and it has to be opened within ten minutes. There is no discovery on the
  network. One pairing is enough for the machines of a [group](groups.md): the
  phone is handed a key by each of the others.
- There is no iOS package. On Android, the nightly APK opens one core's page
  full screen ([android.md](android.md)); otherwise the phone runs the installed
  web app.
- Push is a notification channel, not background execution. The core must stay
  running to run agents and send notifications; delivery is not guaranteed.
- The core must be reachable. A different network, a VPN, or a firewall that
  blocks the port all end at the same screen.
