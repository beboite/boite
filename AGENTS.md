# AGENTS.md

The rules that are easy to break without noticing, and the file that owns each
one. Stack and build commands: [README.md](README.md). Isolated dev window and
MCP bridge: [docs/development.md](docs/development.md). Tags and signing:
[docs/releasing.md](docs/releasing.md). What a pane exports to a status line:
[docs/status-lines.md](docs/status-lines.md).

Everything here is a good default rather than a law, and the person asking
outranks it. The four rules below are the exception: break one and something
ships broken without a check failing.

## Words

- **you**: the agent reading this and changing boite. Most changes to boite are
  made from inside boite, so you are probably running as one of its threads, in a
  detached worktree of the repo you are editing.
- **user**: the person driving those threads. **agent** or **provider**: one of
  the ten CLIs boite launches (claude, codex, opencode, cursor, antigravity,
  copilot, grok, hermes, pi, muse).
- **project**: a folder boite knows about. **thread**: one terminal in it, with
  its own PTY, its own worktree and at most one agent conversation bound to it.
- **group**: the set of panes drawn for one thread. Every group is mounted at
  once and all but one are `visibility: hidden`.
- **boite**: this app. **a boite**: one running instance, which may be the
  desktop window or a `boite-server` other clients connect to.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `taskkill /IM`, or kill a pid you
   found by matching a name, a path or a worktree string. Your own process, the
   user's other agent threads and the app drawing them all carry "boite" and
   often this worktree's path in their argv. Kill only a pid you captured at
   spawn.
2. **Touching the live install.** The user's real database, scrollback and window
   state sit in `com.boite.desktop`'s app data directory and are open while you
   work. Copying out of it is fine and is the only realistic test data. Never
   open it read-write, never point a server at it, never tidy it. That is what
   `bun run dev:isolated` is for: a separate window on port 1430 under
   `dev.boite.dev`, with its own database. A plain `tauri dev` refuses to start
   anyway, the release instance holding the single-instance lock.
3. **Deleting a worktree by hand.** A thread's worktree holds a junction onto the
   project's session store, and on Windows a delete that meets a junction walks
   into it, so an `rm -rf` on a worktree can take every transcript in the project
   with it. Go through `worktree.remove`, which unlinks first.

## Four rules with no exceptions

1. **No literal user-facing string in a `.svelte` file**, `title`, `placeholder`
   and `aria-label` included. `t()`, with the key a literal at the call site: a
   template literal defeats the `MessageKey` derivation and the French
   `Record<MessageKey, string>` at once, so it ships an untranslated string
   `bun run check` cannot see. A key that has to vary goes on the data instead.
2. **No `invoke` in a component.** Everything goes through `backend()`, which is
   Tauri locally and a WebSocket when the boite is a server. Inside the Tauri
   backend, import `invoke` from `backend/tauri/ipc.ts`, never from
   `@tauri-apps/api/core`: that door writes a `warn` when a command refuses,
   then re-throws untouched.
3. **No SQL in the webview.** Projects, threads, todos and settings go through
   `commands::records`, and `db.ts` holds no statements. A row rule belongs in
   `boite_core::store` or `command::records`, where both hosts get it; written on
   one side only it drifts, and the drift rewrites rows the other host wrote.
4. **No `$state` writer that reads the state it writes.** It subscribes its
   caller's `$effect` to its own output. Cost so far: `note()` skipped a
   same-value write, the frame's `load` re-triggered the effect arming the stall
   timer, and every browser pane reported `loading` forever.

## One bus, two front doors

A capability is a value on `boite_core::command`; the Tauri commands and the
server are codecs over it. Adding one is a variant, its name in that domain's
`ALL_METHODS`, the arms the compiler then demands, and a `#[tauri::command]`
calling `on_bus`. The server needs nothing, `command::handles` routes it.

`Command::decode` routes on each domain's own method list, not on the wire
prefix, so `project.inspect` (files, a folder that is not a project yet) and
`project.list` (records) coexist. A test asserts no two domains claim one name:
a duplicate decodes into the wrong domain with the wrong envelope rather than
failing.

## A thread's look is derived, never stored

The model tint, the icon and the fastpick combo are computed at render from
`cmd` and `args` (`fastpick/threadAccent.ts`, `parseCombo`). Stored on the row
they would apply to new threads only, and would miss a thread that renamed
itself. `withoutBarColor` drops the `/color` argument old rows still carry as the
argv goes past, rather than rewriting the row: a thread's command line is the
user's to read and edit.

A process can rename itself. `ESC ] 1337 ; boite ; launch = {json} BEL` on its
own stdout replaces the thread's command, arguments and icon, and that is what a
reload replays. `thread/promote.ts` checks every field rather than spreading it,
because a terminal's output is whatever the process printed, including a file
somebody else wrote. Boite advertises `TERM_PROGRAM=boite` so a tool can stay
silent in every other terminal.

## A launcher is not the agent it launched

`thread/resume-args.ts` splits argv at the first `--`: fastpick reads what is in
front, the agent gets everything behind, and every resume flag, MCP flag and
opening prompt is written behind it. Appending to one flat list holds only until
an agent flag collides with a name fastpick claims, and codex's
`-c mcp_servers.boite.command=...` is that collision. `parseCombo` stops at the
same separator, so a flag behind it can never rename the combo the sidebar reads.

Codex reads `--model` on its root only and resumes through the subcommand
`codex resume <id>`, so a resume has to name the model again there.

Session capture walks the parent chain (`session::ProcessTree`, bounded at
sixteen hops, a pid map read while processes come and go can name a cycle).
fastpick resolves a harness and then runs it, so claude's pid is a child of the
one the PTY reports; comparing the two as equals left every fastpick row with an
empty `session_id`.

## Status is measured, never latched

Every pass of `thread/statusEngine.ts` decides running-or-ready from scratch,
and the ticker belongs to the window rather than to a pane: it starts once in
`+page.svelte`. Both are load-bearing. Latch a working signal to a timestamp and
"finished" only ever means the absence of evidence; refcount the loop off mounted
`Terminal` components and closing the last local pane stops the only thing that
could notice.

**First source: what the agent declares.** Three of the ten do, each somewhere
else, and `boite-core/src/session.rs` reduces the three to the shape
`declaredTurn` reads.

- claude rewrites `status` in `~/.claude/sessions/<pid>.json`: `busy`, `waiting`,
  `shell`, `idle`.
- codex pushes its status over JSON-RPC to whoever spawned it, so a terminal a
  human started exposes none of it. Its rollout is read instead, every turn
  opening on `task_started` and closing on `task_complete` or `turn_aborted`,
  with `~/.codex/state_*.sqlite` naming the file.
- opencode serves `GET /session/status`, but a plain TUI runs its server in a
  worker thread and binds no port. Its database answers: an assistant message
  gains `time.completed` when its turn ends.

An answer counts only while whatever wrote it is still there. Claude's entries
are filtered by `pid_alive`, the other two age out after half an hour, generous
because one long tool call appends nothing while it runs. Killed mid-turn, either
would otherwise read `busy` for good. **No `status` key produces no answer, never
a default**: absence is not a state, and a default of `busy` would pin every
claude thread Running with nothing able to clear it.

**Second source: the emulator's bottom rows** (`terminalScreenRows`), for
everyone else. Level by construction, the footer being on screen or not. Never
the byte stream, where an `esc to interrupt` that scrolled past keeps re-matching
for as long as the agent prints anything.

- Match the shape of the row, never the glyph leading it. Claude's spinner
  rotates through `· ✢ ✳ ∗ ✻ ✽ ✶ *`, and one of those also leads the line printed
  when a turn **ends** (`✻ Crunched for 19s`), left there until the next one. A
  live frame carries the gerund's suspension points and an elapsed count, the
  finished line carries the count alone. Braille and circle frames stand on their
  own, nothing leaves one of those on screen.
- How far up to read is decided by the screen: the bottom run with no blank row
  in it. A fixed count was calibrated on a bare claude, and a statusline plus a
  banner push the spinner out of it.

**With no answer from either, a clock decides, and only there.** A thread whose
pane is gone has no emulator, and seven agents declare nothing. It keeps its
status until every activity stamp ages out, then drops to `ready`
(`UNREAD_TTL_MS`, 2s, mirroring the server's `WORKING_TTL`), silently, being an
absence of evidence rather than a turn that ended. Without it a thread frozen on
`running` is frozen out of auto-sleep too, which only considers `ready` ones, so
its PTY is never reclaimed.

Only `idle` is a finished turn, and the other three stay apart. That is why a
pass returns a status and an `active` flag separately: the dot and auto-sleep ask
different questions.

- `waiting`, a dialog up and nothing moving until the user answers, is its own
  `ThreadStatus`: worth a notification, never a candidate for auto-sleep.
- `shell`, the agent taking input again while something it launched runs, draws
  `ready` while its activity stamp still refuses sleep.
- Only claude declares those two, so codex and opencode approval prompts read as
  `ready`.
- A notification is a transition, never a reading. The first pass after a mount,
  a workspace switch or a `forget` says nothing: a dialog already up is not a
  dialog that just went up.
- **A subagent is only ever visible through this source.** From outside, claude
  staying `busy`, codex holding the turn open across `sub_agent_activity` and
  opencode's incomplete parent message all look like a terminal that has printed
  nothing for ten minutes, which is what used to get the PTY reclaimed.

## Which conversation a thread is bound to

A thread with no `sessionId` relaunches into a blank agent, so binding one is not
cosmetic. `find_claude_session_blocking` asks one question first: the caller
passes its pty id, the host turns it into the pid behind it, and a registry entry
naming that pid is the answer outright, flagged `ownPid` so the window knows it
was told rather than having guessed. Nothing outranks it, neither a newer
transcript nor an id another thread already claimed.

The nine agents that keep no such registry get the guess: the newest unclaimed
transcript in the directory, accepted only when its mtime lines up with this
pty's own activity and with no sibling's (`attributedToSelf`). Two agents of one
kind busy in one folder cannot be settled that way, each reading as recently
active whenever the other writes, and threads sharing a project folder rather
than a worktree are the common case. That refusal says so at `warn`, the `debug`
line it used to write being compiled out of exactly those builds.

That read is one directory walk, two SQLite opens and up to a 256 KiB file, so
every caller puts it on a blocking thread and abandons it past
`POLL_DEADLINE_MS`: a call that never settles latches the poll shut and freezes
every thread on its last declared state. `agentTurns` is asked only about open
threads, at most once a second. An attach restarts the monitor, a thread parked
before its first scan landed otherwise never getting a second chance.

The server runs the same decision over the same files (`session::agent_turns`,
`declared_turn`, from `registry.rs`), with the OSC title and a 2s TTL where the
emulator would be. Both sides are tested (`agent-registry.test.ts`,
`session.rs::turn_tests`).

## One pool of conversations per project

Claude, grok and pi file a transcript under the directory the CLI ran in, and every
agent thread runs in a worktree of its own, so `/resume` inside a thread listed
that thread's conversations and nothing else. `session/shared.rs` makes a
worktree's store a link onto the project's, created when the worktree is handed
out (`worktree.open`) and removed before git touches the directory
(`worktree.remove`): on Windows a delete that meets a junction walks into it.
`repair` folds in the worktrees that predate this, keeping both stores when a
session id collides rather than overwriting.

- **Every scan of those stores skips the links** (`find_claude_session_blocking`,
  `collect_usage_blocking`). A transcript reached through two names is one
  transcript, and a project with ten open threads would open every file eleven
  times per pass.
- **Binding asks the registry before it asks about directories**
  (`named_by_registry`). A pooled conversation sits in the project's folder
  rather than any thread's, and its head names the worktree it started in, so
  both placement tests answer no for it and would drop a pid's answer before
  `choose_claude_hit` sees it.

## Closing a thread is not a deletion

The process dies at once and the row leaves the sidebar, but the parts that
cannot be taken back wait: the checkpoint refs and the worktree are given back
ten minutes later (`worktree-grace.ts`), and restoring the thread inside that
window cancels it. What is given back is empty by definition, a worktree holding
work refusing removal at the end of the wait exactly as it does at the start. The
confirm dialog is not an answer to this, being off by default and answered by
reflex when it is on.

Past the window a restore adopts the checkout when it is still there and opens a
fresh one carrying the transcript when it is not (`withWorktree`): coming back
with no worktree at all would put an agent to work in the user's own checkout
without saying so. Quitting mid-window is the one case nothing cleans up, and the
project's Worktrees tab gives back every checkout no thread is standing in.

## What a launch opens on

A restart is evidence of nothing, so a row that was never run draws nothing: no
colour, no badge, its logo and its name (`cold` in `threadVisual.ts`). Only a
thread that was on when the app went away comes back asleep. Collapse the two and
the sidebar opens on a column of `z` badges on threads nobody ever started.

One mark survives. `thread.started` writes `running` when a PTY comes up, the
only status the window persists (`ready` and `waiting` come and go several times
a turn), and `thread.create` keeps the persisted one by design.
`Store::settle_last_run`, once per host before anything reads the table, turns
that mark into a real `stopped` **and turns the previous run's `stopped` back
into `idle`**. That second write is the half that is easy to drop and is the
point: without it a thread launched a month ago is still reported asleep today.
The server persists the same word and deliberately not `stopped`
(`make_event_emitter`): an auto-sleep is that run's own bookkeeping, and writing
it would decay the mark one restart early.

## An MCP action never takes the screen

A tool call arrives while somebody is typing in a terminal that is not the
caller's, so nothing an agent asks for moves the view. `pane_open` puts the pane
beside the **caller's own** thread, in that thread's group, and the selected
project, the thread on screen and the keyboard focus stay exactly where the user
left them (`openPane`'s anchor, `openBeside(..., focus: false)`). A toast says
what was opened in a group nobody is looking at, the same way a spawn does.

Which means an agent's pane is usually in a hidden group, and hidden is
`visibility: hidden`, not unmounted: every group is mounted at once, so the frame
loads and the driver answers the whole time.

- **No browser tool is scoped to the project on screen.** One was, and every call
  answered "the window is showing another project right now" to an agent working
  while the user read something else, including about the pane it had just
  opened. The `drivenBy` mark is the only rule (`which_pane`), and naming no
  `paneId` means the caller's own pane.
- **`browser_screenshot` is the exception.** A hidden pane is laid out at the
  same coordinates as the pane covering it, so it refuses rather than
  photographing somebody else's (`Pane::shown()`, absent from an older build's
  description and read as visible). `browser_snapshot` reads the page wherever
  it is.

## Hit every surface

The most common defect here is a change that works on the path it was tested on
and is missing everywhere else. Before calling something done, walk this list and
say which entries applied.

- **Both hosts.** A capability put on `boite_core::command` reaches the desktop
  and the server at once, which is the whole point of the bus. Anything above it
  does not: a rule written in the webview has no effect on a phone talking to a
  `boite-server`, and one written in `registry.rs` never runs in the window.
- **Both status readers.** `agent-registry.ts` and `session.rs` decide the same
  thing over the same files on purpose, and are tested in both languages. A
  change to one is a change to two.
- **Every provider.** Ten adapters, and they answer differently by nature: three
  declare a turn, one keeps a live registry, one has no build for this platform.
  A provider-shaped feature needs a decision per adapter, even if the decision is
  "not supported here".
- **Both languages.** `bun run check` catches a missing French key, not an
  English one written straight into a component.
- **The phone.** The mobile layout swaps the sidebar and the docked column for a
  bottom bar, has no command palette and no local filesystem, and always talks
  over the WebSocket. A feature reachable only from a right-click or a keybinding
  does not exist there.
- **Reverse states.** A way in needs the way out and the way to see it: closing
  needs restoring, sleeping needs waking, opening a pane needs closing it. A
  one-way door is a bug.
- **The MCP endpoint.** An agent asks for the same things the user clicks. A new
  capability the user has is usually one an agent should have, and always one it
  must not be able to take the screen with.

## Checking your own work

**The terminals render to a WebGL canvas**, so a screenshot and a DOM read show
none of what an agent printed, and a toast has dismissed itself before you look.
Inside the window, reach for `window.__boite` (dev builds only, full list in
[docs/development.md](docs/development.md)): `read("Claude #1")` returns what a
terminal is showing as text, `thread(...)` its project, folder, worktree and
session id, `toasts()` what was raised even after it vanished. A terminal exists
only once its pane has been opened, and "no buffer" is a different answer from an
empty one.

From outside the window, ask the workspace rather than a human. One
`workspace_snapshot` carries every project and thread, the terminals the process
really has a child for, and `screen`: each pane's kind, title and measured size,
which one has focus, what covers the layout. A pane listed at zero pixels is open
and not visible, and nothing else reports that; `screen.at` far behind
`takenAtMs` means the window stopped answering. `workspace_search` and
`workspace_timeline` answer where and when, `terminal_transcript` reads any
thread's output back from the end, stopped threads included.

## Measure before claiming

An optimisation with no measurement attached does not stay.

- `bun run budget` separates what the window downloads before it can paint from
  what is merely shipped, against ceilings in `scripts/bundle-budget.json`. CI
  runs it. Moving a ceiling is allowed and is the point: same commit as the
  growth, with the reason in the message.
- `cargo bench -p boite-core` covers the paths whose cost a doc comment asserts.
  Not in CI, where a benchmark measures the runner. First numbers in
  `benches/hot_paths.rs`.
- `app/boot-timing.ts` and `thread/spawn-timing.ts` write one line per boot and
  per launch, at `warn` past two and three seconds, so a slow one lands on the
  timeline beside whatever else was happening. A launch is phased into
  `worktree`, `resume`, `pty` and `output`, and its line is written on the first
  byte the process prints rather than when the PTY comes back: a PTY that opened
  in 40ms and showed nothing for eight seconds is the case being looked for. Two
  watchdogs cover the launches that would write nothing at all, and
  `session-monitor.svelte.ts` writes one for a thread worked in for two minutes
  with no session captured.

A timer may slow down while `document.hidden`. A status timer may not stop: the
threads a sweep demotes are exactly the ones nobody is looking at, and a
notification is a transition it has to be awake to notice.

## Before pushing

```bash
bun run check
bun run test
bun run budget
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
