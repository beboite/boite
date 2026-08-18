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

## The MCP bridge (dev only)

`dev:isolated` also enables the `mcp-bridge` feature, so an agent can drive that
window: screenshots, DOM reads, JS evaluation.

**It is an unauthenticated WebSocket server**, deliberately bound to
`127.0.0.1` where the plugin's own default is `0.0.0.0`, and JS evaluated in the
webview reaches the IPC that spawns PTYs. Never enable the feature for a build
you hand to anyone. Plain `bun run tauri dev` leaves it out of the binary.

The agent side is `@hypothesi/tauri-mcp-server`, pinned to the crate's version:
they ship as one pair, and its binary is named `mcp-server-tauri`, which is not
a package name and resolves to nothing through `npx`.

```json
{
  "mcpServers": {
    "boite-dev": { "command": "npx", "args": ["-y", "@hypothesi/tauri-mcp-server@0.12.0"] }
  }
}
```

Twenty tools, around 26 KB of schema per session, so register it only while
actually driving the dev window. It is unrelated to the agent MCP endpoint in
the README, which is scoped to the calling thread, and it is not the way to find
out what the app is doing: it drives
an instance it started itself, under another identifier and therefore another
database. `workspace_snapshot` carries `screen` and `window.__boite` reads a
terminal back as text. Reach for the bridge for what only a real pointer can do.

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
