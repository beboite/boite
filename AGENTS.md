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
Tauri locally and a WebSocket when the boite is a server. A new capability is
four edits: `backend/types.ts`, the Tauri implementation, the remote one, and
the matching arm in `crates/boite-server/src/rpc.rs`. Miss one and it works on
this machine and fails on a remote boite, silently.

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

The one thing decided at launch instead is the colour inside Claude Code: it
comes from `/color`, passed as the launch prompt through fastpick's passthrough,
and a process already running cannot be repainted from outside.

## Status is measured, never latched

Every pass of `thread/statusEngine.ts` decides running-or-ready from scratch, and
the ticker belongs to the window rather than to a pane: it starts once in
`+page.svelte`. Both of those are load-bearing. When a working signal set a
timestamp and the thread stayed lit until it expired, "finished" was only ever
the absence of evidence, and when the loop was refcounted off mounted
`Terminal` components, closing the last local pane stopped the only thing that
could notice.

Two sources answer, in this order. Claude rewrites
`~/.claude/sessions/<pid>.json` as each of its four states begins and ends, so
`declaredTurn` (`thread/claude-registry.ts`) reads `busy` / `waiting` / `shell` /
`idle` from the agent itself and that settles it, and keeps settling it through a
quiet tool call, a compaction or a hidden pane. Everything else is read off the
emulator's bottom rows (`terminalScreenRows`), which is level: the footer is on
screen or it is not, so `false` means finished rather than "nothing seen lately".
Detection never touches the byte stream. A rolling window of printed bytes answers
a question about the recent past, and an `esc to interrupt` that had scrolled by
kept re-matching itself for as long as the agent printed anything at all.

Only `idle` is a finished turn, and keeping the other three apart is the point.
`waiting` means a dialog is up (a permission prompt, a plan to approve) and
nothing moves until the user answers, so it gets its own `ThreadStatus` rather
than reading as `ready`: it is worth a notification of its own and it must never
be a candidate for auto-sleep. `shell` means the agent takes input again while
something it launched still runs, so the dot says `ready` and the activity stamp
still refuses to sleep it. That is why a pass returns a status and an `active`
flag separately: the dot and auto-sleep are asking different questions.

A subagent is only ever visible in the registry. The Task tool runs one inside
claude's own process, so it gets no session entry of its own and its turns are
appended to the parent transcript with `isSidechain`; the parent just stays
`busy`. From outside that looks like a terminal which has printed nothing for ten
minutes, which is what used to get the thread scored as finished and its PTY
killed by auto-sleep. This is also why `declaredTurn` falls back to matching by
directory while a thread's session id is still uncaptured: those seconds are part
of the opening turn, the one most likely to spend a long time in a subagent. That
fallback needs exactly one live session in the directory, and answers nothing
otherwise.

The server runs the same decision over the same registry
(`boite-core::session::declared_turn`, called from `registry.rs`), reading each
thread's icon key and session id back out of its own thread table. It has no
emulator, so with no registry answer it falls back to the OSC title and a 2s TTL;
that path is now only reached by non-claude agents. Both sides read the same
files, so their rules are mirrored deliberately and tested in both languages
(`claude-registry.test.ts`, `session.rs::turn_tests`).

No other agent declares any of this. Codex, opencode, cursor, antigravity,
copilot, grok and hermes get the screen rows and nothing else, so they are only
ever `running` or `ready`: their approval prompts read as `ready`, and a subagent
of theirs is covered by the raw-output and transcript stamps that hold auto-sleep
off, not by anything that lights a dot.

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

## Before pushing

```bash
bun run check
bun run test
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
