# Development

Build commands and system dependencies are in the [README](../README.md). The
rules that are easy to break are in [`AGENTS.md`](../AGENTS.md).

## A dev window next to a release install

A running release instance holds the single-instance lock, so `tauri dev`
refuses to start. Beside it:

```bash
bun run dev:isolated
```

A separate **"Boite Dev"** window on port `1430` under the `dev.boite.dev`
identifier, with its own SQLite file and an empty project list.

## The dev MCP (dev only)

`dev:isolated` also enables the `mcp-bridge` feature, so an agent can drive that
window: screenshots, DOM reads, JS evaluation.

**It is an unauthenticated WebSocket server**, deliberately bound to
`127.0.0.1` where the plugin's own default is `0.0.0.0`, and JS evaluated in the
webview reaches the IPC that spawns PTYs. Never enable the feature for a build
you hand to anyone. Plain `bun run tauri dev` leaves it out of the binary.

The agent side is `boite-mcp --dev`, the same binary the app already ships as a
sidecar, in a second mode. It replaces `@hypothesi/tauri-mcp-server`, which was
pinned to the plugin's version, cost twenty tools and around 26 KB of schema per
session, and could reach only the webview: the dev instance's log directory and
its database were outside it, and those are what a check usually needs.

```json
{
  "mcpServers": {
    "boite-dev": {
      "command": "D:/Dev/Collab/boite/target/debug/boite-mcp.exe",
      "args": ["--dev", "--repo", "D:/Dev/Collab/boite"]
    }
  }
}
```

`--repo` is the checkout `bun run dev:isolated` runs in and defaults to the
working directory; `--port` is the isolated config's vite port and defaults to
`1430`. Register it only while actually driving the window.

| Tool | What it does |
|---|---|
| `dev_window` | `start`, `stop`, `status`, `restart`. `fresh: true` wipes the dev database first, `env` hands the app variables |
| `dev_inspect` | `overview`, `projects`, `threads`, `thread`, `read`, `mounted`, `toasts`, `panes`, `settings`, one `execute_js` of the matching `window.__boite` call |
| `dev_drive` | `click`, `type`, `press`, `screenshot`, `eval` |
| `dev_logs` | the `logs` tool pointed at `%LOCALAPPDATA%\dev.boite.dev\logs`, both actions reading the files |
| `dev_db` | one read-only statement on `%APPDATA%\dev.boite.dev\boite.db` |

`dev_scenario`, the sixth tool in [`pilot.md`](pilot.md), is not here yet: the
`e2e/` runner it lists and runs does not exist. The seam it will use does:
`dev_window`'s `env` is how a scenario run hands the app
`BOITE_PILOT_CLAUDE_BIN` and `BOITE_PILOT_SCENARIO`, and `fresh: true` is how it
starts from an empty database.

Three rules it is built on.

- **Only `dev.boite.dev`.** The identifier is a constant in `dev/paths.rs` and
  is never taken from an argument, so no call can be pointed at
  `com.boite.desktop`, whose database, scrollback and window state are open
  while you work. A test asserts every path it answers.
- **Only a pid captured at spawn.** `start` puts the whole `bun` → `tauri` →
  `cargo` → app tree in a `boite_core::job::Job` with `KILL_ON_JOB_CLOSE`, and
  `stop` closes that handle. Nothing is ever killed by name: this worktree's
  path and the word "boite" are in the argv of the user's own threads and of
  the app drawing them.
- **The window never takes the screen.** `start` sets `BOITE_DEV_UNATTENDED=1`,
  and `lib.rs` builds the window with `focus = false` when that variable is set
  and only then, so a second app coming up does not take the keyboard from
  whoever is using the machine. The console is `CREATE_NO_WINDOW` for the same
  reason.

`start` waits until port 1430 answers **and** the bridge accepts a connection,
with a ten minute deadline that covers a cold debug build of `src-tauri`.
`status` answers `down`, `building` or `up` with the pid, the elapsed time and,
while building, the tail of what the build printed. A child that exits during
the wait ends it at once with that tail, which is where the compile error is.

`dev_db` takes `SELECT`, `PRAGMA` and `EXPLAIN` and refuses everything else,
including a write hidden behind a read (`SELECT 1; DELETE FROM threads`), which
is refused whole rather than truncated. The connection is opened
`SQLITE_OPEN_READ_ONLY` as well; the first guard exists because the useful
refusal is the one an agent reads before its statement reached anything.

`dev_drive action=eval` is dev only and reaches the app's IPC, which is what
spawns PTYs. It is the last thing to reach for, and never a way to run text
somebody else wrote.

This is not the way to find out what the user's boite is doing: it drives an
instance it started itself, under another identifier and therefore another
database. `workspace_snapshot` carries `screen` and `window.__boite` reads a
terminal back as text.

### The bridge wire, as pinned against the crate

Read off `tauri-plugin-mcp-bridge` 0.12.0's source rather than its README, since
this is now written against rather than through a package that shipped with it.

- **The port is discovered, never published.** The plugin's `base_port` is
  `9223` and `discovery::find_available_port` takes the first port it can bind
  in `base_port..base_port + 100`, so the bridge is somewhere in **9223 to
  9322**. The chosen port is logged and dropped, so a client scans the range and
  identifies the window it found: `list_windows` carries every window's title,
  and the dev window's is `Boite Dev`, the isolated config's `productName`. A
  release boite has no bridge at all, the plugin sitting behind
  `debug_assertions` and the feature.
- **One text frame in, one out**, matched on an `id` the client chooses.
  Request: `{"id", "command", "args"}`. Answer: `{"id", "success", "data"?,
  "error"?}`, plus `windowContext` on the commands that resolve a window. The
  same socket also carries broadcast events (the element picker), so a client
  reads past any frame whose `id` is not its own.
- **Ten verbs**, the whole of `dispatch_command`: `list_windows`,
  `get_window_info`, `execute_js`, `capture_native_screenshot`, `resize_window`,
  `register_script`, `remove_script`, `clear_scripts`, `get_scripts`, and
  `invoke_tauri`, which proxies nine of the plugin's own IPC commands
  (`get_window_info`, `get_backend_state`, `start_ipc_monitor`,
  `stop_ipc_monitor`, `get_ipc_events`, `emit_event`) and refuses anything else.
- **`execute_js` wraps the script in an async function body**, so it must
  `return` and it may `await`. Its `data` is the returned value as JSON. On
  Windows the answer comes back through a Tauri event rather than from the
  webview call, so a script that never returns hangs until the client's own
  timeout.
- **`capture_native_screenshot` answers a base64 data URL**, PNG by default,
  from WebView2's `CapturePreview`: the viewport only, and `maxWidth` resizes
  it. The terminals render to a WebGL canvas, so what a screenshot shows of them
  is a rectangle; `dev_inspect what=read` is their text.

## The browser pane, and what it is allowed to reach

`pane_open` lets an agent put a page beside its own terminal. It is not a
browser: no extensions, no devtools, no cookies outside their own dev servers,
at whatever width the split is, so the pane says as much rather than passing for
one (the word "preview" before the address, a note read once per device under
`boite.browserNoteRead`, the `i` button to bring it back, its own close button).

What ships is an `<iframe>`, and its address is the only thing an agent hands
this app that the app renders in its own window. Three rules hold it, written in
three places that have to agree:

| Where | What it holds |
|---|---|
| `frame-src` in `tauri.conf.json` | the origins the webview will frame at all |
| `classify_browser_url` in `agent_api.rs` | what the MCP endpoint accepts from an agent |
| `classifyBrowserUrl` in `features/browser/url.ts` | the same rules again, since the identical request also arrives from a remote boite and never passed through that endpoint |

- **Loopback over http, anywhere over https.** `localhost`, `127.0.0.1`, `[::1]`
  and `0.0.0.0` are listed literally in all three. A host one accepts and the
  CSP does not is a pane that opens blank.
- **Never the app's own origin.** Tauri serves the window from `*.localhost` and
  the dev build from ports 1420 and 1430. A page framed there is same-origin
  with the webview, which hands it `window.parent` and the IPC behind it.
  Refused with a message the agent can read.
- **Off this machine means asking.** It goes in front of the user before the
  frame exists, and loads without `allow-same-origin`, so its scripts run in an
  opaque origin with no storage and no cookies.
- A userinfo segment (`http://evil.com@localhost`) is refused in every case: it
  exists only to make the host read as something it is not.

A site can still refuse to be framed (`X-Frame-Options: DENY` or a
`frame-ancestors` CSP), and the component offers "open outside" once enough time
has passed to rule out slow. Localhost dev servers send neither.

**An agent can read and drive the page on a desktop window**, not across the
origin boundary but from inside it: the main webview is built with an
initialization script injected into every frame
(`src-tauri/scripts/pane-driver.js`, attached in `lib.rs`, which is why the
window is built in code rather than declared in `tauri.conf.json`). It wires up
only at frame depth one (`parent === top`), so a frame nested inside a page
never answers its parent page's messages.

End to end: `browser` with `action=snapshot` (elements with stable `uid`s,
`mode=text` prose, or `mode=diff` since the last look), then
`action=click|type|press|scroll|screenshot`. A question rides
`Workspace::ask_for_answer` to the webview (`boite://agent-request` with a
`requestId`), `agent-requests.ts` re-checks the pane and the `drivenBy` mark,
`features/browser/driver.ts` posts into the frame and matches the answer by
source, and `agent_answer` resolves the HTTP handler still holding the call. The
server host has no injected script, so its `ask_for_answer` refuses with a
sentence the agent reads. `action=screenshot` is `PrintWindow` cropped to the
pane rect (`commands/capture.rs`), Windows only today, capped at 1568px.

### Where the pane opens, and why nothing else moves

The pane opens beside the **caller's own** terminal, in that thread's group, and
nothing else moves: the selected project, the thread on screen and the keyboard
focus stay where the user left them (`openPane`'s anchor, `openBeside`'s `focus`
flag, passed `false` on the agent path). A toast says what was opened when the
group is not the one being drawn (`panes.openedOffScreen`).

So the group holding that pane is usually hidden, and hidden means
`visibility: hidden` rather than unmounted: `+page.svelte` mounts every group at
once, the frame loads and the driver answers while nobody is looking. Two things
follow:

- **No browser tool is scoped to the project on screen.** `window_showing` used
  to refuse every caller whose project was not the one being drawn, so an agent
  working while the user read elsewhere was told "the window is showing another
  project right now" by every call, including about the pane it had just opened.
  `which_pane` holds the only rule: the `drivenBy` mark. Naming no `paneId` means
  the caller's own pane, since the description carries every group's panes.
- **A hidden pane is laid out at the same coordinates as the pane covering it**,
  so a photograph of its rectangle is of somebody else's pane. Panes carry
  `visible` for that (`Pane::shown()` in `boite_core::screen`, absent from an
  older build's description and read as visible), and `browser_screenshot`
  refuses when its pane is not on screen. `browser_snapshot` reads it anyway.

## window.\_\_boite

A screenshot, a DOM read and a way to run JavaScript reach almost nothing here:
**the terminals render to a WebGL canvas**, so to `querySelector` they are blank
elements, and text in a picture cannot be grepped. Toasts dismiss themselves
before a screenshot is taken. So a dev build puts a read-only inspector on
`window.__boite`, returning plain JSON that `webview_execute_js` hands back:

| Call | Answers |
|---|---|
| `overview()` | view, workspace, counts, what is active |
| `threads(project?)`, `thread(idOrName)` | project, cwd, worktree, session id, command, running |
| `projects()` | id, path, git root, archived, thread count |
| `read(idOrName, tail?)` | **what a terminal is showing, as text** |
| `mounted()` | which terminals can be read right now |
| `toasts(tail?)` | every toast raised this session, dismissed ones included |
| `panes()`, `settings()` | how the panes are split; the settings blob |

Threads are addressable by label (`read("Claude #1")`) because ids are uuids
nobody reads off a screen; a name matching two threads is refused rather than
resolved to the first. A terminal exists only once its pane has been opened, so
`read` on a thread nobody clicked says so.

`import.meta.env.DEV` gates the installer and the toast history, so a release
build never sets the global. Keep it read-only: a debugging aid that can change
state is a second way to drive the app, and nothing tests that one.
