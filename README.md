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
> Pre-1.0, used daily by the author. Bug reports and platform feedback are
> welcome in [Issues](https://github.com/beboite/boite/issues).

## Why

Talking to half a dozen coding agents on the same repo means half a dozen
terminals, and no way to tell at a glance which one is waiting for you. Boite
gives every agent a persistent thread inside a project, reads its working/ready
state from the OSC title, and remembers the command and the last session id.

It is a terminal multiplexer first: everything is a real PTY, nothing is
wrapped, and a blank shell is one keystroke away.

## Features

- **Projects and threads.** A sidebar of projects, each holding a tree of threads that stay mounted across tab switches.
- **Status at a glance.** A per-thread dot read from the agent's own OSC title: working, ready, error.
- **A worktree per thread.** Every agent works in its own detached git worktree, so two of them on the same repo never write to the same files.
- **Session resume.** Boite reads each tool's session store to find the conversation that belongs to the thread's directory.
- **Split panes.** Split horizontally or vertically, drag threads between panes, resize with the mouse.
- **Git panel.** Staged/unstaged/conflict sections, commit, fetch/pull/push, branches, auto-fetch and a commit graph. Nested repos are found three levels deep.
- **File explorer and editor.** A CodeMirror 6 editor with syntax highlighting, tabs, and a side-by-side diff from the git panel.
- **Command palette.** `Ctrl+K` over threads, projects, shortcuts and actions.
- **First run.** A two-screen wizard picks the interface language (English or French) and puts the agents it finds on the machine straight into the shortcut bar.
- **Remote workspaces.** Point the desktop app or a phone at a headless `boite-server`; threads survive the client closing.
- **Mobile layout.** Bottom tab bar, pinch-to-resize terminal font, drag-to-scroll, on-demand keyboard.
- **Idle autoclose.** Per-agent rules close threads that have been idle past a timeout.
- **Notifications.** OS notifications on the desktop, Web Push on the PWA.

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

*Live status* is the working/ready dot, read from the OSC title the agent emits.
*Session resume* finds the conversation matching the thread's cwd and passes the
right resume flag. Shortcuts are editable (label, command, icon, color, order),
each preset says whether its binary was found on the machine, and any custom
command can be added.

## Another provider, another model (fastpick)

An agent does not have to run on its vendor's endpoint. If
[fastpick](https://github.com/beboite/fastpick) is on the machine that runs the
threads, a menu appears next to the shortcut bar: pick an agent, an endpoint,
a model, and the thread starts there. Effort level and system prompt files are
offered where the agent takes them.

Boite never touches a credential. It asks fastpick what the choices are and
launches it with the three answers; the key files, the local proxy some
endpoints need and the machine others have to wake all stay on fastpick's side,
read at spawn time on the machine that spawns. On a remote boite that machine is
the server, so a picker drawn on a phone describes the server's endpoints and
the phone never sees a key.

The thread that comes back is the agent's, not fastpick's: it carries the
agent's icon, and live status, session resume and the todo endpoint all work as
they do for a thread launched directly. Reopening the app replays the same
combination rather than reopening a menu.

Because the icon stays the agent's, it is tinted with what is actually
answering: yellow for a Claude served by someone else, white for a GPT, green
for a model running on that machine, and the stock endpoint left alone. The
colours come from the terminal palette, and the whole behaviour is one toggle
in Appearance.

Claude Code gets the same colour on the inside: it paints its prompt bar from
`/color`, so boite passes that command as the launch prompt and the terminal
agrees with the sidebar. It is decided when the thread starts, since a process
already running cannot be repainted from outside.

The Fastpick tab in the settings installs and removes it, both as a thread you
can watch, and removing it leaves the config where it is: that is where the
providers and the paths to the key files are declared. The menu is hidden when
fastpick is not installed, and nothing else changes.

## A worktree per thread

Every agent thread opens in its own detached git worktree instead of sharing the
project folder, so two agents on the same repo never write to the same working
tree. Detached means nothing is named: no branch appears until the agent claims
one through the MCP door below.

`node_modules`, `target`, `.venv` and `vendor` are linked to the main checkout
rather than copied, a junction on Windows and a symlink elsewhere, because a
worktree would otherwise cost a full install and a full recompile. The price is
that an agent running `bun install` writes into your own directory, and two
concurrent `cargo build` runs serialize on one `target` lock.

A blank terminal and a repo with uncommitted changes both stay in the project
folder, and the choice is made when the thread is created, so a restored thread
stays where you left it. Closing a thread removes its worktree but never forces:
it refuses on uncommitted files, untracked ones included, and on commits that no
local branch contains.

## Threads with no project

You do not have to open a project to open a terminal. **Scratch** runs in your
home folder and gets no worktree — it is where an idea gets talked through
before it has earned a repository. When it has, the agent calls `project_create`
and the conversation moves into it.

It is not a row you keep. Launch a shortcut while you are on no project — click
the empty space under the sidebar to get there — and the thread starts in
Scratch. To get there without leaving the project you are on, right-click a
shortcut and pick *Launch in Scratch*, or shift-click it. Scratch appears at the
bottom of the sidebar while it holds threads, and goes away again when the last
one leaves.

A thread moves by hand too: drag its card onto another project, or use *Move to*
in its context menu. Same machinery either way — the PTY goes down, the
transcript follows so `--resume` still finds the conversation, and the thread
comes back up over there. A worktree still holding uncommitted work is left
behind rather than deleted, and the agent is told where it went.

## Platform support

| Platform | Desktop app                | Notes                                            |
| -------- | -------------------------- | ------------------------------------------------ |
| Windows  | ✅ NSIS + MSI              | Primary development target                        |
| Linux    | ✅ deb + AppImage          | Tested on Ubuntu 22.04+ / Fedora 39+, GNOME & KDE |
| macOS    | 🧪 builds, needs testing   | Compiles and runs; not exercised daily            |
| Android  | ✅ via PWA / TWA           | Installs from `boite-server`, see [`mobile/`](mobile/README.md) |

Two Linux caveats: the window is frameless and transparent, so a tiling WM with
no compositor shows an opaque rectangle without shadows, and if xterm's WebGL
renderer can't initialize the terminal falls back to the DOM renderer on its
own.

## Install

Grab the build for your OS from
[Releases](https://github.com/beboite/boite/releases):

- **Windows**: NSIS installer (per-user, no admin prompt)
- **Linux**: deb, rpm or AppImage
- **macOS**: dmg (unsigned; run `xattr -cr /Applications/Boite.app` once if
  Gatekeeper complains)

## Updates

Boite checks for an update shortly after launch and every six hours after that,
downloads in the background, and offers a **Restart to update** button in the
titlebar. Settings → General has the version, the download progress and a manual
check. Every payload carries a minisign signature verified against a public key
compiled into the binary.

Applying an update ends the process, and a local PTY dies with it. Boite asks
first, stops the running threads itself, and starts them again on the other
side; an agent that captured a session comes back on the same conversation.
Threads on a remote `boite-server` are untouched.

AppImage is the only self-updating Linux format. deb and rpm installs are
updated by your package manager.

## Privacy and data

Boite has no telemetry and no account. Its only unprompted network call is the
update check above, which sends nothing but the request itself; every other
connection is to a remote workspace you configured.

Data lives next to the app config, never in the cloud:

| OS      | Path                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\com.boite.desktop\boite.db`            |
| Linux   | `~/.local/share/com.boite.desktop/boite.db`       |
| macOS   | `~/Library/Application Support/com.boite.desktop/` |

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
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in the terminal   |
| `Ctrl+B`               | Toggle sidebar                          |
| `Ctrl+,`               | Settings                                |
| `Ctrl+S`               | Save the open editor buffer             |
| `Ctrl+Enter`           | Commit (git panel)                      |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | UI scale up / down / reset      |

On macOS, `Cmd` replaces `Ctrl` and only `Cmd+K` opens the palette; `Ctrl+K`
stays with the shell's readline kill-line.

## Remote and mobile

`boite-server` ([`crates/boite-server`](crates/boite-server/README.md)) runs the
PTY/git/fs core headless and serves the same SvelteKit SPA as an installable
PWA. The desktop app reaches it over a single multiplexed WebSocket; a phone
installs it straight from the browser. That README covers Docker, tokens and
TLS/Tailscale setup.

A saved server connection, *a boite*, carries a name and a status color, both
stored server-side and synced live to every connected device. The connection
outline around the window takes that color. One connection is active at a time.

Every context menu opens on a long press as well as a right-click, so a phone
reaches the same actions the desktop does: shortcuts and shells in the launch
sheet, projects and threads in the sidebar, files in the explorer.

For a native Android install, [`mobile/`](mobile/README.md) holds a Bubblewrap
TWA wrapper that packages the PWA as an `.aab`/`.apk`.

## Agent access (MCP)

Ten tools, in three halves.

`todo_list`, `todo_add` and `todo_claim` reach the right-hand **Todo** tab,
which keeps a list of cards per project. An agent can read that list, append to
it and report an item finished, but never tick one off: claiming moves an item
to *awaiting confirmation* and only you confirm it.

A card is a one-line title and an optional description. Click one to open it and
read or edit the description; drag one to move it in the list. The split exists
because an agent handed a single text field writes a paragraph into it, and the
panel is one column wide.

`worktree_status`, `worktree_branch` and `worktree_reserve` cover the worktree
the thread runs in. An agent that has produced something worth keeping names a
branch for it; until then the worktree stays detached and leaves no trace.

`projects_list`, `thread_move`, `project_create` and `thread_spawn` cover where
the work happens. `thread_move` takes the terminal into another project: Boite
kills the process, carries the transcript to the new folder so `--resume` still
finds it, opens a worktree there and brings the agent back up with the
conversation intact. `project_create` does the same for a conversation that has
no project yet, making the folder and running `git init` first. `thread_spawn`
opens a second agent terminal, here or elsewhere, for work that should run in
parallel in its own worktree.

Those three answer before they finish, and that is not a shortcut: two of them
kill the process that called them. A thread cannot change project while its PTY
is alive, so the reply is written while the agent is still there to read a
refusal — an unknown project, an ambiguous name — and the work happens after it
has gone. A new project folder is the one thing the endpoint creates outside the
registered roots, so it is fenced: under your home folder or beside a project
you already have, and never on top of files that are already there.

Answers come back in TOON rather than JSON, because every one of them is read in
a context window:

```
todos(2):
  id state title note
  1a5f3698 open "opti mcp axi" -
  596ce966 claimed readme done
hint: todo_claim id=<id> note=<what changed>, the user confirms, not you
```

Ids are shortened to the prefix that still tells the list apart, and
`todo_claim` takes either that or the full one.

Boite spawns the terminal, so it stamps `BOITE_MCP_URL`, `BOITE_TOKEN` and
`BOITE_THREAD_ID` into the child's environment, and resolves the project from
the thread id. An agent reaches its own project and no other with nothing to
configure; one started outside Boite has no token at all. The endpoint lives
on `127.0.0.1` with an ephemeral port, in both the desktop app and
`boite-server`.

The `boite-mcp` shim ships inside the app, next to the Boite binary. Point your
agent at it. On macOS:

```json
{
  "mcpServers": {
    "boite": { "command": "/Applications/Boite.app/Contents/MacOS/boite-mcp" }
  }
}
```

On Windows and Linux it sits beside the installed `boite` executable; running
from source, use `target/release/boite-mcp` after `bun run build:sidecar`. No
`env` block is needed, the shim inherits the terminal's. Launched anywhere else
it exits rather than starting unauthenticated.

It is spawned once per agent terminal, so it carries nothing it does not need:
`serde_json` and a hundred lines of HTTP/1.1 over a loopback socket, 380 KB
altogether. No async runtime, and no proxy handling to send `127.0.0.1` through
an `ALL_PROXY` that happens to be set.

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

[`docs/development.md`](docs/development.md) covers running a dev window beside
a release install, and [`docs/releasing.md`](docs/releasing.md) covers cutting a
release.

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
    fastpick todo devtools setup
  shared/                 # reusable components, brand icons, utils
  storage/                # DB facade
crates/
  boite-core/             # portable PTY / git / fs / session core
    pty.rs status.rs session.rs git.rs explorer.rs editor.rs project.rs fastpick.rs
  boite-server/           # headless axum server, serves the SPA as a PWA
src-tauri/                # thin Tauri wrapper over boite-core
mobile/                   # Bubblewrap TWA wrapper for the Android build
```

## Contributing

Issues and pull requests are welcome. Follow the vertical-slice layout above,
add new persistence as an append-only migration (never edit a shipped one), and
run the checks in [`AGENTS.md`](AGENTS.md) before pushing.

## License

[MIT](LICENSE).
