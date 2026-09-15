# Development

Everything below runs from the repository root, on a `bun install` that has
already happened. The rules these commands are meant to prove are in
[../AGENTS.md](../AGENTS.md).

## The core

```bash
bun run dev:core            # bun --watch on packages/core/src/main.ts
bun run core                # the built bundle when there is one, the sources otherwise
```

The core prints one ready line on stdout and nothing else at start:

```
boite-core ready http://127.0.0.1:53421
```

That is the RPC endpoint a client connects to, and it is the whole line. No
pairing grant rides on it: a grant is a live session key, and a line printed on
every start ends up in log files, terminal scrollback and anything that reprints
stdout. A phone gets its link when the owner asks for one in Settings, or over
`pairing.grant` ([docs/phone.md](phone.md)). The core token is 32 random bytes
generated on first start and kept in `<dataDir>/core.json` with the port and the
pid, written `0600`; the shell reads it there, a test reads it there, and it
never appears on stdout.

One core per data directory. The first one to start takes `<dataDir>/core.lock`
and a second one refuses to start rather than rewrite the first one's live turns
as crashes. A lock whose holder is gone is taken over, so a core killed hard
leaves nothing to clean up by hand.

Flags: `--port` (0 asks the OS for a free one), `--host`, `--lan` (which is
`--host 0.0.0.0`) and `--data-dir`. There is a fifth, `--channel`, which takes
`stable` or `dev` and nothing else: it picks the default data directory,
`boite2` or `boite2-dev`, and it is what the dev shell passes so the two installs
never share a journal ([docs/releasing.md](releasing.md)). `bun run dev:core`
passes none of them, so reach the entry point directly when you need one:

```bash
bun packages/core/src/main.ts --port 0 --data-dir /tmp/boite-scratch
```

The data directory is `--data-dir` when given, else `BOITE_DATA_DIR` when set,
else `%LOCALAPPDATA%\boite2` on Windows, `~/.local/share/boite2` on Linux and
`~/Library/Application Support/boite2` on macOS. On `--channel dev` that last
name becomes `boite2-dev`. It holds `core.json`,
`journal.db`, `accounts/`, `providers/` and the files of any managed install.
Never point a scratch run at the real one.

## The UI

```bash
bun run dev:ui              # vite on http://localhost:5173
bun run build:ui            # packages/ui/dist, which the core then serves at /
```

The UI keeps its transport behind one `Client` interface, so it runs on three
things: a WebSocket to a real core, a WebSocket to a remote core, and an
in-memory fake.

- In Vite development mode, `?fake=1` loads `lib/fake-client.ts` instead of the
  socket. No core, no agent, no tokens spent, and the whole contract answered in memory. This is what the
  UI tests run on and the fastest way to look at a screen.
- `?fake=1&long=1` adds a four-hundred-message thread, which is what the
  windowed message list is looked at on.
- `?grant=<grant>` is a pairing link: the page exchanges it once for a session
  key of its own and stores that. `?token=<token>` opens the page on a token
  one already holds, and `?core=<url>` points it somewhere else. All three are
  stripped from the address bar; the grant is never stored.

The service worker never registers under `?fake=1`, so a rebuild is always what
a reload shows.

Two menus open over the composer while typing. `/` on an empty box lists the
commands: the agent's own first (`Thread.commands`, whatever its protocol
reported), then Boite's, the same list as the palette. `@` at the start of a
word lists the project's files, ranked by `projects.files` on the word after
it, and the pick writes the path in as `@src/lib/store.ts`. That is plain text
in the prompt: Claude Code reads a mention as the file itself, every other
agent gets a path relative to its working directory. The core walks the project
once per query burst (a five second hold), skips `.git`, `node_modules` and the
names the root `.gitignore` lists outright, and stops at twenty thousand files,
saying so in `capped`. A glob or a negation in `.gitignore` is not read, so a
tree ignored through one still shows up in the menu.

A draft has one more chip, `Worktree`. On, the first send passes
`worktree: {}` to `threads.create` and the core runs `git worktree add -b`
before writing the thread: the branch is `boite/<slug of the title>` (`-2`,
`-3` when the name is taken, or the `branch` the call names), the directory
is `<parent of the project>/.boite-worktrees/<project>/<slug>`, beside the
repository and on its volume, and the thread's `cwd` is that directory with
`branch` set, which the header shows as a badge. A project that is not a git
repository, a missing git, a branch that already exists: each is refused by
name and no thread is written. The git calls run under the thread's id, so
they are in its trace. Archiving the thread leaves the worktree and the branch
where they are: the branch may carry work nobody merged, and deleting it is a
person's call, `git worktree remove` from the project.

## The echo provider

`echo` is the deterministic fake agent: it streams the prompt back, can call a
fake tool, can ask for a permission, can spawn a child process on request, and
never touches the network. It ships only when `BOITE_ECHO=1` is set, so a user
never sees it in the picker. The tests, the end to end suite and the bench set
it themselves; a core you start by hand without it lists the real providers
alone, and anything expecting an echo account fails on "no echo account". It
takes images: each one comes back as `[image <mime>, <bytes> bytes, <name>]`
in front of the echoed prompt, which is how a test proves an attachment reached
the agent. It lists two slash commands on every turn, `/shout <text>` (the text
back in capitals) and `/whisper`, so the composer's slash menu has an agent
group to show and a test can prove the picked command reached the agent. Its
context meter is 100 tokens plus one per character of the prompt on a window
of 2000, and `[compact]` in a prompt draws a compaction divider and drops the
reading to 300 ([context.md](context.md)).

```bash
BOITE_ECHO=1 bun run dev:core
```

## Checks and tests

```bash
bun run check    # tsc on contracts and core, svelte-check --tsgo on the UI
bun run test     # bun test in packages/core, vitest in packages/ui
bun run e2e      # tests/e2e
```

Run all three once on a clean tree before writing anything. A failure you did not
cause reads exactly like one you did, and that has cost time here before.

`bun run e2e` builds the UI before loading any test. Tests earlier than
`ui.test.ts` also serve that build, so building only inside the UI suite leaves
them without a page in a fresh worktree.

`bun run e2e` covers three surfaces in one go: a real core process over WS with
the echo driver, the UI served by that core and driven in a throwaway browser,
and the release shell executable driven over the WebView2 debugging port. The
shell part runs with `BOITE_SHELL_HIDDEN=1`, which is the only way an agent may
ever start that executable: a window on the user's screen is forbidden.

## Rebuilding the shell executable

`bun run test:shell` runs the Rust unit tests. A full `bun run e2e` fails when
the shell executable or its workers are missing or stale. Set
`BOITE_E2E_SKIP_SHELL=1` only for an explicitly partial core/UI run. The browser
suite rebuilds the UI before starting so it cannot pass against an old bundle.

The end to end run drives
`apps/shell/src-tauri/target/release/boite-shell.exe`, and the only command that
produces a working one is:

```bash
bun run --cwd apps/shell tauri build --no-bundle
```

`cargo build --release` in `src-tauri` compiles the same code and writes the
same path, but the executable it leaves there never reaches its own IPC: every
`invoke` came back with `Origin header is not a valid URL` and the UI never
connected, seven of the ten shell tests failing on it (2026-09-08). Use cargo to
find compile errors fast, never to produce the executable a test runs.

## Staging the sidecar

The shell test drives whatever `boite-core.exe` sits beside
`apps/shell/src-tauri/target/release/boite-shell.exe`. After a core change that
file is stale, and a stale core answers an old contract, which used to look like
a UI timeout. The suite now refuses it in milliseconds, naming the sidecar's
mtime, the newest core source and the fix:

```bash
bun run stage:core   # build:core:exe, then copy the exe and both workers into place
```

That script puts the compiled core in `src-tauri/binaries` for the bundler and
beside the release shell executable for the end to end run, with `jobs-worker.js`
and `guard-worker.js` next to each copy. Without the first the trace degrades
from exact events to polling; without the second the focus guard never starts.

## Captures

The fake client is excluded from production bundles. Tests that need it must
use the Vite development server. `tests/e2e/settings.test.ts` starts and closes
one within the test process; the other end-to-end paths use a real temporary
core with the echo driver.

`tests/e2e/model-switch.test.ts` changes an existing conversation from Echo to
an ACP fixture over real RPC and stdio. It checks history continuity and writes
desktop and phone captures without using provider logins. Core regression tests
also cover queued targets, stale selections, image transfer and schema migration.

`tests/e2e/lib/cdp.ts` launches Chromium with `--headless=new`, on the real GPU
through ANGLE, muted, in a throwaway profile, and drives it over CDP.
`page.screenshot(path)` writes a PNG, and the suite puts its own under
`tests/e2e/.artifacts/`, which is git-ignored. That is the proof for anything
visual: a diff, a passing test and a green build all say nothing about what a
screen looks like.

`BOITE_E2E_BROWSER` overrides the browser lookup when the candidates in that file
find nothing.

## The opt-in live tests

These run a real agent on the user's own CLI login and spend real tokens, so
each one is skipped unless its variable is set. Run them from
`packages/core`, one at a time, and never from a loop.

| Variable | Test | What it proves |
|---|---|---|
| `BOITE_E2E_CLAUDE=1` | `test/claude.live.test.ts` | a real Claude turn, then a resume; the same session imported from `~/.claude/projects` into a new thread and resumed there; a warm thread on one process |
| `BOITE_E2E_OPENCODE=1` | `test/opencode.live.test.ts` | an ACP turn, then a resume on a new process |
| `BOITE_E2E_GROK=1` | `test/grok.live.test.ts` | an ACP turn on a named Grok model and effort, then a resume on a new process. It only ever uses the default account, which reads `~/.grok`: a Grok started on an empty `GROK_HOME` opens a browser |
| `BOITE_E2E_CODEX=1` | `test/codex.live.test.ts` | a Codex app-server turn and its resume |
| `BOITE_E2E_PI=1` | `test/pi.live.test.ts` | a pi turn and its resume |
| `BOITE_E2E_KEBACC_INSTALL=1` | `test/plugins.install.live.test.ts` | pinned native plugin download, version check and uninstall in a temporary directory; no login |
| `BOITE_E2E_ANTIGRAVITY_INSTALL=1` | `test/antigravity.install.live.test.ts` | the managed install for real: 468 MB from Google, the sha256 and every file size checked, `initialize` answered. No sign-in |
| `BOITE_E2E_ANTIGRAVITY=1` | `test/antigravity.live.test.ts` | the whole Google sign-in, in your browser, then one turn. Only a person runs this one |
| `BOITE_BENCH_CLAUDE=1` | `bun run bench` | the Claude turn row of the bench |

One more is opt-in for a different reason. `BOITE_E2E_GUARD=1` runs
`test/guard.e2e.test.ts`, which opens a real window and steals the keyboard focus
for a blink. Every other focus guard case is decided on a fake of the Win32
calls, so no other test creates a window.

## Benches

```bash
bun run bench               # against Boite Legacy, writes bench/results/<date>.md
bun run bench/idle-rss.ts   # the core's idle working set against bare bun
```

Both set their own fresh data directory. Quote a figure with the date of the run
it came from, and rerun before quoting an old one.

## The worktree trap

An agent usually works in a detached git worktree of this repository, and the
private working notes under `.claude` are excluded from git, so no worktree has
a copy of them. A write to one of those files by absolute path lands in the
original checkout: outside the worktree, outside the branch, outside the commit,
and invisible to the review that follows. The tracked docs, this page included,
are the ones a worktree can actually change. Check where a file you are about to
edit really lives before editing it.
