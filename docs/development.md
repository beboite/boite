# Development

Build commands and system dependencies are in the [README](../README.md).
The rules that are easy to break are in [`AGENTS.md`](../AGENTS.md).

## A dev window next to a release install

A release instance already running holds the single-instance lock, so
`tauri dev` refuses to start. For a dev window beside it:

```bash
bun run dev:isolated
```

That launches a separate **"Boite Dev"** window on port `1430` under the
`dev.boite.dev` identifier, with its own SQLite file and an empty project list.

## The MCP bridge (dev only)

`dev:isolated` also enables the `mcp-bridge` feature, so an agent can drive that
window: screenshots, DOM reads, JS evaluation.

**The bridge is a dev-only tool.** It is an unauthenticated WebSocket server,
deliberately bound to `127.0.0.1`: the plugin's own default is `0.0.0.0`, and
JS evaluated in the webview reaches the IPC that spawns PTYs. Keep it on
loopback and never enable the feature for a build you hand to anyone. Plain
`bun run tauri dev` leaves it out of the binary entirely.

The agent side of that bridge is `@hypothesi/tauri-mcp-server`, pinned to the
same version as the crate: the npm package and the plugin ship as one pair, and
its binary is named `mcp-server-tauri`, which is not a package name and resolves
to nothing when handed to `npx`.

```json
{
  "mcpServers": {
    "boite-dev": { "command": "npx", "args": ["-y", "@hypothesi/tauri-mcp-server@0.12.0"] }
  }
}
```

It declares twenty tools, around 26 KB of schema in every session that loads it,
so it is worth registering only while actually driving the dev window.

The bridge is unrelated to the agent MCP endpoint described in the README, and
never reuses it: the bridge answers `execute_js`, that one answers seventeen
tools scoped to the calling thread.

It is also no longer the way to find out what the app is doing. It drives an
instance it started itself, under a different identifier and therefore a
different database, so it can never observe the app a bug is in.
`workspace_snapshot` carries `screen`, the window's own account of what is on
it, and `window.__boite` below reads a terminal back as text. Reach for the
bridge for what only a real pointer can do.

## The browser pane, and what it is allowed to reach

`pane_open` lets an agent put a page beside its own terminal, which is the
point: an agent that has just started a dev server knows what is worth looking
at, and printing a URL and hoping was the only way to say so.

What ships today is an `<iframe>`, and the address in it is the only thing an
agent hands this app that the app then renders in its own window. Three rules
hold it, and they are written down in three places that have to agree:

| Where | What it holds |
|---|---|
| `frame-src` in `tauri.conf.json` | the origins the webview will create a frame for at all |
| `classify_browser_url` in `agent_api.rs` | what the MCP endpoint accepts from an agent |
| `classifyBrowserUrl` in `features/browser/url.ts` | the same rules again, because the identical request also arrives from a remote boite and never passed through that endpoint |

The rules themselves:

- **Loopback over http, anywhere over https.** `localhost`, `127.0.0.1`,
  `[::1]` and `0.0.0.0` are the hosts a dev server answers on, and they are the
  only ones plain `http://` reaches. The four are listed literally in
  `frame-src` and in both validators; a host one accepts and the CSP does not
  is a pane that opens blank, which is exactly what shipped before this.
- **Never the app's own origin.** Tauri serves the window from `*.localhost`
  and the dev build from ports 1420 and 1430. A page framed there is
  same-origin with the webview, which hands it `window.parent` and the IPC
  behind it. Refused outright, with a message the agent can read.
- **Off this machine means asking.** An address that survives the first two and
  is not on this machine goes in front of the user before the frame exists, and
  loads with `allow-same-origin` dropped, so its scripts run in an opaque
  origin with no storage and no cookies.

A URL with a userinfo segment (`http://evil.com@localhost`) is refused in all
cases: it exists only to make the host read as something it is not.

That much is a floor. One ceiling remains, and one was removed:

- **A site can still refuse to be framed.** `X-Frame-Options: DENY` or a
  `frame-ancestors` CSP and the pane stays blank; the component offers "open
  outside" once enough time has passed to rule out slow. Localhost dev servers,
  which is the case this exists for, send neither.
- **An agent can now read and drive the page, on a desktop window.** Not by
  reaching across the origin boundary — the app's own scripts still cannot —
  but from inside it: the main webview is built with an initialization script
  injected into **every frame** (`src-tauri/scripts/pane-driver.js`, attached
  in `lib.rs` where the window is created, which is why the window is built in
  code rather than declared in `tauri.conf.json`). The script wires up only at
  frame depth one (`parent === top`), so a frame nested inside a page never
  answers its parent page's messages; that single guard is what keeps the
  driver from breaking the web's own frame isolation for the sites a pane
  shows.

The pieces, end to end: `browser_snapshot` (elements with stable `uid`s, or
`mode=text` prose, or `mode=diff` since the last look), `browser_click`,
`browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`. A
question rides `Workspace::ask_for_answer` to the webview
(`boite://agent-request` with a `requestId`), `agent-requests.ts` re-checks the
pane and the `drivenBy` mark, `features/browser/driver.ts` posts into the
frame and matches the answer by source, and the `agent_answer` command
resolves the HTTP handler still holding the agent's call. The server host has
no such path — its panes are drawn by browsers and phones with no injected
script — so its `ask_for_answer` refuses with the sentence the agent reads.
`browser_screenshot` is `PrintWindow` cropped to the pane rect
(`commands/capture.rs`), Windows only today, capped at a 1568px long edge.

## window.\_\_boite

A screenshot, a DOM read and a way to run JavaScript reach almost nothing that
matters here. **The terminals render to a WebGL canvas**: to `querySelector`
they are a blank element, so the entire output of every agent Boite runs is
invisible to the one tool that could confirm a change worked, and text in a
picture cannot be grepped. Toasts carry the failure messages and dismiss
themselves before a screenshot is taken. Thread state — which project, which
folder, which session, which worktree — is a label and a coloured dot on screen.

So a dev build puts a read-only inspector on `window.__boite`, returning plain
JSON that `webview_execute_js` hands straight back:

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
resolved to the first. A terminal only exists once its pane has been opened, so
`read` on a thread nobody clicked says so instead of returning nothing.

`import.meta.env.DEV` gates the installer and the toast history, so a release
build never sets the global and never appends to the ring. Keep it read-only: a
debugging aid that can change state is a second way to drive the app, and
nothing tests that one.
