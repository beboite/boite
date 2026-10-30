# Desktop windows

`boite window` lets an agent capture a native desktop window of the machine
that runs the core, such as a Unity editor, a game or Blender. It can save the
window as a PNG or as a contact sheet of a few seconds, or show the window live
in the conversation's Window panel. On Windows, it can also read a window's
controls and draw a box showing the user where to click
([guiding the user](#guiding-the-user)). iOS Simulators and Android emulators
go through [`boite device`](devices.md) instead: that command can also drive
them.

Capture is read-only. Boite never restores, raises or focuses a window, never
sends it input and never draws the cursor. The guide's box is a window of the
desktop app above the others, which lets every click through.

## Commands

```sh
boite window list
boite window screenshot --process Unity --output shots/editor.png --max 1280 --crop 0,0,0.5,0.5
boite window clip --id 132456 --seconds 3 --fps 4
boite window watch --title "SampleScene"
boite window close
```

- `list` prints each window's id, process, PID, size and state: minimized, or
  excluded (see Privacy). A title appears only for an app the project allows.
- A target is exactly one of these:
  - `--id`: the window id.
  - `--process`: the executable's name; `.exe` is optional and case is ignored.
  - `--title`: part of the title. It matches only windows of allowed apps, since
    other titles stay hidden.

  When several windows match, the command is refused and lists the candidates,
  so the agent can repeat it with `--id`.
- `screenshot` writes one PNG.
  - `--max` sets the longest side: 1280 by default, 0 for full size.
  - `--crop x,y,w,h` takes pixels of the window, or fractions from 0 to 1 when
    the values have a decimal point.
  - The answer gives the path, the size, the window's own size, an estimate of
    the tokens it costs to read (about w×h/750) and the window id.
- `clip` takes `--seconds` (at most 10) at `--fps` (at most 4, default 2).
  - It writes one contact sheet: a grid close to square, each tile labelled
    with its number and time.
  - The sheet fits `--max` across, or 8192 pixels with `--max 0`.
- Without `--output`, the file goes to the conversation's temporary folder
  (`<temp>/boite-windows/<thread-id>/`), created for this user only. A folder
  there that is a link or belongs to another user is refused. An `--output`
  must be:
  - a new `.png` file;
  - in a folder that, once links are followed, sits inside the conversation's
    folder, its project or that temporary folder.

  The core writes the file, after checking again that its folder still
  resolves to the same place. The image goes nowhere else.
- `watch` opens the window in the conversation's Window panel. `close`
  empties the panel.

A command can wait up to 10 minutes for the owner's consent (see Privacy), so
the CLI allows 11 minutes per window request.

## Privacy

The checks run in this order. The first one that fails refuses the capture:

1. **Excluded apps** are never captured, even when asked for:
   - 1Password, Bitwarden, KeePass, KeePassXC and Dashlane;
   - the Windows sign-in, lock and elevation screens (`LogonUI.exe`,
     `LockApp.exe`, `CredentialUIBroker.exe`, `consent.exe`);
   - any name or full executable path listed in the
     `windowCaptureExclusions` setting (Settings, General, Never capture).
     An app added there while the panel shows it closes the panel on the next
     frame.

   `WINDOW_CAPTURE_EXCLUDED` in `packages/contracts/src/windows.ts` holds the
   built-in list.
2. **A minimized window** is refused with `window minimized: restore it first`.
3. **A turn a contact wrote into** is refused. If a letter from another owner's
   Boite reached the conversation since its last finished turn, the agent may
   be doing what that contact asked, and the desktop belongs to the owner alone.
4. **An app whose executable path the system will not give** cannot be allowed,
   so it is refused.
5. **The project's allowed apps.** Each project keeps a list of allowed apps,
   keyed by executable path (table `window_allowlist` in the journal).
   - An app on the list is captured straight away, and its titles show in
     `list` and the panel.
   - Any other app draws a consent card in the conversation and the command
     waits for the answer, up to 10 minutes:
     - **Allow once** lets this capture or watch through.
     - **Always for this project** adds the app to the list.
     - **Refuse**, or no answer in time, refuses the capture.
   - Once the owner answers, the window is checked again: if its id now names
     another program, or the app was excluded or minimized during the wait,
     the capture is refused.
   - Phones get a push notification for the card.
   - Two captures of the same kind (screenshot, clip or watch) of the same app
     share one card.

Every capture leaves a `window_capture` item in the conversation, with a JPEG
thumbnail of at most 320 pixels. This applies to screenshots, clips and the
first picture of each viewing in the panel. Settings, General, Allowed windows
(also reached from a project's menu) lists the allowed apps of each project;
removing one asks for confirmation first. The next capture of that app asks again, and a panel
showing it closes on its next frame.

Logs keep only the window id, the process name, the sizes and the capture path
(`source: windows`). Titles and pixels never go to logs, telemetry or
diagnostic exports.

## Who may call what

| Method | Owner | Paired device | Agent |
|---|---|---|---|
| `windows.list`, `windows.close` | yes | yes | its own conversation |
| `windows.screenshot`, `windows.clip`, `windows.watch` | yes | no | its own conversation |
| `windows.frame` | yes | yes | no |
| `windows.consent` | yes | yes | no |
| `windows.allowlist`, `windows.revoke` | yes | no | no |
| `windows.read`, `windows.point`, `windows.waitClick`, `windows.unpoint` | yes | no | its own conversation |

The reason for each entry sits beside it in `AGENT_METHODS`
(`packages/core/src/access.ts`) and `DEVICE_METHODS`
(`packages/contracts/src/access.ts`). An agent's token works only for its own
conversation, so it cannot reach another project's windows panel or cards.
`windows.changed` goes only to clients subscribed to the conversation.

## The Window panel

The Window panel opens when an agent runs `boite window watch`. It works like
the [Device panel](devices.md):

- Nothing is captured until a viewer presses Show. Hide stops the capture.
- While shown, the panel asks `windows.frame` for a JPEG a few times a second
  and redraws only when the picture changes (`previous` / `unchanged`).
- Viewers that ask within 200 ms share one capture.
- After 10 seconds without a request, the OS capture stops.
- The panel only displays the window and sends it nothing. It works on desktop
  and phone.
- Every 2 seconds the core checks that the window id still names the same
  process and path. If the window closed, the panel empties.

## Guiding the user

On Windows, an agent can teach the user an app instead of acting for them: it
reads a window's controls as text, draws a box over the one to press, and
waits for the user's click there. Nothing is ever clicked, typed or focused
for the user.

```sh
boite window read --process Unity --filter play
boite window point 3 --label "Press Play"
boite window wait-click --timeout 120
boite window point --process Unity --name Window
boite window point --process Unity --at 0.4,0.3,0.2,0.2 --label "The Scene view"
boite window unpoint
```

- `read <target>` lists the window's enabled controls on screen from its
  accessibility tree (UI Automation), one line each:
  `#3 Button "Play" 912,58 32x24`. Coordinates are the window's physical
  pixels, those of a full-size screenshot. The types kept are the ones a person
  acts on: buttons, menu items, tabs, list and tree items, fields, check and
  radio boxes, sliders, links. A control with neither a name nor an
  automation id is left out.
  - 60 lines by default, `--limit` up to 400; `--filter` keeps names that
    contain the text, without case. About 10 tokens a line, against
    1,000 to 3,000 for a screenshot.
  - The ids stay valid until the conversation's next read.
- `point` draws one box with a label (80 characters at most) and replaces the
  conversation's previous one. It takes exactly one of:
  - `<id>`: a control of the last read, `3` for `#3` (a shell reads `#` as
    the start of a comment). Without `--label`, the box says the
    control's name.
  - `<target> --name <name>`: reads the window and takes the control with that
    name, an exact match without case first, then the names that contain it.
    Several matches are refused with their ids.
  - `<target> --at x,y,w,h`: a rectangle of the window in pixels, or fractions
    from 0 to 1, as `--crop` takes it. For an app with no accessibility tree,
    such as a game or a Unity scene view: the agent finds the place in a small
    screenshot first.
- The box is drawn by the Boite desktop app of the machine that runs the
  core, in the app's look: a ring in the user's accent with a label tab on its
  corner, one entrance and a slow echo, none with reduced motion. It is
  click-through, takes no focus and has no taskbar button. With no desktop app
  of that machine open, `point` is refused and asks for one.
- The box follows its window when the window moves, hides while it is
  minimized, and goes away with it, after `--seconds` (120 by default, 600 at
  most), on `unpoint`, or when the conversation is archived.
- `wait-click` returns once the user presses the primary mouse button inside
  the box, then takes the box away. A button already held when the wait starts
  does not count. Without a click within `--timeout` (120 s by default, 600 at
  most), the box stays for another try: a wait keeps it up until at least
  30 s after the wait ends. The agent learns only that the click
  happened.
- The Start menu, search and the other system flyouts lie in a layer of the
  system above every app's window, the box included. `point` still answers,
  with `behind: true` and a line telling the agent to say where to click;
  `wait-click` still sees the click there.
- The taskbar is listed as the `explorer.exe` window with no title, so an agent
  can point at its Start button.

Privacy follows the captures': `read` and `point --name` show a consent card
asking to read the app (`read`), refuse excluded and minimized windows and a
turn a contact wrote into, and an allowed app reads at once. `point --at`
reads nothing of the window, so it draws without a card, but excluded apps and
a contact's turn are still refused. The log keeps the window id, the process,
the control type and counts, never a control's name. `boite window read` and
`point` are refused on Linux and macOS, which still have screenshots.

## Backends

`ProcessPlatform.windowCapture()` loads the backend the first time a `boite
window` command runs. Nothing loads at core startup.

### Windows

The backend uses Windows.Graphics.Capture (WGC) through `bun:ffi`
(`platform/windows/window-capture.ts`, `window-capture-wgc.ts`).

- It turns off the capture border and the cursor.
- It reads the window's own DWM surface, so a window covered by others still
  comes out whole.
- If WGC fails or returns black, `PrintWindow` with `PW_RENDERFULLCONTENT`
  is used instead. That fallback is skipped for a hung window, because it would
  block the core.
- A picture that is still black after both is refused as black. This happens
  with exclusive full screen or protected content.

The backend runs in the core process rather than in a helper executable.
Measured on 2026-10-24 (Ryzen 7 7800X3D, Windows 11, Bun 1.4.2,
`bun bench/window-capture.ts boite 20 200`, a 1920×1032 window):

| Step | Time |
|---|---|
| Load | 2.3 ms (25 ms on the first, transpiling run) |
| `list()` | 2.2 ms |
| First capture | 86.6 ms |
| Later WGC capture (median) | 26.8 ms |
| `PrintWindow` alone (median) | 13.3 ms |

Memory grows by 24 MB over 200 captures and levels off. A helper process would
cost 23 ms just to start and exit (`Bun.spawn` of `cmd /c exit`, median),
before any pixels came back.

`packages/core/test/window-capture-windows.test.ts` checks the backend:

- A red test window is captured while hidden behind a blue one.
- A minimized window is refused as minimized, and a window id that no longer
  exists is refused as gone.
- The test kills only the PIDs it spawned.

### The guide on Windows

`ProcessPlatform.windowGuide()` loads `platform/windows/window-guide.ts` the
first time `read` or `point` runs. It runs on the core's thread, as captures
do. The core reads the controls, follows the window and watches the mouse;
the desktop app draws the box.

- `read` is one UI Automation `FindAllBuildCache` from the window
  (`window-controls.ts`): a condition on the interactive control types and a
  cache of six properties, so the window's process answers in one round trip
  and nothing is read element by element. A window that is not responding is
  refused before the call; UI Automation's connection and transaction timeouts
  (2 s and 5 s) bound a slow one. `AutoSetFocus` is off and no pattern is
  asked for, so nothing in the window changes.
- The core sends `windows.pointer` (an id, the control's rectangle in
  physical screen pixels and the label, or no rectangle to take the box away)
  to owner connections named `shell` on the loopback only: a phone, a browser
  tab or a desktop app following this core from another computer has no screen
  of this one's. The main UI hands each event to the shell's `pointer_show` and
  `pointer_hide` (`lib/pointer-layout.ts`), and only for its own machine's
  core.
- The shell (`pointer_window.rs`) shows the box in a transparent window of its
  own, `index.html?view=pointer` (`PointerApp.svelte`), drawn with `app.css`.
  The window is undecorated, topmost, click-through
  (`WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`), sized to the
  control plus room for the ring's echo and the label, in the control
  monitor's DPI. A thread puts it back above the taskbar every 250 ms while a
  box shows, since the taskbar raises itself when clicked. A box that goes away
  leaves its window hidden for the next one; a window unused for 45 s closes.
  The window belongs to the shell, never to an agent: the focus guard sends a
  window of an agent's process that takes the foreground to the bottom, out of
  the topmost band.
- Every rectangle is in physical pixels: the thread is per-monitor aware (V2)
  for each call.
- `wait-click` reads the primary button with `GetAsyncKeyState` and the cursor
  every 25 ms while a wait lasts; no hook is installed.
- `GetWindowBand`, which user32 exports without documenting it, tells a system
  flyout's layer from an app's. Where it is missing, every window reads as an
  app's.

Measured on 2026-10-30 (Windows 11, Bun 1.4.3, `bun bench/window-guide.ts
<match> 20 100`):

| Window | Controls | First read | Later read (median) |
|---|---|---|---|
| Taskbar, 1920×48 | 16 | 54 ms | 29 ms |
| Boite, 1920×1032 (WebView2) | 102 | 212 ms | 97 ms |

The Start menu read in 207 ms with 19 controls. Reading where a window lies,
which a box following its window does every 250 ms, takes under 0.1 ms. RSS
grows by 3 MB over 200 reads of the taskbar.

`packages/core/test/window-guide-windows.test.ts` opens a WinForms window that
never takes the focus and reads its two buttons and its field but not its
disabled button. `PointerApp.test.ts` checks the ring and the label, and
`pointer_window.rs`'s tests the window's place at 100 % and 150 %, on a
monitor's edge and on a monitor left of the primary.

### Linux

On an X11 session, the backend uses libX11 through `bun:ffi`
(`platform/x11-window-capture.ts`).

- It lists `_NET_CLIENT_LIST`, or the root's mapped children when no window
  manager runs.
- It reads `_NET_WM_PID` and `/proc/<pid>/exe`. A window whose
  `WM_CLIENT_MACHINE` names another host (forwarded with `ssh -X`) gets no
  PID or executable, since that PID belongs to another machine: it cannot be
  allowed, so it is refused.
- With libXcomposite, it reads the window's own pixmap, so a covered window
  comes out whole. Without it, `XGetImage` returns whatever lies on top.
  Without a compositing window manager, the first read redirects the window
  and asks for an Expose, as uncovering it would, so the app paints the
  covered part.
- An X error such as `BadWindow` is turned into "gone" instead of ending the
  process.

CI runs `packages/core/test/window-capture-x11.test.ts` under Xvfb
([ci.md](ci.md)).

Boite refuses with an explicit reason in these cases:

- **A Wayland session**, including XWayland. A Wayland compositor gives an app
  another app's window only through the desktop portal's own picker.
- **No `DISPLAY`**, as on a server or in a container.
- **libX11 missing.**

### macOS

Refused: window capture there needs ScreenCaptureKit, which Boite does not
drive yet.
