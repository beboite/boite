<h1 align="center">Boite</h1>
<p align="center">A lightweight multi-agent terminal multiplexer. Run Claude Code, Codex, Opencode, Cursor, Antigravity, Copilot, Grok, Hermes, Pi and Muse Code side by side, grouped by project.</p>

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

## Why

Half a dozen coding agents on one repo means half a dozen terminals, and no way
to tell at a glance which one is waiting for you. Boite gives every agent a
persistent thread inside a project, measures its working/ready state from what
the agent declares and from the terminal's bottom rows, and remembers the
command and the last session id.

It is a terminal multiplexer first: everything is a real PTY, nothing is
wrapped, and a blank shell is one keystroke away.

## Features

- **Projects and threads.** A sidebar of projects, each a tree of threads that stay mounted across tab switches.
- **Status at a glance.** A per-thread dot, measured every pass rather than latched.
- **Session resume.** Boite reads each tool's session store to find the conversation belonging to the thread's directory.
- **A page per project.** Threads, branch and upstream distance, recent commits, open todos, which thread holds which worktree.
- **Split panes.** Horizontal or vertical, drag threads between panes, resize with the mouse.
- **Git panel.** Staged/unstaged/conflict sections, commit, fetch/pull/push, branches, auto-fetch, commit graph. Nested repos found three levels deep.
- **File explorer and editor.** CodeMirror 6 with syntax highlighting, tabs, and a side-by-side diff from the git panel.
- **Command palette.** `Ctrl+K` over threads, projects, shortcuts and actions. Past two characters it also searches the todos, the journal and what the terminals printed.
- **Idle autoclose** per agent, and **notifications**: OS ones on the desktop, Web Push on the PWA.

A worktree per thread, Scratch, fastpick endpoints, remote workspaces and the
phone layout each get their own section below.

## Supported agents

Every agent ships as a shortcut with a brand icon. Boite runs whatever is on
your `PATH`, so anything not listed still works from a blank shell; it just
won't get status or resume detection.

| Agent          | Command                 | Live status | Resume flag       | Endpoint swap | Prompt bar |
| -------------- | ----------------------- | ----------- | ----------------- | ------------- | ---------- |
| Claude Code    | `claude`                | ✅          | `--resume <id>`   | ✅            | ✅         |
| Codex          | `codex --no-alt-screen` | ✅          | `resume <id>`     | ✅            | ❌         |
| Opencode       | `opencode`              | ✅          | `--session <id>`  | ✅            | ❌         |
| Cursor Agent   | `cursor-agent`          | ✅          | `--resume <id>`   | ❌            | ❌         |
| Antigravity    | `agy`                   | ✅          | `--conversation`  | ❌            | ❌         |
| GitHub Copilot | `gh copilot`            | ✅          | `--resume=<id>`   | ❌            | ❌         |
| Grok           | `grok`                  | ✅          | `--resume <id>`   | ❌            | ❌         |
| Hermes         | `hermes`                | ✅          | `--resume <id>`   | ❌            | ❌         |
| Pi             | `pi`                    | ✅          | `--session <id>`  | ✅            | ❌         |
| Muse Code      | `muse`                  | ✅          | `resume <id>`     | ❌            | ❌         |
| Plain shell    | your default shell      | n/a         | n/a               | n/a           | n/a        |

- **Live status** is the working/ready dot. Claude, Codex and Opencode each
  record what they are doing in a store of their own; the other seven are read
  off the shape of the terminal's bottom rows. Neither source expires, so a
  finished turn reads as finished rather than as the absence of noise.
- **Resume flag** is what Boite appends once it has found the conversation
  matching the thread's cwd. Muse has no Windows build, so its row is read off
  its documented CLI and it has no session detection yet.
- **Endpoint swap** is fastpick pointing the agent at another provider. The four
  marked keep their icon, status and resume through it.
- **Prompt bar** is the model colour painted inside the TUI, which only Claude
  Code exposes a command for.

Shortcuts are editable (label, command, icon, color, order), each preset says
whether its binary was found, and any custom command can be added.

## Installing the agents themselves

The **CLIs** tab installs, updates and removes the agents, on the machine the
threads spawn on — which for a remote boite is the server, not the device drawing
the panel.

| How it arrives | Agents |
| -------------- | ------ |
| Boite downloads the vendor's binary | Claude Code, Codex, Opencode, Cursor Agent, Antigravity, Copilot, Grok, Muse |
| Its own package manager, in a terminal you can read | Pi (`npm`) |
| The vendor's instructions, linked | Hermes |

Everything in the first row is fetched by Boite itself — no Node, no `gh`, no
shell script piped into a shell — which is what makes it work the same on
Windows as on macOS and Linux. Two of those agents get a platform their own
installer does not offer: Muse's launcher is a bash script that refuses anything
but macOS and Linux, while the manifest it reads has carried Windows builds all
along.

What Boite downloads goes to `~/.boite/bin`, a directory it owns and nothing else
writes to, which is on the PATH every thread is spawned with — a fresh install
runs without restarting the app. Nothing lands in `~/.cargo/bin` or
`/usr/local/bin`: an install Boite did is an install Boite can take back. Where a
vendor publishes a digest, the download is checked against it — a manifest, npm's
`dist.integrity`, or the digest GitHub itself records for a release asset; where
none of those exist, HTTPS is the whole story and the panel says so. An agent that publishes no
binary for your platform gets its documentation link instead of a button that
would fail.

Each vendor is asked what it currently publishes, so an agent that is current
says **Up to date** rather than offering an update to the version already on the
machine, and the button reads *Reinstall*. A vendor that cannot be reached simply
leaves the row saying nothing about updates.

Removing one asks a second question: **keep my data**, on by default. Kept, only
the binary goes. Cleared, the CLI's own directories go with it (`~/.claude`,
`~/.codex`, `~/.grok`…), listed with their sizes in the dialog before anything is
deleted — never a path outside your home folder, never a symlink followed, never
a project-local folder.

Installing and removing a CLI are the two capabilities the MCP endpoint
deliberately does not carry. An agent asking for the same things you click is the
rule everywhere else; deleting `~/.claude` is where it stops.

## A worktree per thread

Every agent thread opens in its own detached git worktree instead of sharing the
project folder. Detached means nothing is named: no branch appears until the
agent claims one through the MCP.

- `node_modules`, `target`, `.venv` and `vendor` are linked to the main checkout
  rather than copied (a junction on Windows, a symlink elsewhere), or a worktree
  would cost a full install and a full recompile. The price: `bun install` in a
  thread writes into your directory, and two `cargo build` runs serialize on one
  `target` lock.
- A blank terminal and a repo with uncommitted changes both stay in the project
  folder, decided at creation, so a restored thread stays where you left it.
- Closing a thread removes its worktree but never forces: it refuses on
  uncommitted files, untracked included, and on commits no local branch has.

## Threads with no project

**Scratch** runs in your home folder and gets no worktree: it is where an idea
gets talked through before it has earned a repository. Launch a shortcut with no
project selected (or shift-click one) and the thread starts there; Scratch shows
at the bottom of the sidebar while it holds threads and goes with the last one.
When the idea has earned a folder, the agent calls `project_create` and the
conversation moves into it.

A thread also moves by hand: drag its card onto another project. The PTY goes
down, the transcript follows so `--resume` still finds the conversation, and the
thread comes back up over there. A worktree holding uncommitted work is left
behind rather than deleted.

## Another provider, another model (fastpick)

With [fastpick](https://github.com/beboite/fastpick) on the machine running the
threads, a menu appears beside the shortcut bar: pick an agent, an endpoint and
a model, with effort level and system prompt files where the agent takes them.
What comes back is the agent's thread, not fastpick's: same icon, same live
status, same session resume, replayed on reopen. The icon is tinted with what
actually answers, computed at render, so the Appearance toggle reaches every
thread rather than the next one. The Fastpick tab in the settings installs and
removes it.

Boite never touches a credential. It asks fastpick what the choices are and
launches it with the three answers; key files, local proxies and the machines
some endpoints have to wake all stay on fastpick's side, read on the machine
that spawns. On a remote boite that is the server, so a picker drawn on a phone
describes the server's endpoints and the phone never sees a key.

## Platform support

| Platform | Desktop app                | Notes                                            |
| -------- | -------------------------- | ------------------------------------------------ |
| Windows  | ✅ NSIS + MSI              | Primary development target                        |
| Linux    | 🧪 deb + rpm + AppImage    | Builds and runs, needs testing on more distros    |
| macOS    | ✅ dmg (Intel + Apple Si)  | Used daily by one of the developers               |
| Android  | ✅ via PWA / TWA           | Installs from `boite-server`, see [`mobile/`](mobile/README.md) |

Two Linux caveats: the window is frameless and transparent, so a tiling WM with
no compositor shows an opaque rectangle without shadows, and the terminal falls
back to the DOM renderer if xterm's WebGL one cannot initialize.

## Install

From [Releases](https://github.com/beboite/boite/releases):

- **Windows**: NSIS installer (per-user, no admin prompt)
- **Linux**: deb, rpm or AppImage
- **macOS**: dmg (unsigned; run `xattr -cr /Applications/Boite.app` once if
  Gatekeeper complains)

Boite checks for an update shortly after launch and every six hours after,
downloads in the background and offers **Restart to update** in the titlebar.
Every payload carries a minisign signature verified against a public key
compiled into the binary. Applying one ends the process, so Boite stops the
local threads itself and brings them back on the same conversations; threads on
a remote `boite-server` are untouched. AppImage is the only self-updating Linux
format.

## Privacy and data

No telemetry, no account. The only unprompted network call is the update check,
which sends nothing but the request; every other connection is to a remote
workspace you configured. Data lives next to the app config, never in the cloud:

| OS      | Path                                              |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\com.boite.desktop\boite.db`            |
| Linux   | `~/.local/share/com.boite.desktop/boite.db`       |
| macOS   | `~/Library/Application Support/com.boite.desktop/` |

## Keyboard

| Shortcut               | Action                                  |
| ---------------------- | --------------------------------------- |
| `Ctrl+T`               | New shell here, or in Scratch on no project |
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
PWA. The desktop app reaches it over one multiplexed WebSocket; a phone installs
it from the browser. That README covers Docker, pairing, scopes and TLS.

A saved server connection, *a boite*, carries a name and a status color, stored
server-side and synced live to every device; the outline around the window takes
that color. One connection is active at a time. Every context menu opens on a
long press as well as a right-click. For a native Android install,
[`mobile/`](mobile/README.md) packages the PWA as an `.aab`/`.apk`.

## Agent access (MCP)

Twenty tools, in five groups.

| Group | Tools | What it is for |
|---|---|---|
| Todos | `todo_list`, `todo_add`, `todo_claim` | The project's card list, in the Todo tab. An agent reads it, appends to it and reports an item finished, but never ticks one off: claiming moves a card to *awaiting confirmation*. |
| Worktree | `worktree_status`, `worktree_branch`, `worktree_reserve`, `artifacts_status`, `artifacts_set` | The checkout the thread runs in, and what a new one gets out of yours rather than building from nothing. A project with an opinion writes its own rule to `.boite/artifacts.json`. |
| Where the work happens | `projects_list`, `project_create`, `thread_move`, `thread_spawn`, `thread_wait` | Move the terminal into another project (the transcript follows, so `--resume` still finds it), make a folder for a conversation that has none, open a second agent elsewhere. `thread_spawn` answers with the new thread id; `thread_wait` and `terminal_transcript` take that id. |
| What can be asked | `whereami`, `workspace_snapshot`, `workspace_search`, `workspace_timeline`, `terminal_transcript`, `pane_open` | How an agent answers "what is wrong here" without asking you. `whereami` is this thread, project, worktree and branch. One snapshot carries every project and thread, the terminals with a live child, and `screen`. `pane_open` puts a diff, a file or a dev server beside the agent's own terminal, and takes a `path` for the editor. |
| The browser pane | `browser` | One tool, `action=status\|snapshot\|click\|type\|press\|scroll\|navigate\|reload\|wait_for\|close\|screenshot`. A page an agent opened, read back as rows with stable uids and driven from the same side. |

`thread_move` and `project_create` kill the process that called them, so they
answer before they finish: the reply is written while the agent is still there
to read a refusal. A new project folder is the one thing created outside the
registered roots, so it is fenced to under your home folder or beside an
existing project, never on top of existing files.

Answers come back in TOON rather than JSON, since every one is read in a context
window:

```
todos(2):
  id state title note
  1a5f3698 open "opti mcp axi" -
  596ce966 claimed readme done
hint: todo_claim id=<id> note=<what changed>, the user confirms, not you
```

### How an agent is let in

Boite spawns the terminal, so it mints a keypair for it first: the public half
goes in the database, the private half in a file only that user can read (0600,
beside the database), and `BOITE_MCP_URL`, `BOITE_KEY_FILE` and
`BOITE_THREAD_ID` go into the child's environment. The agent signs each request,
and the project is resolved from the thread it proves it is. Nothing reusable
travels over the socket, one agent cannot speak for another, an identity is
bound once and never replaced, and the endpoint stays on `127.0.0.1` with an
ephemeral port. An agent started outside Boite holds no key and gets in nowhere.
`BOITE_KEY_FILE` is a path rather than the key itself, which would otherwise
show up in the output of any `env` an agent typed and stay in the scrollback.

Agents that receive no environment get in through a credentials file the Todo
panel writes. Its token is derived from the project it names, so editing that id
produces one that no longer verifies, and the grant is narrower: one project's
list, and no way to move a thread, open a terminal elsewhere or create a
project.

The `boite-mcp` shim ships inside the app, beside the Boite binary. Point your
agent at it, no `env` block needed:

```json
{
  "mcpServers": {
    "boite": { "command": "/Applications/Boite.app/Contents/MacOS/boite-mcp" }
  }
}
```

On Windows and Linux it sits beside the installed `boite` executable; from
source, `target/release/boite-mcp` after `bun run build:sidecar`. Launched
anywhere else it exits rather than starting unauthenticated. It carries no async
runtime and no proxy handling: `serde_json` and a hundred lines of HTTP/1.1 over
a loopback socket, 380 KB. The same endpoint also speaks MCP over HTTP at
`/mcp`, one POST per request, serving both the stateless `2026-07-28` revision
and the older `initialize` handshake.

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

`--bundles nsis`, `--bundles deb,appimage` or `--no-bundle` skip what you do not
need. This is a Cargo workspace, so bundles land in the repo-root
`target/release/bundle/`, not `src-tauri/target/`.

[`docs/development.md`](docs/development.md) covers running a dev window beside
a release install, [`docs/releasing.md`](docs/releasing.md) cutting a release,
and [`AGENTS.md`](AGENTS.md) the rules that are easy to break.

## Stack

- **Desktop shell**: Tauri 2, frameless window, custom titlebar, strict CSP,
  explicit capabilities (no `core:default`, no `fs:default`).
- **Frontend**: SvelteKit (`adapter-static`, SSR off), Svelte 5 runes,
  Tailwind 4, xterm 6 on WebGL, CodeMirror 6.
- **Core**: Rust. `portable-pty`, `vte` for OSC parsing, `which`, `rusqlite` for
  the workspace database and for reading each agent's session store.
- **Server**: axum, one multiplexed WebSocket, gzip scrollback replay, Web Push.
- **Build**: Vite (aliased to `rolldown-vite`), Bun, `tsgo`.

## Project structure

```text
src/lib/
  app/                    # shell controllers, workspace orchestration, boot
  backend/                # transport abstraction: TauriBackend | RemoteBackend
  domain/                 # rules the features share: no runes, no store behind them
  features/               # vertical slices, each owning components + store
    terminal git explorer editor panes palette browser
    project thread shortcut settings workspace mobile push notifications updater
    fastpick todo approvals devtools setup
  shared/                 # reusable components, brand icons, keyboard, services, utils
  storage/                # DB facade
crates/
  boite-core/             # everything portable, and where a capability is decided
  boite-identity/         # the signing vocabulary both ends share
  boite-agent-api/        # the HTTP routes an agent reaches, written once
  boite-server/           # headless axum server, serves the SPA as a PWA
  boite-mcp/              # the stdio shim a terminal's agent talks to
src-tauri/                # thin Tauri wrapper over boite-core
mobile/                   # Bubblewrap TWA wrapper for the Android build
```

## Contributing

Issues and pull requests are welcome. Follow the vertical-slice layout above,
add new persistence as an append-only migration (never edit a shipped one), and
run the checks in [`AGENTS.md`](AGENTS.md) before pushing.

## License

[MIT](LICENSE).
