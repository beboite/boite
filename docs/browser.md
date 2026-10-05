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
in a page.

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
A process starts with the first tab that needs it, through `procs.spawn` as a
tool process of `system:browser`, so [the trace](trace.md) shows it. It closes
60 seconds after its last tab, and with the core. Deleting a profile in
Settings closes its tabs and removes its folder; a folder whose browser had
already closed goes at the next settings change or the first use of the agent
browser after a restart. A folder that cannot be removed is logged.

Logins live on the machine that runs the agent, not on the device that shows
it. To sign in to a site for an agent, open the conversation's browser, show
it and sign in there; the profile keeps the session for the next tabs.

A conversation has at most 8 tabs and a machine 24. A page that opens a
window, a sign-in popup for instance, adds a tab to the same conversation; past
the limit the window is closed. An alert is accepted and a confirm or prompt
declined, since nobody can answer them in a headless page, and both are noted
in the diagnostics. Downloads are refused. Archiving or removing the
conversation closes its tabs.

The agent's commands of one conversation run one after the other, in order.
`open` and `navigate` wait up to 15 seconds for the load event; a page still
loading by then is returned with `loading: true` rather than an error.

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

The panel's **Agent browser** surface shows the conversation's tabs. Until the
user asks, it shows a card that names the machine, "This agent controls a
browser on m2", with the page's title, and a **Show** button; nothing is
captured or sent before that. Show starts the live view: an address bar with
back, forward and reload, the agent's tabs to pick from, and the page, which
takes taps, drags, text and keys. Hide stops it. When the agent opens a tab in
the conversation on screen, the panel opens on that surface, still covered.
The launcher's **W** opens it by hand. The cover holds for the conversation
while the app stays open; a reload covers it again.

The live view asks for one JPEG at a time (`browser.remoteFrame`), the next as
soon as the last has arrived, sized to what the view shows and lighter on a
slow link; [phone](phone.md#the-agents-browser-on-a-phone) has the schedule.
Every viewer that asks within 150 ms gets the same capture, so a desktop and a
phone watching one tab cost one. Input names the frame it was aimed at; a tap
on a frame of another page or another viewport size is refused, and the
address bar accepts only http and https.

These are frames, not a video stream: a few a second while the page moves.
A video stream (the screencast encoded as H.264 and decoded by WebCodecs in the
client) would be smoother on a fast link; it is not built.

## Who may do what

`browser.command` is the owner's and the conversation's own agent's, never
another conversation's: its token names one thread. A paired phone has
`browser.remoteStatus`, `browser.remoteFrame` and `browser.remoteInput` for a
conversation it has subscribed to, and never `browser.command`, so it cannot
run a script in the page. It can act in the page as a person would, signed-in
sites included: pair only devices you would give that. `browser.remoteChanged`
goes to the clients subscribed to the conversation.

The core speaks the DevTools protocol to the browser over two pipes,
`--remote-debugging-pipe` on the browser's descriptors 3 and 4, which
`procs.spawn` opens with `extraPipes`. No port is open: another process of the
machine, another account included, cannot reach the browser through it. It can
still read the profile folder if its permissions let it, as with any browser
profile.

## Verification

`packages/core/test/browser.test.ts` drives a real headless Chromium when the
machine has one: opening, reading, clicking and typing, presets and color
scheme, diagnostics without query strings, a token kept to its conversation,
a paired viewer's frames and taps, a popup becoming a tab, an MP4 recording
read back, a recording discarded at the end of a turn, and a machine without a
browser. `browser-cli.test.ts` checks the CLI's files with the browser stubbed.
`tests/e2e/agent-browser-core.test.ts` runs the whole path on a real core: the
owner's desktop at 1280 × 900 and a paired phone at 390 × 844 see the cover,
show the page and tap it, and the tap reaches the page. `browser-remote.test.ts`
covers the same views on the fake client.
The tests ran on Linux; Windows and macOS discovery is checked by path only.
