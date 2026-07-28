<h1 align="center">Boite</h1>
<p align="center">A lightweight multi-agent terminal multiplexer. Run Claude Code, Codex, Opencode, Cursor, Antigravity, Copilot, Grok and Hermes side by side, grouped by project.</p>

<p align="center">
  <img src="./static/icons/icon-512.png" alt="Boite logo" width="140" />
</p>

<p align="center">
  <a href="https://github.com/beboite/boite/releases"><img src="https://img.shields.io/github/v/release/beboite/boite?display_name=tag" alt="Release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/beboite/boite" alt="License" /></a>
  <a href="https://github.com/beboite/boite/stargazers"><img src="https://img.shields.io/github/stars/beboite/boite" alt="Stars" /></a>
  <a href="https://github.com/beboite/boite/issues"><img src="https://img.shields.io/github/issues/beboite/boite" alt="Issues" /></a>
  <a href="#platform-support"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android-0078D6" alt="Platform" /></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri" alt="Tauri" /></a>
  <a href="https://svelte.dev/"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte" alt="Svelte" /></a>
</p>

> [!NOTE]
> Pre-1.0, used daily by the author. The feature surface is small and focused on
> purpose. Bug reports and platform feedback are welcome in
> [Issues](https://github.com/beboite/boite/issues).

## Why

Talking to half a dozen coding agents on the same repo means half a dozen
terminals, and no way to tell at a glance which one is waiting for you. Boite
gives every agent a persistent thread inside a project, reads its working/ready
state from the OSC title, and remembers the command plus the last session id so
you can hop back into a conversation with one click.

It is a terminal multiplexer first: everything is a real PTY, nothing is
wrapped, and a blank shell is one keystroke away.

## Features

- **Projects and threads.** A sidebar of projects (drag to reorder, custom
  logo, git remote detection) each holding a tree of threads. Terminals stay
  mounted across tab switches; a PTY dies when the thread is closed, not when a
  component unmounts.
- **Status at a glance.** A per-thread dot driven by the agent's own OSC title:
  amber pulsing while it works, green when it is ready for you, red on error or
  a non-zero exit.
- **Session resume.** Boite reads each tool's own session store (read-only) to
  find the conversation that belongs to the current working directory, so
  `claude --resume`, `codex resume` and friends land on the right one.
- **Split panes.** Split any thread horizontally or vertically, drag threads
  between panes, resize with the mouse, cycle with `Ctrl+Alt+Arrow`.
- **Git panel.** Status with staged/unstaged/conflict sections, stage,
  unstage, discard, commit, fetch/pull/push, auto-fetch on a timer, and a
  commit graph. A folder that isn't a repo is scanned up to three levels deep,
  so a monorepo's nested repos are one click away.
- **File explorer and editor.** Browse the project tree and open files in a
  CodeMirror 6 editor with syntax highlighting, tabs and a side-by-side diff
  (HEAD vs index vs working tree) straight from the git panel.
- **Command palette.** `Ctrl+K` (or `Ctrl+Shift+P`) over threads, projects,
  shortcuts and actions.
- **Remote workspaces.** Point the desktop app (or a phone) at a headless
  `boite-server`. Threads live on the server and survive the client closing;
  reattaching replays the scrollback.
- **Mobile layout.** A phone-shaped UI with a bottom tab bar, pinch-to-resize
  terminal font, drag-to-scroll, and an on-demand keyboard button so tapping the
  terminal doesn't pop the soft keyboard.
- **Idle autoclose.** Per-agent rules close threads that have been idle past a
  timeout, so a day of experiments doesn't leave twenty dead PTYs behind.
- **Notifications.** OS notifications on the desktop, Web Push on the PWA, so a
  finished agent reaches you when the window isn't focused.

## Supported agents

Every agent ships as a shortcut with a brand icon. Boite runs whatever is on
your `PATH`, so anything not listed still works from a blank shell; it just
won't get status or resume detection.

| Agent          | Command                | Live status | Session resume |
| -------------- | ---------------------- | ----------- | -------------- |
| Claude Code    | `claude`               | ✅          | ✅             |
| Codex          | `codex --no-alt-screen`| ✅          | ✅             |
| Opencode       | `opencode`             | ✅          | ✅             |
| Cursor Agent   | `cursor-agent`         | ✅          | ✅             |
| Antigravity    | `agy`                  | ✅          | ✅             |
| GitHub Copilot | `gh copilot`           | ✅          | ✅             |
| Grok           | `grok`                 | ✅          | ✅             |
| Hermes         | `hermes`               | ✅          | ✅             |
| Plain shell    | your default shell     | n/a         | n/a            |

- **Live status**: the working/ready dot, read from the OSC title the agent
  emits.
- **Session resume**: Boite finds the conversation matching the thread's cwd in
  the tool's own store and passes the right resume flag.

Shortcuts are editable: label, command, icon and color, reorderable, and any
custom command can be added.

## Platform support

| Platform | Desktop app                | Notes                                            |
| -------- | -------------------------- | ------------------------------------------------ |
| Windows  | ✅ NSIS + MSI              | Primary development target                        |
| Linux    | ✅ deb + AppImage          | Tested on Ubuntu 22.04+ / Fedora 39+, GNOME & KDE |
| macOS    | 🧪 builds, needs testing   | Compiles and runs; not exercised daily            |
| Android  | ✅ via PWA / TWA           | Installs from `boite-server`, see [`mobile/`](mobile/README.md) |

The window is frameless and transparent, so a tiling WM with no compositor will
show an opaque rectangle without system shadows. If xterm's WebGL renderer
can't initialize (older WebKitGTK, software rendering), the terminal falls back
to the DOM renderer with no user action needed.

## Install

Grab the build for your OS from
[Releases](https://github.com/beboite/boite/releases):

- **Windows**: NSIS installer (per-user, no admin prompt)
- **Linux**: deb, rpm or AppImage
- **macOS**: dmg (unsigned; run `xattr -cr /Applications/Boite.app` once if
  Gatekeeper complains)

### Updates

Boite updates itself. It asks the releases endpoint for a manifest shortly after
launch and every six hours after that; when a newer version exists it downloads
in the background and the titlebar offers a **Restart to update** button. The
click only swaps the files in and relaunches; the bytes are already on disk.
Settings → General shows the current version, the download progress and a manual
check.

Applying an update ends the process, and a local PTY dies with it. Boite asks
before it does that, notes which threads were running, stops them itself instead
of letting the installer yank them, and starts them again on the other side. An
agent that captured a session comes back on the same conversation (`--resume`);
anything else re-runs its command. Threads on a remote `boite-server` are not
affected at all: their PTYs live on the server, which the restart never touches.

Every payload carries a minisign signature that is verified against a public key
compiled into the binary. A payload that fails verification is discarded, so the
release host is not a trusted input.

AppImage is the only self-updating Linux format; deb and rpm installs are
updated by your package manager.

Data lives next to the app config, never in the cloud:

| OS      | Path                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\com.boite.desktop\boite.db`            |
| Linux   | `~/.local/share/com.boite.desktop/boite.db`       |
| macOS   | `~/Library/Application Support/com.boite.desktop/` |

Installs from 1.0.0 and earlier used `dev.boite.app`, the scaffolding
placeholder. The first start after upgrading moves the whole directory across
and logs what it did under `backend.appdata`. If both directories somehow hold
a database, the new one wins and the old is left untouched rather than guessed
at; nothing is ever deleted that was not first moved.

Boite has no telemetry and no account. Its only unprompted network call is the
update check described above, which sends nothing but the request itself; every
other connection is to a remote workspace you explicitly configured.

## Keyboard

| Shortcut               | Action                                  |
| ---------------------- | --------------------------------------- |
| `Ctrl+T`               | New shell in the current project        |
| `Ctrl+Shift+T`         | Restore the last closed thread          |
| `Ctrl+W`               | Close the active thread / editor tab    |
| `Ctrl+Tab`             | Cycle threads (`Ctrl+Shift+Tab` back)   |
| `Ctrl+1..9`            | Jump to thread N                        |
| `Ctrl+K` / `Ctrl+Shift+P` | Command palette                      |
| `Ctrl+Alt+Arrow`       | Cycle panes inside the active split     |
| `Ctrl+B`               | Toggle sidebar                          |
| `Ctrl+,`               | Settings                                |
| `Ctrl+S`               | Save the open editor buffer             |
| `Ctrl+Enter`           | Commit (git panel)                      |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | UI scale up / down / reset      |

On macOS, `Cmd` replaces `Ctrl` and only `Cmd+K` opens the palette; `Ctrl+K`
stays with the shell's readline kill-line.

## Remote & mobile

`boite-server` ([`crates/boite-server`](crates/boite-server/README.md)) runs the
PTY/git/fs core headless and serves the same SvelteKit SPA as an installable
PWA. The desktop app reaches it over a single multiplexed WebSocket; a phone
installs it straight from the browser. That README covers Docker, tokens and
TLS/Tailscale setup.

Each saved boite carries a **name and a status color**, stored server-side and
synced to every connected device: rename or recolor from one device and the
others update live. The connection outline around the window takes that color,
so it is obvious which boite you are driving. One connection is active at a
time; switching reconnects.

For a native Android install, [`mobile/`](mobile/README.md) holds a Bubblewrap
TWA wrapper that packages the PWA as an `.aab`/`.apk` (signing secrets stay out
of the repo).

## Build from source

```bash
bun install
bun run tauri dev      # full app with hot reload
bun run tauri build    # release bundles for the host platform
```

Linux system dependencies:

```bash
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
```

Pick your bundles explicitly to skip the ones you don't need:

```bash
bun run tauri build --bundles nsis          # Windows installer only
bun run tauri build --bundles deb,appimage  # Linux
bun run tauri build --no-bundle             # raw executable, fastest
```

This is a Cargo workspace, so bundles land in the repo-root
`target/release/bundle/`, not `src-tauri/target/`.

Checks that must pass before a commit:

```bash
bun run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

### Dev mode side by side

A release instance already running holds the single-instance lock, so
`tauri dev` refuses to start. For a dev window next to it:

```bash
bun run dev:isolated
```

That launches a separate **"Boite Dev"** window on port `1430` under the
`dev.boite.dev` identifier, with its own SQLite file and an empty project list.

It also enables the `mcp-bridge` feature so an agent can drive that window
(screenshots, DOM reads, JS evaluation). **The bridge is a dev-only tool**: an
unauthenticated WebSocket server, deliberately bound to `127.0.0.1`. The
plugin's own default is `0.0.0.0`, and JS evaluated in the webview reaches the
IPC that spawns PTYs. Keep it on loopback and never enable the feature for a
build you hand to anyone. Plain `bun run tauri dev` leaves it out of the binary
entirely.

The agent side of that bridge is `@hypothesi/tauri-mcp-server`, pinned to the
same version as the crate — the npm package and the plugin ship as one pair, and
its binary is named `mcp-server-tauri`, which is not a package name and resolves
to nothing when handed to `npx`:

```json
{
  "mcpServers": {
    "boite-dev": { "command": "npx", "args": ["-y", "@hypothesi/tauri-mcp-server@0.12.0"] }
  }
}
```

It declares twenty tools, around 26 KB of schema in every session that loads it,
so it is worth registering only while actually driving the dev window.

## Agent todo access (MCP)

The right-hand **Todo** tab keeps a checklist per project. An agent running in a
Boite terminal can read and append to that list, and report an item finished —
but never tick one off.

Boite spawns the terminal, so it stamps `BOITE_MCP_URL`, `BOITE_TOKEN` and
`BOITE_THREAD_ID` into the child's environment. The agent presents that thread
id; the project is resolved from it. So an agent reaches its own project's list
and no other, with nothing to configure, and an agent started outside Boite has
no token at all.

The `boite-mcp` shim ships inside the app, next to the Boite binary. Point your
agent at it — on macOS:

```json
{
  "mcpServers": {
    "boite": { "command": "/Applications/Boite.app/Contents/MacOS/boite-mcp" }
  }
}
```

On Windows and Linux it sits beside the installed `boite` executable. Running
from source, use `target/release/boite-mcp` after `bun run build:sidecar`.

No `env` block: the shim inherits the terminal's. Launched anywhere else it
exits rather than starting unauthenticated.

Six tools: `todo_list`, `todo_add`, `todo_claim`, and `worktree_status`,
`worktree_branch`, `worktree_reserve` for the checkout the terminal runs in.
Claiming moves an item to *awaiting confirmation*, with a one-line summary; only
you can confirm it. That split is enforced in SQL — the update fires only on a
row still open, in the caller's own project — because a model that can close its
own tickets will, and the list would stop recording verified work.

Answers come back in TOON rather than JSON, because every one of them is read in
a context window:

```
todos(2):
  id state text note
  1a5f3698 open "opti mcp axi" -
  596ce966 claimed readme done
hint: todo_claim id=<id> note=<what changed> — the user confirms, not you
```

Ids are shortened to the prefix that still tells the list apart, and `todo_claim`
takes either that or the full one.

The endpoint lives on `127.0.0.1` with an ephemeral port, in both the desktop
app and `boite-server`. It is not the dev `mcp-bridge` and never reuses it: that
one answers `execute_js`, this one answers three verbs on one table.

`scripts/build-sidecar.mjs` builds it before every bundle and names it for the
triple being built *for* — the macOS release jobs cross-compile, so the host
triple would be the wrong answer there and the bundle would fail outright.

## Releasing

Releases are built by `.github/workflows/release.yml` on a pushed `v*` tag, one
job per platform. It signs the update payloads and opens a **draft** release:
clients see nothing until you publish it.

Cutting a release needs no key on your machine. The signing keypair already
exists: its public half is in `plugins.updater.pubkey`, its private half is the
`TAURI_SIGNING_PRIVATE_KEY` repository secret (with
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Anyone who can push a tag can ship a
signed release without ever seeing it.

That keypair is permanent. There is one for the whole project, not one per
maintainer: the public key is compiled into every binary in the wild, so a
second key would orphan every existing install. GitHub secrets cannot be read
back, and there is no revocation: losing the private key ends updates forever,
and leaking it cannot be undone. An offline copy is held outside GitHub, so the
secret is no longer the only one. Never sign locally.

Cutting a release: bump the version in the five places that carry it
(`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`crates/boite-core/Cargo.toml`, `crates/boite-server/Cargo.toml`), commit, then
tag `vX.Y.Z` and push the tag.

## Stack

- **Desktop shell**: Tauri 2 with a frameless window, custom titlebar, strict CSP,
  explicit capabilities (no `core:default` blanket, no `fs:default`).
- **Frontend**: SvelteKit (`adapter-static`, SSR off), Svelte 5 runes,
  Tailwind 4, xterm 6 with the WebGL renderer, CodeMirror 6 for the editor.
- **Core**: Rust. `portable-pty` for PTYs, `vte` for OSC parsing, `which` for
  PATH resolution, `rusqlite` (read-only) to read each agent's session store.
- **Server**: axum, one multiplexed WebSocket, gzip scrollback replay,
  Web Push.
- **Build**: Vite (aliased to `rolldown-vite`), Bun for packages, `tsgo` for
  fast typechecks.

## Project structure

```text
src/lib/
  app/                    # shell controllers, keyboard, workspace orchestration
  backend/                # transport abstraction: TauriBackend | RemoteBackend
  features/               # vertical slices, each owning components + store
    terminal git explorer editor panes palette
    project thread shortcut settings workspace mobile push notifications updater
  shared/                 # reusable components, brand icons, utils
  storage/                # DB facade
crates/
  boite-core/             # portable PTY / git / fs / session core
    pty.rs status.rs session.rs git.rs explorer.rs editor.rs project.rs
  boite-server/           # headless axum server, serves the SPA as a PWA
src-tauri/                # thin Tauri wrapper over boite-core
mobile/                   # Bubblewrap TWA wrapper for the Android build
```

## Contributing

Issues and pull requests are welcome. Keep `bun run check` and
`cargo clippy -- -D warnings` clean, follow the vertical-slice layout above,
and add new persistence as an append-only migration (never edit a shipped one).

## License

[MIT](LICENSE).
