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
never reuses it: the bridge answers `execute_js`, that one answers six verbs
scoped to the calling thread.
