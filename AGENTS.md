# AGENTS.md

The rules that are easy to break without noticing. `README.md` has the stack and
the build commands, `docs/development.md` the isolated dev window and the MCP
bridge, `docs/releasing.md` the release process.

## Translations

No literal user-facing string in a `.svelte` file. `title`, `placeholder` and
`aria-label` included. Everything goes through `t()`.

The key has to be a literal at the call site: `MessageKey` is derived from
`EN_MESSAGES`, and `messages.fr.ts` is annotated `Record<MessageKey, string>`,
so an English key with no French twin fails `bun run check`. A template literal
defeats both checks at once. When a key must vary, put a `MessageKey` on the
data instead.

## Talking to the machine

Components never call `invoke`. Everything goes through `backend()`, which is
Tauri locally and a WebSocket when the boite is a server.

On the Rust side a capability is a value on one bus, `boite_core::command`, and
the two front doors are codecs over it. Adding one is a variant, its name in
that domain's `ALL_METHODS`, the arms the compiler then demands, and a
`#[tauri::command]` calling `on_bus`; the server needs nothing, because
`command::handles` routes it. It used to be four coordinated edits with nothing
checking that the four agreed, and every divergence found in the audit was a
capability that existed on one side only.

`Command::decode` routes on each domain's own method list, not on the wire
prefix. `project.` means two things: `project.inspect` asks about a folder that
is not a project yet and belongs to files, `project.list` reads rows. A test
asserts no two domains claim the same name, because a duplicate would decode
into the wrong domain with the wrong capability and the wrong envelope rather
than failing.

**The rows are on it too, and nothing in the webview writes SQL.** Projects,
threads, todos and settings go through `commands::records`; `db.ts` holds no
statements. The eight it used to hold were the desktop's half of a schema the
server read with fifteen hand-written arms, and the two had drifted: a whole-row
`REPLACE` built from a stale snapshot could put `running` back on a thread whose
process had ended, and only one side folded an unknown todo state back to
`open`. A row rule belongs in `boite_core::store` or `command::records`, where
both hosts get it.

Inside the Tauri backend, the facades import `invoke` from
`backend/tauri/ipc.ts` rather than from `@tauri-apps/api/core`. That door writes
a `warn` when a command refuses and re-throws untouched. Importing the real one
means a refusal that reaches a `catch` somewhere and is never written down.

## A process can rewrite its own thread

A launcher is not the thing it launched, so one can say what it became:
`ESC ] 1337 ; boite ; launch = {json} BEL` on its own stdout replaces the thread's
command, arguments and icon, and that is what a reload replays.
`thread/promote.ts` parses it, and everything there is checked rather than
spread onto the thread. A terminal's output is whatever the process printed,
including a file someone else wrote. Boite advertises itself as `TERM_PROGRAM=boite`
so a tool can stay silent in every other terminal.

## What a thread looks like is derived, never stored

A fastpick thread keeps the agent's icon, so the tint saying which model is
behind it is computed at render from the command, in `fastpick/threadAccent.ts`.
Writing it onto the row would make the setting apply to new threads only, and
would miss a thread a process promoted itself. The same holds for the combo:
`parseCombo` reads it back out of `cmd` and `args` rather than storing it beside
them, which is why a hand-typed `fastpick --harness ...` is described like one the
menu launched.

Nothing is decided at launch any more. The colour inside Claude Code used to be:
a `/color <name>` passed as the opening prompt through fastpick's passthrough,
which could not be taken back from a process already running. It also ran a
slash command and printed an answer at the top of every single launch, for a
strip of colour the sidebar was already showing, so it is gone. Rows created
before that still carry it, and `withoutBarColor` drops it as the argv goes past
rather than rewriting the row: a thread's command line is the user's to read and
edit, and quietly editing it is the more surprising of the two.

## A launcher is not the agent, at relaunch either

A fastpick thread has two argument regions with two owners, split at the first
`--`, and `thread/resume-args.ts` is where that split is respected: fastpick
reads what is in front, the agent gets what is behind, and every resume flag,
MCP flag and opening prompt is written behind it. Appending to one flat list
worked by luck. It survived for as long as no flag's name collided with one
fastpick claims for itself, and `-c mcp_servers.boite.command=...` for codex is
exactly that collision: it read as fastpick's own `--config`, and the launch died
on a file that does not exist. `parseCombo` stops at the same separator, so an
agent flag behind it can never rename the combo the sidebar reads.

Codex reads `--model` on its root only, and its resume is the subcommand `codex
resume <id>`, so the model fastpick puts on the root does not reach a resumed
session. The combo already says which model the thread is, so a fastpick codex
resume names it again on the subcommand.

**The agent whose session a thread holds is not always the process the PTY
spawned.** fastpick resolves a harness and then runs it, so claude's pid is a
child of the pid the PTY reports, and a wrap shell adds another level. Session
capture used to compare the two as equals: a fastpick thread's own live session
read as a stranger's, was skipped by the liveness filter on every scan, and the
relaunch it was for had no id to replay. Every fastpick row in the database had
an empty `session_id`, which is all that failure ever looked like from outside.
`session::ProcessTree` walks the parent chain instead, bounded at sixteen hops
because a pid map read while processes come and go can name a cycle.

## Status is measured, never latched

Every pass of `thread/statusEngine.ts` decides running-or-ready from scratch, and
the ticker belongs to the window rather than to a pane: it starts once in
`+page.svelte`. Both of those are load-bearing. When a working signal set a
timestamp and the thread stayed lit until it expired, "finished" was only ever
the absence of evidence, and when the loop was refcounted off mounted
`Terminal` components, closing the last local pane stopped the only thing that
could notice.

Two sources answer, in this order. Three agents say what they are doing, each in
a different place, and `boite-core/src/session.rs` reduces all three to one shape
that `declaredTurn` (`thread/agent-registry.ts`) then reads:

- claude writes `~/.claude/sessions/<pid>.json` per open session and rewrites
  `status` as each of its four states begins and ends: `busy`, `waiting`, `shell`,
  `idle`.
- codex leaves no live file at all. Its status model exists but is pushed over
  JSON-RPC to whoever spawned the process, so a terminal a human started exposes
  nothing. What is on disk is `~/.codex/state_*.sqlite` (thread id, cwd, rollout
  path) plus the rollout itself, which brackets every turn with `task_started` and
  closes it with `task_complete` or `turn_aborted`.
- opencode serves `GET /session/status`, but a plain TUI runs its server in a
  worker thread and binds no port, so that route is unreachable in the normal
  case. Its database answers instead: an assistant message gains `time.completed`
  when its turn ends and does not carry the field before that.

An answer only counts while whatever wrote it is still there. Claude's registry
is filtered by `pid_alive`; the other two have nothing equivalent, so their open
turns are bounded by age instead. A rollout whose last marker is `task_started`
and an opencode row that never gained `time.completed` both stop counting once
they have gone untouched for half an hour, which is generous because a single
long tool call appends nothing while it runs. Killed, crashed or rebooted
mid-turn, either would otherwise read `busy` on every poll for good, with no pid
to check and no row that ever ages out. A claude entry carrying no `status` key
produces no answer either, rather than a default: absence is not a state, and
this is the status source of truth now, so a default of `busy` would pin every
claude thread Running with nothing able to clear it.

Everything else is read off the emulator's bottom rows (`terminalScreenRows`),
which is level: the footer is on screen or it is not, so `false` means finished
rather than "nothing seen lately". Detection never touches the byte stream. A
rolling window of printed bytes answers a question about the recent past, and an
`esc to interrupt` that had scrolled by kept re-matching itself for as long as the
agent printed anything at all.

What that reads is the shape of the row, never the glyph leading it. Claude
rotates its spinner through `· ✢ ✳ ∗ ✻ ✽ ✶ *`, an ASCII asterisk and a middle dot
among the dingbats, and it leads the line it prints when a turn ENDS with one of
the same glyphs (`✻ Crunched for 19s`) and leaves it there until the next turn. A
list of frames therefore matches some and misses others, which is a dot flickering
twice a second, and a leading glyph on its own reads a finished turn as a running
one. Every live frame carries the gerund's ellipsis and an elapsed count; the
finished line carries the count alone. Braille and circle frames are the exception
and stand on their own, because nothing leaves one of those on screen.

How far up the rows are read is decided by the screen, not by a number: the block
is the bottom run with no blank row in it. A fixed count was calibrated on a bare
claude, and a statusline plus a banner pushed the spinner eight rows up, out of a
five-row window, so a working agent read as finished.

When neither source answers there is nothing to measure, and that is the one
place a clock still decides anything. A thread whose pane is gone has no emulator
holding its rows (a `Terminal` unmounts with the PTY alive whenever the thread
leaves a group, loses its `rect` or `group`, or flips its respawn key), and five
of the agents declare nothing, so the pair answers nothing at all. It keeps its
status until every activity stamp has aged out and then drops to `ready`
(`UNREAD_TTL_MS`, two seconds, mirroring the server's `WORKING_TTL` and the
`DeclaredTurn::Unknown` arm of its `next_status`). That is not the old grace
period on a working signal, it is what stops "no answer" from meaning "keep the
last answer forever": a thread frozen on `running` is also frozen out of
auto-sleep, which only ever considers a `ready` one, so its PTY is never
reclaimed either. Nothing is announced on that demotion, since it is the absence
of evidence rather than a turn that ended.

Only `idle` is a finished turn, and keeping the other three apart is the point.
`waiting` means a dialog is up (a permission prompt, a plan to approve) and
nothing moves until the user answers, so it gets its own `ThreadStatus` rather
than reading as `ready`: it is worth a notification of its own and it must never
be a candidate for auto-sleep. `shell` means the agent takes input again while
something it launched still runs, so the dot says `ready` and the activity stamp
still refuses to sleep it. That is why a pass returns a status and an `active`
flag separately: the dot and auto-sleep are asking different questions. Only
claude ever declares those two; codex and opencode answer `busy` or `idle` and
nothing else, so their approval prompts still read as `ready`.

A notification is a transition, never a reading. The first pass after a mount, a
workspace switch or a `forget` has no previous status to compare against and so
says nothing: a dialog that was already up when the pane opened is not a dialog
that just went up, and announcing it pinged for every parked thread on every app
start.

A subagent is only ever visible this way. Claude runs one inside its own process,
so it gets no session entry and the parent simply stays `busy`; codex holds the
turn open across `sub_agent_activity`; opencode gives the child its own session
row while the parent's assistant message stays incomplete. From outside, all three
look like a terminal which has printed nothing for ten minutes, which is what used
to get the thread scored as finished and its PTY killed by auto-sleep. This is
also why the reading falls back to matching by directory while a thread's session
id is still uncaptured: those seconds are part of the opening turn, the one most
likely to spend a long time in a subagent. That fallback needs exactly one live
session of that agent in the directory, and answers nothing otherwise. It also
needs the session to have recorded a directory of its own: normalising strips a
trailing slash, so a thread at the root of a drive would otherwise match every
session that recorded nothing.

## Which conversation a thread is bound to

A thread with no `sessionId` relaunches into a blank agent, so binding one is not
cosmetic. The rule is asked in `find_claude_session_blocking`: the caller passes
its pty id, the host turns it into the pid of the process behind it, and a
registry entry naming that pid is the answer outright. Nothing else outranks it,
neither a newer transcript nor an id another thread already claimed, and the hit
says so with `ownPid` so the window knows it was told rather than having guessed.

Everything else is the guess, and it stays for the seven agents that keep no such
registry: the newest unclaimed transcript in the directory, accepted only when
its mtime lines up with this pty's own activity and with no sibling's
(`attributedToSelf`). What that cannot settle is two agents of one kind busy in
one folder — each is "recently active" whenever the other writes — and it settled
it by binding neither, silently, for as long as both ran. Threads sharing a
project folder rather than a worktree are the common case, and a `debug` line is
compiled out of the builds where this happened, which is why the refusal now says
so at `warn` once it has stopped looking early.

An attach starts the monitor too. A thread parked before its first scan landed
had no second chance at binding, and the pane coming back is exactly when it
should get one.

Reading these stores is not free, so `agentTurns` is asked only about the threads
that are actually open, and at most once a second. That read is one directory
walk, two SQLite opens and up to a 256 KiB file read, which is why every caller
puts it on a blocking thread (`spawn_blocking` in `commands.rs`, `rpc.rs` and the
server's status ticker) and why a read that has not answered inside
`POLL_DEADLINE_MS` is abandoned rather than waited on: a call that never settles
used to latch the poll shut and freeze every agent thread on its last declared
state.

The server runs the same decision over the same stores
(`boite-core::session::agent_turns` and `declared_turn`, called from
`registry.rs`), reading each thread's icon key and session id back out of its own
thread table. It has no emulator, so with no answer it falls back to the OSC
title and a 2s TTL. Both sides read the same files, so their rules are mirrored
deliberately and tested in both languages (`agent-registry.test.ts`,
`session.rs::turn_tests`).

The five remaining agents (cursor, antigravity, copilot, grok, hermes) declare
nothing that can be polled from outside, and get the screen rows alone.

## Checking your work in the running app

A screenshot and a DOM read tell you almost nothing here: **the terminals render
to a WebGL canvas**, so everything an agent Boite runs prints is absent from the
DOM, and a toast has dismissed itself before you look. Reach for
`window.__boite` instead — `read("Claude #1")` returns what that terminal is
showing as text, `thread(...)` returns its project, folder, worktree and session
id, `toasts()` returns what was raised even after it vanished. Dev builds only;
[`docs/development.md`](docs/development.md) has the full list.

A terminal only exists once its pane has been opened. A thread nobody clicked
has no buffer to read, which is a different answer from an empty one.

From outside the window, ask the workspace instead of asking a human. One
`workspace_snapshot` carries every project and thread, the terminals the process
really has a child for, and `screen`: each pane with its kind, its title and its
measured size, which one has focus, and what is covering the layout. A pane
listed at zero pixels is open and not visible, and nothing else reports that.
`screen.at` is a heartbeat, so one far behind `takenAtMs` means the window
stopped answering. `workspace_search` and `workspace_timeline` answer where and
when across the todo list, the log of what agents did and what the terminals
printed, and `terminal_transcript` reads any thread's output back from the end,
including a thread that has already stopped.

## Measuring, before claiming

An optimisation with no measurement attached does not stay. There are three
ways to get one, and each already found something the comments had wrong.

- `bun run budget` separates what the window downloads before it can paint from
  what is merely shipped, against ceilings in `scripts/bundle-budget.json`. CI
  runs it. Moving a ceiling is allowed and is the point: it happens in the same
  commit as the growth, with the reason in the message.
- `cargo bench -p boite-core` covers the paths whose cost is asserted in a doc
  comment. Not in CI, because a benchmark on a shared runner measures the runner.
  The first numbers are recorded in `benches/hot_paths.rs`.
- `src/lib/app/boot-timing.ts` writes one line per boot, at `warn` past two
  seconds so a slow one reaches the timeline beside whatever else was happening.
- `src/lib/features/thread/spawn-timing.ts` does the same for one thread lighting
  up: one line per launch, phased into `worktree`, `resume`, `pty` and `output`,
  at `warn` past three seconds. Written on the first byte the process prints
  rather than when the PTY comes back, because a PTY that opened in 40ms and
  showed nothing for eight seconds is the case being looked for. Two watchdogs
  cover the launches that would otherwise write nothing at all: one says a
  launch is still opening after fifteen seconds and names the phase it is stuck
  in, the other writes the line without a first byte after ten. A thread that is
  worked in for two minutes with no session captured gets one line too, from
  `session-monitor.svelte.ts`, since a silent capture failure is a thread with
  no `--resume` behind it.

A timer may slow down while `document.hidden`; a status timer may not stop.
Nobody is reading a dot they cannot see, but the threads a status sweep demotes
are exactly the ones nobody is looking at, and a notification is a transition it
has to be awake to notice.

## Before pushing

```bash
bun run check
bun run test
bun run budget
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
