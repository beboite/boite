# Boite

Lightweight multi-agent terminal multiplexer. Run Claude Code, Codex,
Opencode, Cursor, Antigravity, GitHub Copilot, and plain shells side-by-side
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
  Cursor, Antigravity, Copilot, and a blank shell.
- Auto-detect of running agents in the same cwd via each tool's own
  session store, so `claude --resume`, `codex resume`, etc. land on the
  right conversation.
- Keyboard: `Ctrl+T` new shell, `Ctrl+W` close thread, `Ctrl+Tab` cycle,
  `Ctrl+1..9` jump to thread N, `Ctrl+B` toggle sidebar, `Ctrl+,`
  settings, `Ctrl++/-/0` UI scale.
- Window state, sidebar width, default shell, UI scale, and project/thread
  order persist between sessions.
- **Remote workspaces**: connect the desktop app (or a phone PWA) to one or
  more headless `boite-server` instances. Threads live on the server and
  survive the client closing; reattaching replays the scrollback. Switch
  between saved boites from the workspace picker in the titlebar.
- **Mobile layout**: a phone-shaped UI (bottom tab bar, full-screen pages, no
  sidebar) toggled in settings, defaulting on for touch devices. Pinch to
  resize the terminal font, drag to scroll the scrollback, and an on-demand
  keyboard button so tapping the terminal doesn't pop the soft keyboard.

## Remote & mobile

`boite-server` (in `crates/boite-server`) runs the PTY/git/fs core headless
and serves the same SvelteKit SPA as an installable PWA. The desktop app
reaches it over one WebSocket; a phone installs it from the browser. See
[crates/boite-server/README.md](crates/boite-server/README.md) for Docker,
tokens, and TLS/Tailscale setup.

Each saved boite carries a **name and a status color**, stored on the server
and synced to every connected device: rename or recolor it from any device
and the rest update live. The connection outline around the window takes that
color, so it is obvious which boite you are driving. The workspace picker
keeps one connection active at a time (switching reconnects to the new boite).

## Build & dev

```bash
bun install
bun run tauri dev    # full app with hot reload
bun run tauri build  # release bundles (per-platform default targets)

# checks before committing
bun run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

### Linux

Tested on Ubuntu 22.04+ / Fedora 39+ with GNOME (Wayland) and KDE. Other DEs
work as long as a compositor is running — the window uses `transparent: true`
and `decorations: false`, so a tiling WM without compositing will show an
opaque rectangle with no system shadows.

System dependencies (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
```

Then build the bundles you want:

```bash
bun run tauri build --bundles deb,appimage
# output: src-tauri/target/release/bundle/{deb,appimage}/
```

If xterm's WebGL renderer fails to initialize (older WebKitGTK, software
rendering), the terminal automatically falls back to the DOM renderer with
no user action required.

### Windows

`bun run tauri build` produces both MSI and NSIS installers. For the NSIS
installer only (faster):

```bash
bun run tauri build --bundles nsis
```

Data lives at `$APPDATA/dev.boite.app/boite.db` on Windows and
`~/.local/share/dev.boite.app/boite.db` on Linux.

## License

MIT.
