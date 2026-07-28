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

It is unrelated to the todo MCP endpoint described in the README, and never
reuses it: the bridge answers `execute_js`, the todo endpoint answers three
verbs on one table.
