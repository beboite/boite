# Virtual desktop

`boite desktop` gives a conversation a private graphical desktop on a Linux
machine. An agent starts GUI apps there and drives them through their
accessibility tree with [agent-desktop](https://www.npmjs.com/package/agent-desktop):
it reads the tree as a snapshot of `@ref` elements, then clicks, types and
presses keys on them. The desktop lives in memory. Nothing reaches the user's
screen, keyboard, session bus or speakers, so it also runs on a headless server.

[`boite window`](windows.md) is the other way to see an app: it captures windows
of the user's real session and never sends them input.

## Commands

```sh
boite desktop status
boite desktop run gnome-calculator
boite desktop snapshot --app gnome-calculator -i --compact
boite desktop click @e12
boite desktop type @e3 "hello"
boite desktop screenshot --app gnome-calculator shot.png
(eval "$(boite desktop env)"; bun run test:gui)
boite desktop stop
```

- `status` shows the desktop, its apps with their exit codes and log files,
  what the machine lacks to start one, and where agent-desktop is.
- `start [--size WxH]` starts the desktop, 1280x800 by default, from 320 to
  3840 pixels a side. `run` starts it too when needed.
- `run <program> [args...]` starts a program on the desktop in the current
  folder. It outlives the turn. Its output goes to a log file, capped at 1 MB.
  `run` waits a second, so a program that exits at once reports its code and
  log. A desktop remembers its last 32 apps.
- `env` prints `export` and `unset` lines for the agent's own tools, such as a
  test runner that opens a window. Use them in a subshell: they also move
  `HOME` and the XDG folders, where tools such as `git` and `gh` keep their
  settings and logins.
- `stop` stops every app, then the desktop.
- Any other word runs agent-desktop on the desktop with the words as given:
  `snapshot`, `click`, `type`, `press`, `find`, `wait`, `screenshot`,
  `list-windows` and the rest. `boite desktop skills get desktop` prints
  agent-desktop's own guide. Its output and exit code come back unchanged;
  `--json` wraps them.

agent-desktop's `--headed` sends real keys and clicks through the X server
instead of accessibility actions. It is safe here, since nobody else uses the
display: a web page's text field, for one, takes `type` only with it. Refs come
from the last snapshot. A command that needs the desktop before one
exists fails with `no desktop yet` and runs nothing.

agent-desktop runs from the agent's shell, found on its `PATH`. Install it with
`npm i -g agent-desktop`; `status` says when it is missing.

## The desktop

The core starts four programs per desktop, each in its own process group:

1. `Xvfb -displayfd 1 -nolisten tcp -auth <dir>/Xauthority` picks a free
   display and draws in memory.
2. `dbus-daemon` on a socket in the desktop's folder, with the standard
   session policy and no service directory: nothing starts on demand, so no
   keyring password prompt, portal or notifier opens over an app.
3. `at-spi-bus-launcher`, the accessibility bus on that session bus. The core
   waits for `org.a11y.Bus` through `dbus-send` before it goes on.
4. `openbox`, the window manager. Without one, agent-desktop finds no window.

The folder is a fresh `boite-desktop-*` under the system temporary folder. It
holds the X cookie, the bus socket, the app logs, the apps' XDG folders and
agent-desktop's own state.

Apps on the desktop get this environment, which `env` prints:

- `DISPLAY`, `XAUTHORITY` and `DBUS_SESSION_BUS_ADDRESS` of the desktop.
- X11 forced for GTK and Qt (`GDK_BACKEND`, `QT_QPA_PLATFORM`,
  `XDG_SESSION_TYPE`), and the accessibility switches of Qt and Chrome
  (`QT_ACCESSIBILITY`, `QT_LINUX_ACCESSIBILITY_ALWAYS_ON`,
  `ACCESSIBILITY_ENABLED`). Chrome exposes its page without
  `--force-renderer-accessibility`.
- No sound: PulseAudio and PipeWire point to a socket that does not exist,
  and SDL uses its dummy driver.
- `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` in the desktop's folder. A
  single-instance app (Chrome, Firefox, Electron, VS Code) keeps its profile,
  lock and socket there, so it never hands its window to the same app on
  another desktop or in the user's session. Apps start with a fresh profile;
  copy in what one needs.
- `AGENT_DESKTOP_HOME` in the desktop's folder.
- `WAYLAND_DISPLAY`, `WAYLAND_SOCKET`, `AT_SPI_BUS_ADDRESS`,
  `SESSION_MANAGER`, `DESKTOP_STARTUP_ID` and `NO_AT_BRIDGE` removed, so no app
  reaches the user's own session.
- `BOITE_DESKTOP_ID`, the mark the stop looks for. `env` leaves it out: a
  shell that exported it would have its own commands killed by the stop. What
  the agent starts with `env` belongs to its own shell: a GUI program there
  loses its display and exits when the desktop stops, and the rest ends with
  the agent's process tree.

## Security

- The display takes only clients that hold its cookie, a random
  MIT-MAGIC-COOKIE-1 in a 0600 file. Another account on the machine cannot
  open it, read its apps or type into them. Xvfb listens on no TCP port.
- The session bus listens on a socket in the desktop's 0700 folder.
- A conversation under an execution policy is refused: what its desktop starts
  would run outside that policy.
- The `desktop.*` methods are agent methods for the agent's own conversation.
  A paired device cannot call them. A session must subscribe to the
  conversation first.
- An archived conversation can read its status and stop its desktop, but not
  start one or run a program.

## Lifetime

A desktop has no idle timeout. It stops when:

- the agent runs `boite desktop stop`;
- its conversation is archived or removed;
- Xvfb, the bus, the accessibility bus or openbox exits;
- the core stops.

Stops that overlap share one teardown. A desktop still starting when its
conversation is archived or the core stops has its programs stopped at once
and never opens.
A stop ends the apps, then the stack from openbox down, then sends `SIGKILL` to
any process left whose environment carries the desktop's `BOITE_DESKTOP_ID`,
then deletes the folder. An app that daemonized out of its process group is
caught by that mark.

## Platforms

Linux only. The machine needs `xvfb`, `dbus-daemon`, `at-spi2-core` and
`openbox`; `dbus-send` is optional. On Debian and Ubuntu:

```sh
sudo apt install xvfb dbus-daemon at-spi2-core openbox
```

`status` names the missing packages. On Windows and macOS agent-desktop would
act on the user's own session: Boite does not offer that, and `status` says so.

Chrome, Electron, Qt and GTK apps expose their tree. An app that draws
everything itself, such as a game, has none: use `screenshot` and coordinates.

## Tests

`packages/core/test/desktop.test.ts` covers the Xauthority layout, the
environment, tool detection, the validators and the argument parsing. With the
four tools installed, it also starts a real desktop. It checks that an app sees
the desktop's display and no Wayland, and that the display refuses a client
without the cookie. A fake stack covers a stop or an archive that comes while
a desktop starts or stops. It then checks that archiving leaves no marked process and
no folder. The CI's Linux core jobs install the tools and run it.

`BOITE_E2E_DESKTOP=1` with agent-desktop and `google-chrome` on `PATH` adds a
live test: Chrome opens a page, agent-desktop finds its button in a snapshot,
clicks it, and the window title changes. A second conversation's Chrome then
opens on its own desktop, not in the first one's window.
