# Boite 2

Boite 2 is a chat-first manager for coding agents: one conversation per task,
each agent driven through its own protocol rather than through a terminal. A
single Bun process, the core, hosts every thread and every agent process, so
dozens of conversations stay open without a process each and every one of them
is traced. The desktop shell and a phone on the same network are both clients of
that core, over an authenticated WebSocket.

## Stack

- Bun 1.4.2 for the core, the tests and the benches.
- Svelte 5.57 and Vite 8.2 for the UI, plain CSS with the design tokens in
  `app.css`, no component library.
- Tauri 2.11 for the desktop shell, WebView2 on Windows.
- TypeScript 7 across the workspace; the UI keeps a TypeScript 6 install beside
  it because `svelte-check` refuses to start without one.
- Claude Agent SDK 0.3.263 and Agent Client Protocol SDK 1.4.0, both loaded on
  first use.

## Run it

```bash
bun install
bun run dev:core            # the host on 127.0.0.1, prints the pairing URL
bun run dev:ui              # vite dev server for the UI; add ?fake=1 for the in-memory client
bun run check               # tsc on contracts and core, svelte-check on the UI
bun run test                # bun test in packages/core, vitest in packages/ui
bun run e2e                 # core over WS, UI in a hidden Chromium, the shell over CDP
```

The core takes `--port`, `--host`, `--lan` and `--data-dir`. Pass them to the
entry point directly when you need one:

```bash
bun packages/core/src/main.ts --lan --data-dir /tmp/boite-scratch
```

## Build it

```bash
bun run build:ui            # packages/ui/dist, served by the core and bundled in the shell
bun run build:core          # packages/core/dist: main.js, the two workers, the lazy SDK chunk
bun run build:core:exe      # packages/core/dist/boite-core.exe, the shell's sidecar
bun run stage:core          # compile the core and put it where the bundler and the e2e look
bun run build:shell         # the NSIS installer, sidecar and UI included
```

The installer is per user and asks for no elevation. It puts
`boite-shell.exe`, the `boite-core.exe` sidecar, `jobs-worker.js`,
`guard-worker.js` and `ui/` under `%LOCALAPPDATA%\Boite`. Step by step:
[docs/releasing.md](docs/releasing.md).

## Layout

```
packages/contracts   the wire: every RPC method, event and shared type, no runtime
packages/core        the host: server, journal, threads, scheduler, drivers, providers, accounts, trace
packages/ui          the Svelte app, one build for the shell and the phone
apps/shell           the Tauri client: window, tray, starts the local core
tests/e2e            core over WS, UI in a browser, shell over CDP
bench                measurements against Boite Legacy
```

## Docs

- [AGENTS.md](AGENTS.md): the rules, the vocabulary, and why each mechanism is
  shaped the way it is. Read it before changing anything here.
- [docs/README.md](docs/README.md): the index, one line per file.
- [docs/development.md](docs/development.md): running it, the fake client, the
  tests, the captures.
- [docs/providers.md](docs/providers.md): the descriptor format and the shipped
  providers.
- [docs/accounts.md](docs/accounts.md): isolation directories and logins.
- [docs/phone.md](docs/phone.md): pairing, the PWA, what is cached.
- [docs/trace.md](docs/trace.md): Job Objects, the trace, the caps, the guards.
- [docs/releasing.md](docs/releasing.md): from a clean tree to the installer.

## Status

Alpha, version 2.0.0-alpha.1. The core, the UI, the shell, the installer and
five drivers (Claude, ACP, Codex, pi and the echo fake used by the tests) all
run. The plugin host is not written, and the trace outside Windows polls a
process group instead of reading exact process events.
