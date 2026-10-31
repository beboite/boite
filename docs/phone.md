# The phone

A phone is a device of a [group](groups.md): added once on any machine of the
group, it reaches all of them with one key of its own. It opens the UI served by
a machine or the [app's own address](#the-app-on-its-own-address) and connects
over authenticated WebSockets. Agents and the journal remain on the machine
hosting the core. The [Android client app](android.md) opens this same UI;
the separate [Android server](android-server.md) can host a core and agents on
the phone itself in Termux.

## Settings on a phone

The bottom bar opens Conversations, Activity and Settings, with a central
`+` for a new thread. The Bots and Contacts experiments add their own tabs.
The list's header opens the machine's connection settings and the project
picker, whose last row adds a project for owner connections. A conversation
hides the bottom bar; its header holds Back, which carries a mark while
another thread waits on the user, the title menu and a Browser button. The thread
list opens on its search field, with the display options at its right end:
the view, by project or recent, and the grouping switches. Choosing recent
or custom project ordering stays on the desktop. Project cards have a menu
for renaming them, their archived conversations and management. Renaming is
available to paired devices and changes only the display name. An existing custom order
also adds Move up and Move down. Actions follow the
connection's owner or paired-device permissions. The composer stays at the
bottom of the available viewport, above the keyboard when it is open. A touch
keyboard has no Shift+Enter, so where the primary pointer is coarse
(`pointer: coarse`, the question the app's other touch rules ask) plain Enter
writes a new line and the send button sends; Send now, when it appears under
the queue, steers the running turn or resumes a held queue. Plain Enter still
picks a slash or mention row. With a physical keyboard attached, Ctrl/Cmd+Enter
keeps its desktop behaviour ([keybindings](keybindings.md)). A browser does not report a physical
keyboard connected to such a device, so that keyboard's Enter writes a new
line too. A touchscreen laptop whose primary pointer is a mouse keeps Enter's
send.

Opening a conversation or draft, browsing projects and models, and dismissing
an overlay keep the touch keyboard closed. Automatic focus returns to the
composer frame or the dialog instead of a text field. This follows
`pointer: coarse`, including landscape phones and tablets. Tapping a field,
choosing Answer in writing, editing a message, or opening search explicitly
still starts typing. A terminal opens on its output and waits for a tap before
taking the keyboard. Desktop autofocus stays available.

At phone widths, Settings opens a list in two groups. This phone:
Notifications, Appearance, Privacy, the two analytics switches, and
Experiments, which follow the computer's desktop app until the phone flips one
of its own: Bots on the computer brings the phone's Bots tab with it
([experiments](experiments.md)).
Machine: the
machine itself with its connection, which opens Machines, then Usage, Voice,
Archived threads and Secrets. Owner connections also show Browser profiles
and Allowed windows. Each opens a screen of its own; the back button or browser
Back returns to the list. Theme and accent belong to the current device;
Appearance also holds the chat's files and previews switch, and leaves the
column width, the terminal, the workspace and the header's buttons to the
desktop. The notification screen names the connected machine that will send
its alerts, and offers to install the app while it is not installed.
Machines shows the group: its machines, which the phone switches to or
reconnects, and its devices, this phone marked as such. A phone that reaches no
machine shows **Scan the code** and **Paste the link** there, as on its first
screen ([adding a phone](#adding-a-phone)). Chrome uses `BarcodeDetector` when
available; the fallback loads jsQR on the first scan. Decoding stays on the
device. Other QR content leaves the scanner open. The camera requires HTTPS and
closing the view stops its tracks. A machine takes the hostname reported by its
core; its card can rename it.
Voice shows the connected core's dictation readiness. Engine installation and
API credentials stay in desktop Voice settings, including for owner sessions.
Usage has two tabs: Usage shows the connected core's tokens and API cost per
day, provider and model; Limits draws the core's subscription bars, read-only
([usage.md](usage.md)), under the switch that turns the owner's saved Douane or
CLIProxyAPI gateway on or off
([providers](providers.md#switching-the-gateway-from-limits)).

Owner sessions have an Automatic compaction row with common defaults and
independent settings for conversations, subagents and bots.

Provider accounts, keyboard shortcuts, plugins, resource limits, the brain,
the task manager, worktrees, diagnostics, the tour and
server configuration have no row in the phone's settings list. A link or a
card can still open a supported detail page, subject to its permissions;
`MobileSettings.svelte` defines those pages. Project management is available
from each project card's menu. This smaller phone menu also applies to owner
sessions; it does not change RPC permissions. A paired device's Machines
page lists devices but leaves adding and removing them to the owner.

Device sessions receive only events corresponding to the state they may read.
Account login output, process traces, plugin state and core diagnostics
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

Settings, Advanced, Phone app, Reachable on the local network saves
`listenOnLan`. The core
reads it at startup; enabling it binds `0.0.0.0`. Explicit `--host` or `--lan`
flags take precedence. A running core never rebinds, so changing the switch
requires a restart. The startup log names the address and its source.

Closing the desktop app's window leaves its core running, so in the desktop app
the switch restarts the core itself through `core.restart`, owner only: the
restart an update makes, where each running turn ends its tool call and the next
core resumes it ([restart handoff](restart-handoff.md)), and the shell starts
that core again. A link to add a device that names a loopback address gets no QR
code: on a phone it would name the phone. The Add a device panel says
so instead and offers Make it reachable on the local network, which saves the
setting, asks for the firewall rule on Windows, restarts and shows the new link. A core the
desktop app did not start keeps a sentence asking for a restart of Boite there
(`LanReach.svelte`; `?fake=1&lan=off` mints loopback links).

Without `--port`, the core reuses the port in `core.json`. A first run, or one
whose port another program took, tries 7337 to 7346 (7347 to 7356 for
`--channel dev`, `PREFERRED_PORTS` in `server.ts`), then any free port, and logs
the move; a phone then needs a new link. The fixed ports sit below 49152:
Windows lends 49152 to 65535 to outgoing connections and Hyper-V reserves blocks
of it at boot, so a random port from there could be gone at the next start. An
explicit `--port` fails when occupied. A listener on all interfaces puts the machine's
LAN address in the links that add a device, rather than loopback.

### Windows Defender Firewall

On Windows the core is Bun's own signed runtime renamed `boite-core.exe`
([releasing](releasing.md)), so the first listener outside loopback makes
Windows ask whether to let "Bun", published by "Oven", through. Windows creates
inbound block rules for it before anyone answers, and they stay if the prompt is
dismissed. An answer covers only the category of the network the machine was on,
public or private, so the same network classified the other way later blocks the
core again. In every case a phone gets a page that never loads.

`firewall.status` reads the enabled inbound rules naming the core's executable
and the category of each connected network, Tailscale's adapter aside since
Tailscale opens it itself. A block wins over an allow, and a profile with the
firewall off counts as allowed. `firewall.allow` runs one script as administrator
through Windows' own prompt: it deletes every inbound rule naming the executable,
then adds one named Boite that allows its TCP connections on every profile. A
refused prompt answers `detail: 'cancelled'` and changes nothing. Both methods
are owner only; elsewhere than Windows the status is `unsupported`.

Turning on Reachable on the local network calls `firewall.allow` at once, while
the owner is at the switch, so once the rule is in place Windows' own prompt
never comes up; a refused or failed allow leaves it to come up at the next
start. While the core
listens on the network and Windows does not let it through, the Phone app card
and the Add a device panel say so, with Allow in Windows Firewall.
`?fake=1&firewall=blocked` and `?fake=1&firewall=unset` show those states;
`?fake=1&firewall=refused` shows `blocked` with an administrator prompt nobody
accepts.

Two things guard the socket whatever it is bound to. The `Origin` header must be
absent, one of the shell origins, the core's own origin, or an origin a machine
of its group gives or is served at ([groups](groups.md#devices)), and the first
frame must be `hello` carrying a credential within five seconds, or the socket
closes with `4001`. A phone reaching the core over the LAN passes the first check
with the core's own origin, and the second with its device signature.

## Adding a phone

On any machine of the group, Settings, Machines, **Add a device** draws a QR
code of this link:

```
https://boite.example.com/?grant=<32 random bytes, hex>
```

The phone's app opens on a screen with two buttons and nothing else: **Scan the
code** reads the QR code through the camera, and **Paste the link** takes the
same link, copied on the machine and sent to the phone, for a camera that cannot
read it. Either way the app makes its device key if it has none and is admitted
to the group with it ([groups](groups.md#devices)): it then lists every machine
of the group and opens on the one the link names. The link names the machine
that drew it, so it works from the app's own address as from a page a machine
serves. The installed iPhone app needs its own scanner because the Camera app
hands a link to Safari, whose storage the home-screen app does not share.

The owner must ask for a link, and startup logs contain neither grant nor key.
The grant inside the link is not the core token: it is 32 random bytes the core
remembers for ten minutes. The device's `hello` carries the grant with the
device's public key and its signature over that grant; the core spends the
grant, writes the device in the group, and forgets the grant on the spot. A link
used twice, or after its time, is refused by name; the same device asking again
after a lost answer gets the same answer. The core token itself stays in
`<dataDir>/core.json`, where the shell reads it, and travels nowhere.

Close hides the QR code; the link stays valid until it is used or expires. The
devices of the group are listed in the same card as its machines, each with the
machine it was added on; **Remove from the group** takes one out on every
machine. A computer copies the same link and pastes it under **Join**: its own
core joins the group ([groups](groups.md#using-it)).

### The app on its own address

The phone app can also be a page no machine serves: `APP_ORIGIN` in the
contracts, `https://boite.mtsu.dev`. Every core accepts sockets from it, as
it does the desktop shell's, so nothing is set on any machine for it. A fork
that serves its own names it in `BOITE_APP_ORIGIN` on its cores, an `https`
origin or the core does not start, and in `VITE_BOITE_APP_ORIGIN` when it builds
its UI, which otherwise takes its own page for a machine's. There the app opens on its way
in alone. A scanned or pasted link names the machine that drew it. The page is
HTTPS, so the machine's address has to be too: a browser blocks a plain `http://`
socket from it, the device's own loopback excepted, and the app turns such a
link down with a message instead of failing on the socket. The first machine
added becomes the one the app shows and opens on next time; the group brings the
others.

#### Chrome's local network permission

That address is public and the machines are not: a LAN address, a tailnet
address or a name only the home DNS resolves are all private. Chrome 142 and
later block a public page's requests to a private address until the user allows
it, WebSockets included since Chrome 147. The socket fails at once with
`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` in the console and a bare
socket error in the page, and the machine never sees it, so its log has no line
for that phone. A page a machine serves is on the private side already and is
not concerned. Every Chromium on Android does the same, including the browser
the installed app runs in when it is not Chrome (Titanium and Vanadium enforce it
on WebSockets too).

Android adds a second lock: the browser app itself needs Android's local network
permission, shown as Nearby devices in its app settings, before any of its pages
reaches the local network. Android 17 makes it a runtime permission
(`ACCESS_LOCAL_NETWORK`); a Titanium install on Android 16 needed it too
(2026-10-15), with Local network already allowed. No page can read it.

The permission is `local-network` since Chrome 145, "Local network" in site
settings; Chrome 142 to 144 named it `local-network-access`. Chrome asks the
first time a socket goes out. On the app's page, `lib/local-network.svelte.ts`
reads its state with `navigator.permissions.query` and follows its changes:

- `prompt`: the first screen and the waiting screen say what to answer before
  Chrome asks.
- `denied`: the waiting screen becomes **Allow the local network** and gives the
  way back: in the browser that runs the app, Settings, Site settings, Local
  network, then the app's own host; on Android, Nearby devices for that browser
  too. The app icon's Site settings shortcut is no way there: it opens
  the browser's list of linked sites and their storage, without permissions. The
  bare "socket error" is not shown over it.
- `granted`: every machine is tried at once, through the same `resume()` as the
  `online` event, rather than at its next retry.

Under the buttons, **Troubleshoot** (`ConnectTroubleshoot.svelte`) unfolds the
checks one by one: Local network with its live state, on the app's page only;
Nearby devices, on Android only; and the machine's own address to open in a
tab, where a page that does not load means the phone cannot reach it at all
(Tailscale, VPN, Wi-Fi), whatever the permissions say.

A browser that knows neither name (Safari, Firefox, an older Chrome) blocks
nothing and the app says nothing. `tests/e2e/app-origin.test.ts` passes
`--ip-address-space-overrides` so that Chromium sees the app public and the
cores private, the way a phone does; without it every address there is loopback
and nothing is checked.

That address serves files and nothing else: `.github/workflows/app.yml`
publishes the UI build there with GitHub Pages on every change of the UI, the
contracts or the build's dependencies on `main`, `/.well-known/assetlinks.json` included. A phone downloads
the page once and its service worker keeps it; conversations, prompts and
sockets go from the phone to the machines, never to that address. Whoever
controls the address controls the code the phone runs, as whoever signs the APK
does.

Notifications are enabled on the machine the app shows, which becomes the
device's push home. Every push to a device of the group names the machine its
thread is on, so a tap opens the thread there whatever page the app runs.
A machine reached only over plain HTTP is reached through a member that has
HTTPS ([relay](groups.md#relay)), as from any HTTPS page.

### Older links

`pairing.grant` still mints a link of the older kind, and `boite-core pair
--owner` one for another computer with full control ([server.md](server.md)).
Exchanged without a device key, such a grant becomes a session key for that core
alone. A phone that holds one sends its device key the next time it connects,
and signs from then on. Session keys are stored hashed in the journal.
`sessions.list` shows every session with the client it said it was, its role and
when it was last seen; `sessions.revoke` closes its sockets and deletes the row,
and for a device of the group removes the device on every machine.

## What a paired device may call

`packages/contracts/src/access.ts` defines the paired-device method/event
allowlists; the real router and in-memory client enforce them before handlers.
They cover conversation lists, prompts, agent cards and permitted read-only
settings. Methods absent from the list remain owner-only, including newly
added methods. A refusal names the method, such as
`projects.add is for the owner only`.

A paired device reads and moves the project's todos for the board
([board.md](board.md)): `todos.list`, `todos.add`, `todos.update` and
`todos.remove`, with `todos.updated` for every project. It confirms and removes
cards as the owner does; an agent only claims one.

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
never stores a grant: what it keeps is its device key, or the session key that
came back for a link of the older kind.

A link never replaces the stored core before its target has answered a hello.
When `core=` names a core that is neither this page's origin, nor one this
device already holds a key for, nor a machine of its group (as its members last
listed them), the page first asks whether to connect to that host. Anyone can
send a link that points at a core they run, and that core would see every prompt
typed afterwards. Cancel opens the stored core as before. A `core=` link to a
core the device already knows, or to a machine of its group, asks nothing. A
link scanned or pasted in the app asks nothing either: the owner just showed it.

## The app on the phone

The browser uses mobile navigation at 720 px and below. A bar along the bottom edge
(`MobileTabs.svelte`) holds the places: Conversations, Activity, a filled +
that starts a thread, Bots and Contacts when they are on, and Settings.
Activity's tab counts the conversations waiting for you; Bots counts the bots
at work on every machine, as the desktop's switch does, in the waiting colour
once one needs you. Conversations lists
threads across connected machines; Activity puts waiting requests first,
followed by running and queued turns. Each list's header shows the machine,
which opens its connection settings, over the screen's name, and the project
the + starts in, whose sheet also adds a project for owners. A conversation, a bot's
page and an open keyboard hide the bar; the conversation's header shows its
title over its project, and its machine once there are two.

Each row in the list leads with who runs the thread, the bot's picture or the
provider's logo. A finger that slides a row left uncovers Pin and Archive
(`lib/swipe-row.ts`); a vertical drag stays the list's scroll and one row is
open at a time. A phone has no right-click, so the actions a desktop finds
there open from a tap: the conversation's title in its header lists Browser,
files and tools (the right panel), pin, rename, find in this thread, Subagents
when the thread has some, archive and delete, and the `...` button of a row in
the list offers the same actions a thread keeps on a phone, with Mark done in
the list. A new title by the agent, moving to a project, the path,
coordination and the terminal stay on the desktop. A draft's header shows its
"New thread" label.

Under a conversation, the copy, edit and retry buttons show under the last
prompt and the last answer; any other message shows its row when tapped, until
a second tap on it or one elsewhere (`lib/message-reveal.svelte.ts`). A phone
offers no fork. The turn's footer line, time, duration and tokens, stays. The
composer's model chip names the model alone, without its account, and drops
whole words when the row is short.

Model, effort and action menus open as bottom sheets. The browser's Back, the
Android Back gesture and a mouse's back button close the top sheet, dialog,
context popup or right panel first, then return from a conversation to the
list it was opened from. Each of those owns one history entry
(`lib/mobile-history.ts`); closing it by a button removes that entry, so Back
never lands on something already closed. The conversation the app opens on has
no list behind it, and Back from there leaves the app as before.

Screens move as a phone's own do (`lib/screen-slide.svelte.ts`). A
conversation slides in from the right edge over the list it opens from, which
shifts a quarter of the width left under it, and slides back out on the way
back; a Settings page does the same over the Settings home. The right panel
comes in from the right edge and leaves by it, and a bottom sheet rises from
the bottom edge and goes back down. Only transforms move, over `--dur-3` with
`--ease-slide`, and the conversation keeps its full height on the way, so
nothing inside it reflows. Between the bottom bar's places, from one Settings
page to another and wider than 720 px nothing slides; under reduced motion
nothing moves. Safari's swipe from the edge, and Chrome's where it draws one,
already slides a picture of the screen underneath before the Back lands: what
that Back closes, a conversation, a page, the panel or a sheet, then leaves at
once instead of sliding a second time. The browser says so on the
`popstate` event (`hasUAVisualTransition`, Safari 18 and Chrome 118); on an
older one, a Back within a second of a finger lifted from the screen's edge
counts as the browser's. The app's own Back, from its buttons, always slides.

Every button on the chat, the list, the panel and Appearance registers a tap
19 px from its centre on either axis, and `--touch-target` is 44 px. Some controls
keep a small look and get a larger hit box, such as the machine's name in the
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
the chat header, the full-screen right panel, and the Bots and Settings pages
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
page instead: this browser cannot start Boite, and the versions it needs. A
browser that has `Array.prototype.at`, `Object.hasOwn`, `structuredClone` and
`oklch()`, which Safari 15.4 and Chrome 111 are the first to have together,
failed before the entry ran instead, most often on a chunk lost on the way
(offline, a dropped connection), sometimes on a startup module that threw: the
page says the app could not load, offers Try again, and loads again by itself
once the browser is back online.

## Pictures and videos

Screenshots and photos shrink before they leave the phone: 2000 px on the long
edge, JPEG or PNG, HEIC converted to JPEG by Safari. A turn takes fifty
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

On a tailnet the phone is already on, Settings, Advanced, Phone app has
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

Set the matching origin in Advanced, Phone app, Use another HTTPS
address. A headless
core accepts `--public-url https://boite.example.com` or `BOITE_PUBLIC_URL`.
This saves `settings.publicUrl`, uses it in new links to add a device, and
permits that exact browser origin at the WebSocket gate; the other machines of
the group accept it too. An address copied from the browser bar with its
trailing `/` is stored as the bare origin; an address with a path is refused,
because those links cannot point into a proxy's subpath. Clearing
the setting returns links to the core's local address. No wildcard origin or
forwarded header is trusted.

On iPhone, open a machine's HTTPS address in Safari, choose Share, then Add to
Home Screen. On Android, use Install Boite in Phone app or the browser's
installation menu ([android.md](android.md)). Open the installed icon and add it
from inside Boite. On iPhone, installation does not copy the browser's
localStorage, where Boite keeps its device key, so the installed app is added on
its own even if Safari was. Its first screen offers **Scan the code** and **Paste
the link**, nothing else. Show a fresh QR code on any machine of the group and
scan it with that button, or copy its link there and paste it; the iPhone Camera
app opens the browser instead, which the installed app's screen says.

A missing or revoked key opens that recovery screen, narrow or wide (an iPhone
on its side), instead of a stale page. A network outage offers
reconnection without discarding the saved key. The scan and paste buttons stay
while a replacement key is being exchanged, and a rejected link can be replaced
without leaving the screen. After pairing, the saved device key is reused on
subsequent opens. Installing a PWA and using Web Push require no Apple Developer
account.

`packages/ui/public/sw.js` caches the files for later opens. It is plain
JavaScript that Vite copies to `dist/sw.js` with one change, the build id in
its cache name, and `lib/sw.ts` registers
it after the first paint, never before: the registration must not delay what the
user sees. It registers only where it helps: an http(s) origin, the core's own
or the app's ([its own address](#the-app-on-its-own-address)). The Tauri shell loads the identical build from `tauri://`, where the
files are already on disk, and `?fake=1` runs on the in-memory client with no
core behind it; both are skipped. A registration that fails is one
`console.warn`, and the app runs on.

## What is cached, and what never is

Each build uses `boite-ui-v6-<build id>`, where the build ID hashes the asset
filenames. Vite stamps it into `dist/sw.js` before compression. Activation
removes older `boite-ui-` caches, including their hashed assets, and leaves
other applications' caches alone. Development uses unstamped `boite-ui-v6`.

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
`/sw.js` and `/manifest.webmanifest` are `no-cache`, and every static answer
outside `/assets/` carries an `ETag` and a `Last-Modified`, so their revalidation is a 304.
`/fonts/` and `/icons/` keep their names across builds and are
`public, max-age=86400, stale-while-revalidate=604800`, which also spares a
phone on plain http, where no worker registers, the fonts on every load. `/sw.js` also carries
`Service-Worker-Allowed: /`, which is what lets a worker served from that path
take the whole origin as its scope. A header test in
`packages/core/test/server.test.ts` reads them out of the served build, and an
end to end test stops the core, reloads the page and watches the shell paint
anyway.

Installation reads the entry HTML and precaches the hashed assets it names in
a `src` or `href`, the default fonts, icon and manifest, and one catalogue from
the locale map of an inline script: the language the page last spoke, which it
writes beside the notification words, else the device's first language the
build has, else English. The app mounts only with a catalogue, so an offline
open needs it as much as the entry; the other languages stay on the wire until
someone picks one. It also stores the phone navigation's chunk and the files
it imports, which the build lists in a `boite-offline` meta tag
(`offlineParts` in `packages/ui/vite.config.ts`): the header and the recovery
screen live there, and the browser fetches nothing for that tag, so the
desktop shell never loads them (`tests/e2e/offline-phone.test.ts`). Every
successful navigation refreshes the offline
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
through the shared core event bus, and so does a bot's private post to the
owner in a team chat ([teams](teams.md)), as a Finished notification whose
body is `<bot>: <text>`. Stopped turns do not, and neither do the
turns under a thread that are not news of their own: a delegated agent's turns
(its parent's next turn reports the result), a parent's turn that ends while
its agents still work, a bot's quiet wake (a routine or event turn
whose final text block opens with `[quiet]` or ends on a `[quiet]` line,
[bots](bots.md#quiet-turns)) and a context compaction. Permission
requests and questions notify whichever thread asks. A desktop toast follows
the same rule, from `notifiesOnFinish` in the contracts. A click opens the
conversation, preserving an existing page and its drafts. With no page open,
the worker opens `/?thread=<id>`: the page's own core opens that thread as it
boots, in place of the new-thread draft, and does not wait for other
remembered machines to connect. The worker only opens
URLs on its own origin. Enable notifications from the machine's own page, not
while viewing it through another machine's UI. A push another machine of the
group sent through this one carries that machine's id: the worker opens
`/?thread=<id>&member=<core id>`, and the page opens the thread on that machine
once the group has connected it.

An event makes one notification on a device. iOS shows every push and does not
let a tag replace a notification the page shows, so a page stays quiet when a
push brings the same notice: its own core pushes to it, or the notice is about
a member of the group, which forwards it to the device's push home.
`pushCovers` in `lib/notify.ts` requires the page's push switch, the granted
permission and a live browser subscription. Otherwise the page shows the
notice through the service worker whenever one is registered, since Android
Chrome refuses `new Notification` on a page and the phone app's page serves no
machine. It uses the tag and data a push about that thread would: `thread-<id>`
for this page's own core, `thread-<core>-<id>` with `{threadId, core}` for a
machine of the group (`GroupLinks.coreOf`, handed to `lib/notify.ts` by the
workspace), so a later push replaces it and a tap opens the thread there. A
machine with no group id gets a `key` in the data, which the open window reads
through `openNotification`, and which the worker puts in the address it opens
(`?thread=<id>&key=<key>`) when no window is open or one refuses focus. Only a page without a worker builds the
notification itself.

Routine turn notifications wait while someone watches their conversation.
Questions and permission requests notify immediately, including asynchronous
questions, even when their conversation is open and focused. The desktop
notification switch still disables local toasts. A page reports its
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

The core holds back finished-turn pushes about an attended thread rather than
dropping them (`PushStore.notify`). Requests for input bypass this hold. A core
with no push subscription and no other group member prepares nothing: no reply
excerpt, no badge count, no forwarding. The check runs when the news happens, so
a phone that subscribes mid-turn gets the next one.
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

### Choosing which notifications

Each device chooses the kinds it gets, all on by default: Approvals
(permission requests, plan approvals, settings and agent settings cards asking
to apply a change), Questions (an agent's questions, `boite ask`, a delegated
agent's), Finished, Errors and Limits (the alerts set on an account in
Settings, Limits, [usage](usage.md#alerts)). The rows sit under the notifications switch, in
General on the desktop and in Notifications on the phone, and dim while
the switch is off. The choice lives in the page's `localStorage`: the kinds
turned off under `boite.notifications.muted`, so a kind added later starts on.
Local toasts read it (`shouldNotify` in `lib/notify.ts`). For Web Push the core
sends, so a subscribed device hands it over: `push.subscribe` takes `kinds`,
`push.kinds` changes them without subscribing again, `push.status` returns
them, and the switch off sends an empty list. The page records which machine
holds the subscription (`boite.web-push.home`, its address in this page), so a
change made while another machine is shown still goes there; the kinds are one
state for every machine of the window. A subscription stored without
kinds gets every kind. Every push carries its `kind` beside the `label`; a push
forwarded through the group carries it too, and the device's home machine
filters it by that subscription's kinds. The test notification has no kind and
always goes.

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
`{title, body, threadId, tag, label, kind, badge}` (`PushPayload` in the contracts),
plus `core` when another machine of the group sent it through this core;
tapping it focuses an open window and posts it the thread, or, if the page
refuses focus or none is open, opens `/?thread=<id>` on the worker's own
origin, with `&member=<core id>` for such a push.

### One app, several machines

An installed web app belongs to one origin, and a subscription is bound to the
VAPID key of the core that served it. So one installed app receives the
notifications of the machine it was installed from. The other machines of its
[group](groups.md#notifications-through-the-group) send theirs through that
machine, which pushes them with its own key; the Phone app section says so once
subscribed. A machine the
page reaches through its own core says, in place of the switch, that its
notifications come with the ones enabled there.

## The agent's browser on a phone

The phone shows the agent's browser the way every client does
([the agent's browser](browser.md#watching-it)): the browser runs on the
machine of the conversation, the panel opens covered when the agent opens a
tab, and **Show** starts the live view. The phone needs no setting and no
desktop has to be open.

The view shows the chosen tab under an address bar with back, forward and
reload. Tap to click and drag to scroll, as on the phone itself. Tap a page
field and type in the input below the preview: Return sends the text and then
Enter, and Backspace in the empty input erases on the page. Navigation keys
and scroll buttons remain available without a hardware keyboard. A double tap
selects a word and **Copy** puts the page's selection on the phone's
clipboard. A tap on a page's drop-down list opens its options over the preview
([the agent's browser](browser.md#watching-it)). A computer has none of these controls: it types, scrolls, selects,
copies and pastes on the page itself ([the agent's browser](browser.md#watching-it)).

The phone requests JPEG frames while the view is shown and the app visible,
one at a time: the next as soon as the last has arrived, at most four a second
while the page moves, slower on a still page or a slow link, sized to the
phone's screen (at most twice its CSS width) and lighter when frames take long
to arrive. Each frame is decoded before it replaces the one shown. The browser
shrinks the frame itself. Each request names the frame shown; on a still page
the core holds it for a second and answers `unchanged`, so the phone downloads
nothing until the page draws, and the time the core held a request is not
counted as a slow link. A failed frame is retried with a growing pause up to eight seconds. Pause, Hide,
closing the view or hiding the app stops those requests; returning to the
app, regaining the network or reconnecting resumes them at once. This is a
periodically refreshed preview, not a video stream with audio.

The toolbar's **Display** button offers phone, tablet and PC resolutions, custom dimensions from
240 to 3840 pixels, rotation and a fit-to-screen action. Resolution changes
the agent's tab too, as `boite browser resize` does; the reset returns it to
the browser's window size. Preview zoom stays on the viewing device. At 100,
150 or 200 percent, drag to pan the enlarged image and use the arrow buttons
to scroll the web page. Changing resolution waits for a new frame before
accepting more input.

The core permits the paired device's `browser.remoteStatus`,
`browser.remoteFrame` and `browser.remoteInput` only for a subscribed
conversation. Inputs must refer to a recent frame issued to that connection;
a tap or key after the page navigates or its viewport changes is refused, and
the address bar accepts only http and https addresses. The phone cannot use
`browser.command` or execute JavaScript. It can interact with the visible web
page, including sites signed in on that machine's profiles, so pair only
devices you intend to give that control.
## The limits

- What a phone gets with the core asleep is the app shell painting from disk, an
  empty chat, and "Connecting" in the sidebar footer until the socket comes
  back on its own. A phone that holds keys for other machines, those of a
  [group](groups.md), opens on one of them instead
  ([machines](machines.md#connecting-a-machine)). No offline history: the
  journal is on the core. Prompts
  written in a thread that was open before the connection went wait in the
  device's outbox (`docs/machines.md`), and go out once it is back, even after
  the PWA was closed in between. Input that never reached the core requires a
  client to reconnect first. Once synchronized, the core runs pending prompts
  and draft starts with every app closed. Drafts, unsent replies and their
  attachments are shared by the owner's paired devices; incognito input stays
  in client memory.
- A phone is added with a QR code or a link somebody shows it, within ten
  minutes. There is no discovery on the network. Adding it
  once is enough for every machine of its [group](groups.md).
- The installed web app belongs to the origin it was installed from: it reaches
  the group of the machine serving it, and no other group.
- There is no iOS package. The Android package opens the app's own address
  ([android.md](android.md)), as the installed web app does from there.
- Push is a notification channel, not background execution. The core must stay
  running to run agents and send notifications; delivery is not guaranteed.
- The core must be reachable. A different network, a VPN, or a firewall that
  blocks the port all end at the same screen.
