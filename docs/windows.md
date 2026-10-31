# Desktop windows

`boite window` lets an agent capture a native desktop window of the machine
that runs the core, such as a Unity editor, a game or Blender. It can save the
window as a PNG or as a contact sheet of a few seconds, or show the window live
in the conversation's Window panel. iOS Simulators and Android emulators go
through [`boite device`](devices.md) instead: that command can also drive them.
An app the agent itself should run and drive goes on a
[virtual desktop](desktop.md).

Capture is read-only. Boite never restores, raises or focuses a window, never
sends it input and never draws the cursor.

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
