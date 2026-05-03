# Boite

Lightweight multi-agent terminal multiplexer. Run Claude Code, Codex,
Opencode, Cursor, Gemini, GitHub Copilot, and plain shells side-by-side
under one frameless window. Each in its own PTY, grouped by project.

Built on Tauri 2 (Rust backend, frameless window), SvelteKit (SPA, Svelte 5
runes, Tailwind 4), and xterm 6 with the WebGL renderer.

## Why

Switching between half a dozen terminals to talk to half a dozen agents on
the same repo gets old fast. Boite gives each agent a persistent thread
inside a project, surfaces their working/ready status from the OSC title,
and saves the cmd + last session id so you can hop back into a Claude
conversation with one click.

## Status

Pre-1.0. Used daily by the author. Ship-ready for personal use; feature
surface is small and focused.

## Stack

- **Desktop shell**: Tauri 2 (custom titlebar, strict CSP, explicit
  capabilities, no `core:default` blanket).
- **Frontend**: SvelteKit (`adapter-static`, SSR off), Svelte 5 runes,
  Tailwind 4, xterm 6 + addons (fit, webgl, weblinks, unicode11).
- **Backend**: Rust. `portable-pty` for the PTY, `vte` for OSC parsing,
  `tauri-plugin-sql` (sqlx) for the project/thread/settings store, `which`
  for PATH resolution, `rusqlite` (read-only) for poking each agent's
  session DB to capture the resume id.
- **Build**: Vite, Bun for package management,
  `@typescript/native-preview` (`tsgo`) for fast typecheck.

## Features

- Per-project sidebar with drag-to-reorder, custom logo, and a thread tree.
- Per-thread status dot driven by the OSC title: yellow when the agent is
  working, green when ready, red on error/non-zero exit.
- Shortcut bar with brand icons (simple-icons) for Claude, Codex, Opencode,
  Cursor, Gemini, Copilot, and a blank shell.
- Auto-detect of running agents in the same cwd via each tool's own
  session store, so `claude --resume`, `codex resume`, etc. land on the
  right conversation.
- Keyboard: `Ctrl+T` new shell, `Ctrl+W` close thread, `Ctrl+Tab` cycle,
  `Ctrl+1..9` jump to thread N, `Ctrl+B` toggle sidebar, `Ctrl+,`
  settings, `Ctrl++/-/0` UI scale.
- Window state, sidebar width, default shell, UI scale, and project/thread
  order persist between sessions.

## Build & dev

```bash
bun install
bun run tauri dev    # full app with hot reload
bun run tauri build  # release exe + msi + nsis bundles

# checks before committing
bun run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Data lives at `$APPDATA/dev.boite.app/boite.db`.

## License

MIT.
