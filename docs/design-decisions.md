# Design decisions

Boite makes a handful of tradeoffs that look like oversights until the
alternative is priced. This page states each one: what was chosen, what it
costs, and what the other option would have cost. If you arrived here from a
review, human or otherwise, the objection you have in mind is probably below.

## Status is declared where possible, read off the screen elsewhere

Claude, Codex, Opencode and Grok record what they are doing in a store of
their own, and Boite reads that store: those four report a finished turn as a
fact, not as an absence of output. The other agents publish no machine-readable
state anywhere, so their status is read from the shape of the terminal's
bottom rows.

The heuristic rows are the fragile ones, and that fragility is a property of
the vendors, not of the reader: a CLI that exposes no state can only be
observed. Each agent that starts publishing state gets promoted to the
declared column; the terminal reading is the floor, not the design.

What keeps ten agents from meaning ten code paths in the UI is a
normalization layer: every source, declared or read, collapses to one
`AgentTurn` shape (`busy`, `waiting`, `shell`, `idle`) in
`boite-core/src/session.rs`, mirrored by
`src/lib/features/thread/agent-registry.ts` so the desktop and the server
cannot disagree about a thread. The UI never knows which agent it is looking
at. There is no formal per-vendor plugin trait on top of that, on purpose:
the varying surface is ten small readers, and a public adapter contract would
be a stability promise no vendor lets Boite keep.

## Worktrees share `node_modules`, `target`, `.venv` and `vendor`

Every agent thread runs in its own detached git worktree, so two agents never
edit the same checkout. The heavy directories are linked back to the main
checkout (a junction on Windows, a symlink elsewhere) instead of copied.

The price is stated in the README: `bun install` in a thread writes into the
shared directory, and two `cargo build` runs serialize on one `target` lock.
The alternative is a full install and a full recompile per thread, which on a
Rust or JS project of any size turns "open a second agent" into a
multi-minute, multi-gigabyte operation. Boite chose cheap threads with shared
caches over expensive threads with perfect isolation. Full environment
isolation is container territory, and a container per thread is a different
product.

## Revocation is checked on a two-second cache

`boite-server` verifies that a PTY connection's device is still authorized on
a cache of two seconds (`REVOKE_RECHECK` in `ws.rs`) instead of hitting
SQLite for every terminal chunk. A revoked device can therefore keep a PTY
byte stream alive for up to two seconds after revocation; it cannot open
anything new.

Per-chunk verification would put a database read in the hot path of every
keystroke and every line of build output. Two seconds of residual stream on
an already-established connection was judged the right price for that. If
your threat model cannot absorb it, the number is a constant, not a
philosophy.

## The PTY follows the client that is driving it

Several devices can watch the same thread. The PTY has one size, so someone
has to win. The rule: the client actually sending input owns the size; a
device that attaches to watch does not resize anything unless it is alone.
When the owner leaves, the most recently active client inherits. A phone
opening a terminal read-only never shrinks the laptop's view.

Rendering a distinct viewport per client would mean server-side terminal
emulation per device, which is a heavier machine than the problem deserves.

## Transcripts are capped, scrollback is smaller still

The in-memory scrollback is a bounded ring. The transcript on disk is capped
at 8 MiB per thread (`MAX_TRANSCRIPT_BYTES` in `boite-core/src/transcript.rs`)
and goes with the thread when the thread goes. A server running many agents
does not accumulate unbounded logs; it accumulates at most the cap times the
thread limit, which is a bounded number you can compute for your
configuration.

## `terminal` scope is a shell, and the docs say so in those words

Device scopes are `read`, `write`, `terminal`, `approve`, `admin`, and
`terminal` is deliberately not implied by anything: a PTY is arbitrary code
on the machine, not a change to a project, so a device paired to rename
projects does not come away with a shell. The server README carries the
threat model. Scopes are per device, not per project, because a Boite server
is one person's machine today; per-project scopes are on the list for the day
that stops being true.

## No CPU or RAM quotas per thread

The limits that exist are structural: 200 threads, 64 connections. What a
thread's processes then do with the machine is left to the operating system,
because Boite runs on your machine, next to your editor and your browser,
and a resource governor competing with the OS scheduler is enterprise
plumbing a desktop tool should not carry. If a build is eating the machine,
you can see which thread is doing it, which is the part Boite is actually
for.

## The git panel and the editor are not scope creep

Boite is mission control for coding agents; the multiplexer, the git panel
and the editor are what supervision requires. Judging an agent's work means
reading its diff, and reading a diff should not mean leaving the window where
the agent is still typing. Everything in the UI answers one question, "what
are my agents doing and is it any good", and features that do not answer it
do not go in.
