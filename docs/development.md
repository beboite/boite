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
never reuses it: the bridge answers `execute_js`, that one answers ten verbs
scoped to the calling thread.

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
