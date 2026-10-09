# The agent's browser

An agent that needs a web page opens it in a headless browser on the machine
that runs its conversation. The core of that machine starts the browser and
drives it over the DevTools protocol; the agent reaches it with
`boite browser` ([CLI](cli.md#test-a-page-in-the-agent-browser)). Every client
of the conversation watches the same tabs and can act in them: the desktop on
that machine, the desktop of another machine connected to it, a plain browser,
a phone. Nothing depends on which client is open, and no setting turns it on.

`packages/core/src/browser.ts` owns the tabs, `browser/chromium.ts` finds and
starts the browser, `browser/cdp.ts` is the protocol connection,
`browser/recorder.ts` records and `browser/scripts.ts` holds what is evaluated
in a page for viewers. `browser/automation.ts` runs agent-browser's commands
with `browser/page-kit.ts`, the script that reads a page into a snapshot with
refs and finds `@eN`, CSS and `text=` targets.

## Which browser

The core looks for a Chromium-based browser where each installs:

| OS      | Looked at                                                                                     |
| ------- | --------------------------------------------------------------------------------------------- |
| Windows | Chrome, Edge, Chromium and Brave under `Program Files`, `Program Files (x86)` and `LOCALAPPDATA` |
| macOS   | Chrome, Chromium, Edge and Brave in `/Applications`                                           |
| any     | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser` on `PATH` |

`BOITE_BROWSER` names the executable instead, and is then the only place
looked at. Edge ships with Windows 10 and 11, so a Windows machine always has
one. A machine without any says so: `browser.remoteStatus` answers
`available: false` with the reason, the panel shows it, and `browser open`
fails with the same sentence. Nothing is installed or downloaded.

The browser runs with `--headless=new`, muted, without a first-run page, sync
or background downloads, in a 1280 × 800 window whose page measured
1280 × 720 on Chrome 153. WebGL uses the GPU:
`--enable-gpu` with software rendering off, and ANGLE over EGL on Linux, which
a process with no display reaches. A page that needs WebGL on a machine
without a usable GPU gets none rather than SwiftShader on every core. On the
M2 container on 2026-10-05, WebGL reported `ANGLE (AMD, AMD Radeon Graphics
(radeonsi renoir ACO), OpenGL ES 3.2)`.

## Processes and profiles

Each [browser profile](panel.md#browser-profiles) of the machine's settings is
one browser process with its own folder, `<data dir>/browser/<profile id>`,
which keeps its cookies and logins across restarts. A private tab gets a
process of its own in a throwaway folder, removed when its last tab closes.
A process starts with the first tab that needs it, and has 60 seconds to
answer: a profile's first start creates it, which took over 20 seconds on a
Windows CI runner. It is started through `procs.spawn` as a
tool process of `system:browser`, so [the trace](trace.md) shows it. It closes
60 seconds after its last tab, and with the core. Deleting a profile in
Settings closes its tabs and removes its folder; a folder whose browser had
already closed goes at the next settings change or the first use of the agent
browser after a restart. A folder that cannot be removed is logged.

Logins live on the machine that runs the agent, not on the device that shows
it. The core keeps each profile's cookies itself, in `boite-cookies.json` in
the profile folder, readable by its own account only: saved a second after a
page changes, every 30 seconds while a tab is open, when a tab closes and
before the browser process ends, handed back when it starts. The browser's
own cookie file was not enough: on the Windows and macOS CI runners of
2026-10-05 a cookie set in a tab was gone after the process closed, and a
cookie with no expiry date is never written by a browser at all. A private
tab's cookies are never saved. A core killed outright keeps what was saved
last, so a sign-in whose tab is still open is at most 30 seconds from the
disk.

### Copying a desktop profile's sign-ins

The desktop's own browser keeps its profiles in WebView2, on the PC. The
agent browser cannot read them, so Settings > General > Browser profiles has
**Copy sign-ins to agents** on each profile, in the Windows desktop app. It
lists the connected machines the user owns; picking one reads that profile's
cookies on the PC (`browser_cookies`, through a blank view of the profile
made for the read and destroyed after) and sends them to that machine's core
(`browser.importCookies`, owner only). The core adds the profile to its own
list under the same id and name when it has none, and hands the cookies to its
browser. `boite browser open <url> --profile <name>` then opens signed in.

It is a copy at that moment, not a link: a later sign-in on the PC is copied
again by hand, and a session the site ties to the PC's address or device may
still ask again. A partitioned cookie (one tied to the site that embeds it)
is left out, since the copy cannot carry that scope. The cookies cross the connection to that machine, so the
action is the owner's alone and never automatic. Signing in directly works
too: show the agent's browser and sign in there.

A conversation has at most 8 tabs and a machine 24. A page that opens a
window, a sign-in popup for instance, adds a tab to the same conversation; past
the limit the window is closed. Nobody can answer a dialog in a headless page.
One raised while an agent command runs follows `dialog accept|dismiss`
(accept until told otherwise) and is listed in that command's output; any
other alert is accepted and a confirm or prompt declined, so a person acting in
the panel never confirms by accident. All are noted in the diagnostics. Downloads are refused. Archiving or removing the
conversation closes its tabs.

An open tab does not hold back an update of the core: the browser's processes
are not counted as work under way. The update closes them, the cookies are
saved first, and the tabs themselves are not reopened.

The agent's commands of one conversation run one after the other, in order.
`open` and `navigate` wait up to 10 seconds for the next page's DOM, never for
the load event, which an image or a script that never finishes can hold back;
a page still loading by then is returned with `loading: true` rather than an
error. A click, a key or a fill that starts a navigation waits the same way and
reports where the page went. Clicks, keys and text are native input; an element
something covers is clicked through the DOM, and the agent hears what covered
it.

## Recording

`recording-start` records the tab as a silent MP4 without any encoder on the
machine. The tab streams its frames (`Page.startScreencast`, at most
1920 × 1080), and a blank page of the same browser, in a throwaway context of
its own, draws them on a canvas that a `MediaRecorder` encodes. A still page
sends no frame, so the last one is drawn again each second and the video keeps
its length. H.264 is the default. Chrome 153 on Linux encodes H.264 and AV1 into MP4, not
HEVC; a codec the browser cannot encode is refused with the ones it can. The same 100 MB limit and turn rule
as before apply: a recording still running when the agent's turn ends is
stopped and thrown away.

## Watching it

The panel's **Agent browser** surface looks like a browser: a strip of the
conversation's tabs, then a toolbar with back, forward, reload, the address
and two buttons, page size and pause, then the page. On the desktop of the
machine that runs the browser (the core the app started), the page shows at
once: nothing leaves the machine. Any other client first gets a card that
names the machine, "This agent controls a browser on m2", with the page's
title, and a **Show** button; nothing is captured or sent before that. Show
starts the live view; the eye in the tab strip covers it again. When the agent
opens a tab in the conversation on screen, the panel opens on that surface,
covered on a remote client. The launcher's **W** opens it by hand. The cover
holds for the conversation while the app stays open; a reload covers it again.

The owner opens and closes tabs as in any browser. **+** adds a new tab page
with an address field, and Enter opens the page in the conversation's browser
(`browser.command` `open`, the machine's default profile), live at once since
he asked for it. A tab's **×** closes it (`close`), the agent's tabs included.
With no tab open the owner lands on that new tab page, which is where he signs
in to a site the agent then uses. A paired phone watches and drives the pages
but neither opens nor closes a tab: `browser.command` is not one of its methods.

The live view asks for one JPEG at a time (`browser.remoteFrame`), the next as
soon as the last has arrived, sized to what the view shows and lighter on a
slow link; [phone](phone.md#the-agents-browser-on-a-phone) has the schedule.
Every viewer that asks within 150 ms gets the same capture, so a desktop and a
phone watching one tab cost one. Input names the frame it was aimed at; a tap
on a frame of another page or another viewport size is refused, and the
address bar accepts only http and https.

A computer drives the page itself, with nothing under it; the page's tooltip
says how, and a copy or a refused key shows a short note over the page. A click on the page gives it the keyboard until a click or a focus lands
elsewhere: characters, Enter, Tab, Escape, the arrows, Home, End, Page Up and
Down, Delete and Backspace leave as native key events (`press`), and the keys
typed while a request is in flight leave together in the next one, in order.
The wheel scrolls under the pointer. A drag with the mouse is a drag in the
page, so it selects text; a second click selects the word, a third the
paragraph, and Shift with a click extends the selection. Control or Command
with A selects all, with Z or Y undoes and redoes.

The clipboard is the viewer's own. Paste inserts this computer's text in the
focused field of the page. Copy and cut ask the core for the page's selection
(`browser.remoteSelection`) and write it to this computer's clipboard; cut then
erases it in the page. The selection is read in the focused field, else in the
document, through open shadow roots and same-origin frames, at most 100,000
characters. A password field answers nothing, and a selection inside a
cross-origin frame is not read. The other Control and Command chords and the
function keys stay with the app.

A touch screen (`pointer: coarse`) keeps the scroll buttons, the keys and the
text field under the page, with a **Copy** button for the selection: a double
tap selects a word first. Pasting there goes through the text field.
`lib/live-input.ts` holds the keyboard and clipboard rules for this view and
the Device panel.

These are frames, not a video stream: a few a second while the page moves.
A video stream (the screencast encoded as H.264 and decoded by WebCodecs in the
client) would be smoother on a fast link; it is not built.

## Who may do what

`browser.command` is the owner's and the conversation's own agent's, never
another conversation's: its token names one thread. A paired phone has
`browser.remoteStatus`, `browser.remoteFrame` and `browser.remoteInput` for a
conversation it has subscribed to, with `browser.remoteSelection` for the text
selected there, and never `browser.command`, so it cannot run a script in the
page. It can act in the page as a person would, signed-in
sites included: pair only devices you would give that. `browser.remoteChanged`
goes to the clients subscribed to the conversation.

On Linux and macOS the core speaks the DevTools protocol to the browser over
two pipes, `--remote-debugging-pipe` on the browser's descriptors 3 and 4,
which `procs.spawn` opens with `extraPipes`. No port is open: another process
of the machine, another account included, cannot reach the browser through
it. It can still read the profile folder if its permissions let it, as with
any browser profile.

On Windows Bun cannot open those descriptors (`EBADF`, CI on 2026-10-05), so
the browser listens on a random port of 127.0.0.1 and the core connects to it.
That port has no authentication: a process of the same PC that finds it can
drive the browser, signed-in profiles included. Do not copy sign-ins into the
agent browser of a Windows machine other people have an account on.

## Verification

`packages/core/test/browser.test.ts` drives a real headless Chromium when the
machine has one: opening, reading, clicking and typing, agent-browser's
refs, fill, select, check, a form submitted with Enter, dialogs inside and
outside a command and a covered element, presets and color scheme, diagnostics without query strings, a token kept to its conversation,
a paired viewer's frames and taps, a popup becoming a tab, cookies kept per
profile across a restart, a profile copied in by the owner, an MP4 recording
read back, a recording discarded at the end of a turn, and a machine without a
browser. `browser-cli.test.ts` checks the CLI's files with the browser stubbed.
`tests/e2e/agent-browser-core.test.ts` runs the whole path on a real core: the
owner's desktop at 1280 × 900 and a paired phone at 390 × 844 see the cover,
show the page and tap it, and the tap reaches the page. `browser-remote.test.ts`
covers the same views on the fake client.
The same tests pass on the Linux, Windows and macOS CI jobs. Reading a
WebView2 profile's cookies in the Windows shell is covered by unit tests of
the bridge with the shell stubbed, not by a run on Windows.
