# Architecture

## The core is the host, the shell is a client

The Bun core owns execution, accounts, scheduling and persistence on the machine
that owns the project folder. The Tauri shell owns windows, tray integration,
native dialogs, desktop updates and local core startup. The Svelte UI connects
to a local or remote core. The [phone client](phone.md), including the
[Android client app](android.md), connects to an existing core. The separate
[Android server](android-server.md) runs a core and agents on the phone in
Termux.

A desktop core runs in the user's session. Windows session 0 cannot use the
user's DPAPI state, OAuth loopback callback or profile. Local cores are resident
by default: quitting the shell leaves work running until an owner calls
`core.shutdown`. Tests can set `BOITE_CORE_RESIDENT=0`; on Windows that mode
keeps the shell's `KILL_ON_JOB_CLOSE` Job Object. Adopted and remote cores remain
independent. [Bots](bots.md) describes background work.

The shell passes `--data-dir` and adopts a local core only when its PID is alive
and `/health` reports the shell's version. Split JavaScript bundles must also
match the SHA-256 captured at core startup. A mismatched core is stopped through
`POST /shutdown` and replaced. Startup failure includes the last output lines.
A resident core still starting after 60 seconds stays alive for the next endpoint
request. After four seconds without a local response, the UI asks the shell to
resolve the core again. A start that fails again, for example on a full disk, is
asked after 8, 16 and 32 seconds, then every minute, until a core answers; the
error toast gives the shell's reason meanwhile.

The shell's bundle identifier selects the stable or dev data directory. Stable
and nightly update tracks share the regular installation's data; Boite Dev is
separate. Desktop updates use main-webview-only IPC and signed installers on the
local machine. See [updates](updates.md), [restart handoff](restart-handoff.md)
and [release layout](releasing.md).

## One WebSocket, one contract

The core serves JSON-RPC 2.0 at `/rpc`. The `Origin` must be absent for a native
client, a permitted shell origin, the core's own origin, an origin a machine of
its [group](groups.md) gives or is served at, or an exact origin the owner added
under Advanced. The origin check only keeps arbitrary websites out: the first
frame must still be `hello` with an accepted credential within five seconds, or
the socket closes with `4001`.
The owner token is 32 random bytes generated on first start and stored in
`<dataDir>/core.json` with the port, PID and start time, and on Linux a start
key: the boot id and the start in clock ticks since boot. The shell takes a
live PID for another process that got the number, not for the core, when its
start key differs (Linux) or when it started more than two seconds after that
time (Windows, macOS). The Linux start time follows every step of the wall
clock, so it is never compared there. `core.lock` carries the same key.

| Principal | Credential and authority |
| --- | --- |
| Owner | Core token, a group ticket from a member, or an owner pairing; may configure the core |
| Session | A device of the group, signing with its own key; limited to `DEVICE_METHODS` and `DEVICE_EVENTS` |
| Agent | In-memory per-thread token supplied to a launched process; limited to `AGENT_METHODS` and its authenticated thread |

`hello` also names the client and, optionally, its `device`: the shell sends
the computer's name, which its own core reported, and the web app sends `phone`
or `browser`. Only the shell and the web app of the owner or a paired device
count. A prompt they start with `turns.start` keeps that origin on its text
part as `sentFrom`, which the UI does not show. Before the prompt the core adds
one line telling the agent where it came from, such as `[Boite: the user sent
this from the Boite desktop app on the computer "office-pc". ...]`. It says
this when the agent session starts and when the origin differs from the
previous prompt that had one, not on every turn. Turning off the Boite guide
turns it off too. A shell on the loopback that
names no device is given the core's hostname. The name is whatever the client
said, so it is information for the agent and never grants anything.

Device and agent event lists live in `packages/contracts/src/access.ts`; agent
method reasons live in `packages/core/src/access.ts`. New methods remain
owner-only unless the access lists explicitly permit them. The router and
[in-memory client](development.md#contract-scenarios) enforce the same contract.
The [CLI](cli.md) uses the agent credential inside a thread.

Project, settings, provider and account changes reach authenticated connections
allowed to receive them. Message, permission, question, panel, process and
activity events are scoped to subscribed threads as well as principal access.
Questions from bots' threads also reach owner and paired-device
clients without a subscription, so an agent's row and desk see a card the user
must answer.
Subscribing does not prepare a provider session. A reconnect reads pending cards
from `permissions.list`; an answered, ended or withdrawn request leaves the list
and emits `permission.resolved`. Driver cancellation withdraws the card instead
of leaving an unanswered request behind.

## The journal is the truth, the tables are a projection

`bun:sqlite` uses WAL mode with SQLite's automatic checkpoint off
(`journal/wal-checkpoints.ts`). A Worker with its own connection, started at
the first checkpoint after a write, runs a passive checkpoint once the WAL
passes 4 MiB and truncates it after 30 s without writes. The main thread
checkpoints when the Worker is unavailable or when the WAL reaches 16 MiB
because writes kept landing during the Worker's passes, and it truncates the
WAL at close. A write that binds more than 64 KiB, such as a message's parts,
runs on a statement finalized after use (`journal/statements.ts`): a cached
statement keeps its last bound values alive. An append to
`events(id, thread_id, ts, type, version, payload)` and its projection changes
commit in one transaction. Events have versions but are not replayed to rebuild
the tables. Retention runs one minute after startup and daily. Its first ticks
build the planner statistics a migration left missing, one `ANALYZE` per indexed
table that has none, reading about 400 rows per index; the open itself analyzes
nothing. It then deletes events older than 30 days in paced batches while
retaining the latest agents revision, and after each prune it rebuilds the
statistics that prune made stale, the same way.
An event-retention error keeps the pending statement and pass state for a
retry after 30 s. Waiting for the WAL to catch up uses the same delay before
any statistics or pruning work, without changing the batch size. Stopping
retention or closing the journal prevents further ticks.
Project removal explicitly clears thread-keyed tables; foreign keys are disabled.
A newer journal schema is refused before writing, with the file and both versions.

`message.part` and `artifact.published` events are not written: the message row
holds the content and nothing reads them back. Those already stored, from
before schema 37, are kept 3 days; retention walks them forward from the
`events:trail-pruned-through` setting. Event ids are rowids that SQLite hands
out again once the newest events are deleted, so every deletion of events
brings that cursor back to the last id in the same transaction. `message.started` keeps only the first
1,024 characters of each string. The types that are read back (`question.asked`,
`question.answered`, `thread.memory`) keep their whole payload and have partial
indexes, so startup and a thread open no longer scan the events table.

The blur a deferred picture is drawn with before its bytes arrive is a
`media_previews` row, keyed by message and part, and the light WebP copy the
timeline draws is a `media_displays` row, both with no event: they are made
again from the message when missing ([performance](performance.md)).

A tool output of 4 KiB or more, and a tool input text, file or image of 32 KiB
or more, is stored in `part_blobs`, one row per value, and its part in the
message row names it under `$blob`. A value UTF-8 cannot hold as it is (an
unpaired surrogate) stays inline, where JSON keeps it as an escape. A value is stored as zstd (`codec` 1) when
that saves at least 5 %, else as text (`codec` 0); `chars` holds its length in
characters, and a compressed tool output keeps its first 1,024 characters as
text in `preview`. Journal reads put the values back. A page asked with
`compactTools` reads whole a finished tool's output of up to 16 KiB; past that
it reads only `preview` (or the first 1,024 characters of a text value), and
sends them only for a call that failed or was refused; its resume proof hashes
a digest of the whole value. A streaming message stores only the
parts that changed since its last committed write, and a value whose digest
matches the stored one is not written again. Rows written before schema
31 kept their values inline, and before schema 37 kept tool outputs under
32 KiB inline and every `part_blobs` value as text. Three minutes after startup
the core brings them to the current shape in ticks 250 ms apart
(`journal/retention.ts`): it moves values one message per tick, then outputs
and recodes `part_blobs` rows, pauses while a message streams, and records
where each pass stopped in a setting (`part-blobs:moved-through`,
`part-blobs:outputs-moved-through`, `part-blobs:recoded-through`). A finished
pass is never scanned again. Each step sizes its batch to the time its last
tick took, aiming at 40 ms, and compresses on Bun's thread pool
(`Bun.zstdCompress`) before a write guarded on the row it read, so a write
made meanwhile wins, and a row is written only under the id and thread it was
read with. A tick is skipped while the WAL is over twice its 4 MiB limit, so
the passes give the checkpoints room before the WAL reaches 16 MiB, where the
main thread checkpoints it. The check comes before a tick, not during it: a
tick that writes more than the room left, such as one value larger than its
byte budget, can still cross that mark. The idle truncation empties the WAL
with no further write, on the Worker or on the main thread without one.

A new journal is created in incremental auto-vacuum, so it gives free pages
back from its first compaction ticks. A journal created before that gets its
space back once. When every one-time pass has finished and
the trace was cut once, the next core start checks the journal before opening
it (`journal/vacuum.ts`): with free pages over a quarter of the file and over
256 MiB, and room on the volume for the live pages plus 512 MiB, it writes
`core.starting.json`, copies the journal with `VACUUM INTO` in incremental
auto-vacuum, checks the copy, syncs it and renames it over the journal. The
shell waits past its start timeout while that file names a live core, the run
that wrote it by pid and start as for `core.json` (a crash leaves the file,
and a later process may get the pid), and a whole timeout after it last saw
the file, since the core still opens its journal before it writes
`core.json`. A core another shell started that exits during that work is
replaced at once. The
window says the history is being compacted. From then on the compaction ticks
give free pages back with `PRAGMA incremental_vacuum`, down to 16 MiB kept for
later writes, and no VACUUM is needed again. The VACUUM runs before the
journal opens because its copy takes the journal's place: `VACUUM INTO` reads
one snapshot, so a copy made beside a live core would leave out the writes
committed while it ran. A VACUUM that does not finish (an
error, a kill) leaves the journal as it was and its attempt in
`journal.vacuum-failed.json`: a later start tries again only a day after the
last attempt, three attempts in all, so a failure that repeats does not cost
every start the whole copy. A file cut short counts as one attempt made when
it was last written, and an attempt dated after the clock (set back since)
counts from that start. A VACUUM that took the journal's place removes the
file.

A process trace row names its command line through `command_lines`, which holds
each distinct line of a thread's trace once, found by thread and an xxHash64
digest. Keyed by thread, a line goes with its thread: removing a thread, a
project or an incognito conversation deletes its lines in the same
transaction, and a line another thread also ran stays as that thread's own
row. Schema 36 moves the lines of older rows there in paced batches. The same
background passes cut a thread's trace back to what it keeps once it holds 500
rows past the 2,000 it keeps, one thread at a time and again daily, and delete
the lines only the deleted rows named ([trace](trace.md)).
A daily-prune date ahead of the current clock is removed before a pass resumes
from its stored cursor. The date stays absent during the incomplete pass;
completion records the current time and removes the cursor.

`native_agent_messages` names the messages holding an Agent, Task or subagent
call, or a `nativeAgents` list, so `delegation.get` parses those messages only.
Schema 31 fills it once from the stored parts; writes keep it current.

Text deltas coalesce per thread every 16 ms. Streaming message parts stay in
memory and overlay stored rows on reads. Writes normally happen at most every
500 ms, adapt to slow storage up to 5 seconds, and also happen on completion,
turn end, explicit persistence and close. A timed write puts only the changed
parts in `streaming_parts`, one row per part; the message row is written whole
on completion, at turn end, at close and every 30 seconds while the message
streams, so a raw SQL reader of `messages.parts` lags by up to 30 seconds. At
startup the core folds any `streaming_parts` rows a stopped core left into
their messages. While writes succeed, a crash can lose the last write window. Failed background writes retain dirty parts and retry
with exponential backoff up to 5 seconds. Buffered deltas for completed messages
are dropped after three failed flushes, with a diagnostic. Thread activity is a
settings row; detected project icons are derived rows that can be rebuilt.

Terminal persistence retries independently of provider execution. The scheduler
keeps the turn until its terminal transaction commits, retaining the original
result and publishing completion once. A changed execution identity prevents a
late result from overwriting a replacement turn or session. Shutdown ends this
retry; startup applies the normal recovery rules to any unfinished rows.

Threads marked done, including automatic archives after a PR merge, record a durable
`doneAt` date. `threadDoneRetentionDays` defaults to 3 days; 0 disables automatic
deletion. Startup and minute passes delete expired idle families through the normal
recoverable deletion flow. Restore cancels expiry, and a later Mark done starts a
fresh delay. Manual and legacy archives without a done date remain conserved.
Paired phones can mark done under the owner's retention policy and delete a
conversation with its undo; the deleted list and policy changes stay owner-only. Cleanup preserves the done date until its
recoverable deletion record commits, so interrupted cleanup can retry after restart.

Deletion stops a conversation and its children before hiding them behind durable
markers. Restore retains history and previous archive flags without restarting
agents. The default deletion retention is 30 days; `threadDeletionRetentionDays`
accepts 0 to 3650, with 0 disabling automatic purge. Startup and minute passes
purge expired families transactionally. Reads and restoration also check expiry.
Project removal purges its pending deletions. Files, worktrees and branches
stay on disk; the
[settled worktree cleanup](development.md#settled-worktree-cleanup) later removes
a deleted thread's worktree when nothing in it would be lost. See
[thread lifecycle](development.md#thread-lifecycle).

A purge, and the erase of an incognito conversation, also removes the native
transcripts of a Claude account Boite isolated itself
([accounts](accounts.md#transcripts-boite-removes)): every session the thread
and its turns named, that no remaining thread names (a fork can resume its
source's session). The user's own `~/.claude`, and any directory Boite did not
make, keep theirs. Other providers' transcripts and a removed project's threads
stay on disk. On 2026-10-17 a desktop core's isolated account held 887 Claude
sessions (5,090 MiB): 360 named by a live thread (3,892 MiB), 494 by a deleted
thread waiting for its purge (1,026 MiB, what the purge frees as those
deletions expire) and 33 by nothing (172 MiB, 0.8 MiB of it untouched for 7
days, so no sweep of older files was added), read from a read-only copy of its
journal.

Session imports probe the entered project path before its canonical path and
retain the entered path as the imported thread's working directory. Shared
transcript files appear once, with an explicit account choice when several
accounts can read them. The journal reserves current native session IDs while
conversations remain recoverable in the trash, including deleted children;
imports keep their existing global refusal of an already owned session ID.

The journal does not replace a provider's native transcript. A turn resumes the
selected account's `sessionId`. An account change starts a fresh session seeded
with bounded journal excerpts. A confirmed missing native session permits one
retry on a fresh session; other failures retain the ID. Each accepted turn
freezes its execution target, so later picker changes cannot redirect queued
work. Permission modes follow the current selection, including during a running
turn. [Model switching](model-switching.md) owns transfer and revision rules.

File checkpoints live beside the journal, not in it: `checkpoints/<thread>/`
holds one zstd manifest per turn and hard links into the content-addressed
store `checkpoints/objects/`, whose blobs are zstd frames named by the SHA-256
of their original bytes (`threads/checkpoint-store.ts`). Each thread keeps the
newest 50 turns, and none once archived or done for 7 days; a background pass
moves older layouts to this one and collects unlinked blobs
([context](context.md)).

## The scheduler tracks independent turns

Independent conversations start immediately, including on the same account.
There is no global or per-account interactive turn ceiling. A conversation has
one in-flight turn and can stay queued while its account is being configured or
its team is paused. Process resource guards are separate from admission.

Stop is accepted from the start of turn setup, including while entering a
delegated worktree. A stop received there is retained through setup and settles
the turn as stopped before its first code checkpoint or native preparation.
If Stop kills a preparation process and worktree entry rejects, the turn still
ends stopped. A preparation failure without an accepted Stop remains an error.
A delegated worktree records its base before mutation and reserves its ref with
an atomic ownership reflog, as draft preparation does. If Stop preceded that
transaction, a pending retry reserves the still-absent ref at its saved base,
not the parent's later HEAD. Read errors and foreign refs are refused.
Preparation registers the worktree without checkout. Git builds a missing
index in an exclusively allocated temporary directory; after Git exits, the
core publishes it synchronously under the ordinary exclusive index lock.
Stop can therefore kill Git without stranding a lock on the shared index.
An existing index or foreign lock stays untouched. Recovery accepts only
the owned ref and registered path and checks out absent indexed files without
overwriting existing edits, notes or staging.
The accepted input remains in history, and the next turn starts normally.

After an unplanned restart, an ordinary queued prompt that never started stays
held with its original turn, input receipt and execution selection. Desktop and
phone offer Resume and Discard through `turns.recover`; neither creates a second
input. Work that may already have reached a provider is never replayed by this
recovery path. Explicit restart handoff keeps its own authorization rules.

A turn a provider refused for availability retries at capacity within the same
turn, or, with `autoResumeLimitedThreads`, resumes after a usage limit's reset
from a plan journalled under `limit-resumes`; `ThreadSummary.retry` shows
either ([usage](usage.md#when-a-provider-refuses-a-turn)). Any other turn that
stops before its answer (an error, a crash, a compaction, background work that
ended without waking the agent) resumes by itself from a plan journalled under
`auto-continues`, twice in a row at most
([restart handoff](restart-handoff.md#turns-that-stop-before-their-answer)).

Owner and paired-device connections name one visible conversation through
`threads.focus`. Claude, Codex, ACP, pi and Muse can prepare their traced process
and native session before a prompt, without creating a turn, message or model prompt.
Viewed sessions stay ready across completed turns even when
`warmProcessMinutes` is zero. The last viewer leaving starts a 30-second grace,
extended by a longer configured warm period. Hidden pages and machine or phone
navigation release focus. Preparation uses the normal account isolation and
install leases; failure is logged and a later prompt can start normally.

A visible draft with text or attachments reserves its final directory or
worktree through `drafts.prepare`. Each connection holds one invisible workspace;
the reservation expires after ten minutes. No prompt text, turn or conversation
is published during preparation. `threads.create` adopts a matching reservation
and can subscribe before answering, allowing the first turn to start while the
UI hydrates its conversation. Late snapshots preserve newer streamed messages,
turns and summary updates. Selection changes, abandonment and disconnect release
the native session and reserved workspace. Older cores use ordinary creation.
Private ownership intent is journalled before creating a reserved folder or
worktree. Startup recovery preserves published conversations and retries cleanup
of abandoned reservations. Active reservations and pending cleanup share limits
of four per connection and 32 globally; failed cleanup keeps its ownership intent.
Reserved git operations have a ten-second deadline. Expiry stops the reservation's
registered process group or Windows job and allows up to three seconds to drain
inherited pipes before cleanup. A reserved branch is created atomically with an
ownership reflog entry. Rollback checks that entry and the branch registered at
the checkout path before overriding its initialization lock; a competing branch,
checkout and its commits remain untouched.
Cleanup failures preserve the original creation error and are logged. During
shutdown, draft and upload cleanup failures do not prevent process or journal
closure; retained ownership remains available for recovery.

Checkpoint capture and native preparation can run together, but prompt dispatch
waits for the checkpoint. This transient preparation does not extend post-turn
retention. Stop or checkpoint failure releases it before a prompt can leave.

Attachments selected in the composer upload through connection-owned leases.
Completed upload IDs replace only the wire bytes when sending; durable drafts
retain the original bytes. The core validates ownership, metadata and SHA-256
before restoring the original attachment for validation and journaling. Leases
expire after ten minutes, have per-connection and global byte/count budgets, and
are removed on release, disconnect or shutdown. Expired references retry inline
with the same input receipt. Upload instances record their owning process before
writing bodies. Startup removes only instances whose recorded owner is proved
dead, including reuse of the current PID with a newer start identity. Live owners,
unavailable identities, other hostnames and unknown legacy directories remain
untouched: a local process probe cannot establish another host's owner is dead.
Rejected uploads retain their selected entry, so typing does not retry them.
Sending uses the original bytes; deselecting and reselecting permits a new upload.

## Delegation shares the scheduler

Ordinary conversations start with delegation enabled and the built-in
`conversation` route: the current harness, account, model and effort. Only an
owner can add named routes or change the setting. Children are ordinary threads
with separate native sessions, a durable parent relationship and the parent's
checkout and permission mode. Briefs and bounded results cross the relationship;
transcripts and tool output stay with the child.

[Delegation](delegation.md) owns child lifecycle, delivery and usage limits.
[Workflows](workflows.md) execute checked plans over the same scheduler. They
need no enabled delegation team or extra orchestration model, but a paused team
holds launches. Output corrections remain durable waiting executions until the
runner can admit them after the preceding turn settles.

## Process tracking follows the host OS

Every process starts through `procs.spawn`, `procs.spawnChild` or
`procs.spawnPiped`. `ProcessPlatform` owns native tracking and protection under
`packages/core/src/platform/`; drivers and RPC handlers do not import backends.
The shell has its own native boundary under `apps/shell/src-tauri/src/platform/`.

Windows Job Objects provide tree membership events and resource caps. Linux and
macOS record direct children; their process-group termination cannot catch a
child that starts its own session. The capability report exposes those limits.
[Trace](trace.md#platform-boundary) owns process records, caps, guards and shutdown.

## Drivers, one interface

Brain skills marked `disable-model-invocation: true` stay out of the model catalog; the core expands a leading `/<name>` into their body before recording and delivering user input, unless the driver advertises that command.

`Driver.startTurn(ctx)` returns a `TurnHandle`. A driver maps its protocol to
contract message parts, questions, approvals, usage and session lifecycle.
Drivers load lazily. Stop uses the native cancel operation where available; the
core ends processes after 10 seconds and settles a remaining turn 2 seconds
later. Protocol-specific deadlines can be shorter.

| Protocol | Runtime owner |
| --- | --- |
| `claude-sdk` | Claude SDK query, tool gate, hook reports and native session |
| `acp` | ACP initialization, session modes, updates and cancellation |
| `codex-appserver` | Codex JSON-RPC peer, process/session key and turn notifications |
| `muse` | MSP envelope, host sandbox flags and session approval mode |
| `pi` | JSON-line commands, CLI session ID and `agent_settled` completion |
| `echo` | Deterministic in-process fixture with no network calls |

Codex, Muse and pi share `drivers/stdio.ts` for bounded framing and pending
request lifetime. Each adapter owns its envelopes; each session owns its active
turn and child. A fatal pipe fault closes the transport and rejects pending
requests once, then retires only that session. Late output from a retired child
cannot settle its replacement. User Stop takes precedence over a subsequent
fault. Long-running model requests do not acquire a default request timeout.
[Providers](providers.md) owns protocol details and control-read deadlines.
Permission changes use native setters when available. Agents with launch-time
permissions interrupt and resume within the same Boite turn, retaining the
execution target and accumulating usage across attempts.

`TurnRunner` admits visible turns and publishes their completion after
`settleTurn` commits local state. `TurnAttempts` owns native
handles, retries, live controls, stop timers and reported usage. Both read the
same execution snapshots after a retry replaces them. Provider and account
resolution stays with admission.

Blocking questions hold a turn in `waiting`. Asynchronous questions leave work
running and deliver an answer through steering or a later prompt. Skip resolves
a card without inventing an answer. Incoming user input or an asynchronous answer
splits the assistant message at its arrival; earlier running tools finish in
the earlier message. Claude background work can keep a session alive after its
foreground turn and later open a background-completion turn.

A turn Boite opens by itself (background completion, delegation or
coordination mail, restart resume, automatic compaction) carries on the user's
last request (`continuesRequest`). Elapsed time counts from that request's
first turn: `requestStarts` for a chat summary, `ThreadSummary.requestSince`
for a sidebar row while the agent works or monitors. A shell left running keeps
its own start, and a compaction its own duration.

Native task observations persist with the provider, session generation and
originating turn. `threads.get` carries the newest 100; the chat lists
none of them and names only the tasks still running in the turn summary. A missing live task is marked ended, not
successful; explicit provider outcomes can complete it later. Session release
and core restart record cancellation without trying to adopt or restart native
work. Delayed callbacks cannot change another session's observations.

`/btw` asks a tool-free side question over a frozen transcript excerpt. It does
not steer the main turn or append its answer to the journal. A pending request
expires after 90 seconds; at most 64 completed answers stay available for ten
minutes. Fork persists the frozen context, question and answer in a new thread.
Cancellation releases only its current request; a late completion cannot replace
another answer. Pending requests block idle updater shutdown. Pending requests
and retained answers protect their conversation family from automatic archive;
manual family archive cancels them. See [side questions](context.md#side-questions).

## Descriptors, tokens, managed installs

Descriptors declare a supported protocol, executable candidates, OS profiles,
account isolation and optional managed releases. JSON can add a provider for an
existing protocol; a new protocol needs a driver. Load-time tokens and
per-account `{isolationDir}` have different lifetimes. Managed installs check
archive length, SHA-256 and listed file sizes before switching `current`.
[Providers](providers.md) is the schema and installation reference.

## Accounts and isolation

An account combines a descriptor and a login directory. Default accounts use
the user's CLI configuration; isolated accounts receive the descriptor's
environment on every turn, probe and login. Before spawning, `profile-share.ts`
links configured directories and copies files while keeping login files private.
[Accounts](accounts.md) owns login, sharing and removal; [hooks](hooks.md) owns
hook discovery and reports; [usage](usage.md) owns limits and monitoring.

## The models probe

`providers.probe` uses the agent's own discovery operation. Codex and ACP can
read through an explicitly targeted, compatible prepared session; other reads
use a short-lived traced process. Compatibility includes account, descriptor,
environment, workspace and context mode. Missing ACP effort metadata uses an
isolated probe rather than changing a prepared session's selection.
Concurrent reads share an operation; caches belong to a provider and
account. Changed descriptors or account state invalidate them, and a stale
completion cannot replace a newer cache entry. The last list of each account is
also saved in the journal and answers at once, while a fresh read runs, when the
descriptor, executable, gateway and login it was read under still stand. Disposable processes close on
every path. Background failures retain display fallbacks; explicit refreshes report
their reason. See [provider discovery](providers.md#the-models-probe).

## The UI streams, and stops streaming

Each machine owns its `Client` and Store. IDs can collide across machines.
Only the open thread on the visible machine streams; other rows use summaries.
Asynchronous reads and actions capture their client and navigation generation.
A stale thread read, trace response, page completion or folder dialog cannot
replace a newer selection or publish an error into another machine's view.
A thread creation already accepted by its original core still belongs there;
a later navigation does not redirect its prompt or overwrite the newer draft.

Streaming Markdown renders closed paragraphs. At more than sixty messages, the
timeline uses a measured window with eight messages of overscan on each side.
Unmeasured messages start at 80 px; measurements above the reading position
adjust `scrollTop`. The same UI runs on local RPC, remote RPC and the in-memory
client. [Machines](machines.md) describes connection and routing behavior.

Minor file-opening, download and clipboard errors dismiss after five seconds.
Unknown errors, connection failures and core or turn errors stay until dismissed.
Error sources explicitly mark minor failures; repeating one restarts its delay.
Switching between desktop and phone layouts preserves the current error's expiry.

## Module boundaries and complexity

Driver entry files compose protocol modules. Framing, sessions, turns, model
mapping and wire types stay separate; internal modules do not import their entry.
The server separates handshake, buffering and dispatch under `server/`; Git
separates parsing, bounded reads and diff assembly under `git/`. Git refs resolve
to object IDs before reads, and working files are sized and read on one handle.

`lib/fake-client.ts` is the in-memory socket entry. Domain handlers live under
`lib/fake-client/`, with state in `context.ts` and shared refusals in `checks.ts`.
Handlers validate inputs and results against the contract. Common
[contract scenarios](development.md#contract-scenarios) run against real and fake
cores; a fixed known divergence must leave its explicit exception list.

`bun run check:architecture` checks production runtime imports, including literal
dynamic imports. It rejects cycles, runtime cross-imports, contracts importing
runtimes, native backends imported outside their boundary and internal imports
of entry modules. Type-only imports, Svelte scripts and Rust are outside this
check. Unmapped workspace exports fail. The same check enforces 900 source lines
or a shrinking allowance in `scripts/architecture/size-budget.json`.
`bun run audit:complexity` provides an advisory ranking, not a CI threshold.
[Development](development.md#architecture-checks) owns the commands and scope.

## Agent coordination

Ordinary conversations default to communication across projects and linked
machines, subject to explicit owner restrictions and directional remote read
grants. The core owns discovery, durable inboxes and attributed delivery.
Per-thread RPC tokens identify local senders; signed Ed25519 exchanges identify
trusted remote cores. Read permissions are checked again after asynchronous
responses before returning data. Pause controls delivery without revoking an
otherwise authorized lookup. [Coordination](coordination.md) owns trust and
message semantics.

## Closing and restart

`Core.drain` shares one shutdown promise. It closes new admission and automatic
launchers before waiting for accepted turns, while sockets still deliver terminal
events. Coordination waits for owned asynchronous work; workflow callbacks are
fenced after close. `Core.close` releases drivers, logins, terminals and process
resources before disposing the bus and journal, then flushes diagnostic logs.
A restart continuation remains durable until it starts or is explicitly excluded.
[Restart handoff](restart-handoff.md) owns deadlines and recovery exclusions.

## Groups

A group is one roster every member core holds: the machines of one owner, their
public keys, addresses and the origins their pages are served at, and the
devices of the group, each with one Ed25519 key a member signed in. Members
exchange it through the signed coordination endpoint and merge it by revision.
A device says `hello` on any member with a signature made for that member; a
member's desktop app gets a signed ticket from its own core for the others.
Browser origins and coordination peers are read off the same roster. A member
listens on its tailnet address beside the one it started on. [Groups](groups.md)
describes the trust this assumes and where it stops.

## The phone keeps the app

The service worker registers after first paint on the core's HTTP(S) origin.
Navigation is network-first with a cached shell fallback; hashed assets are
cache-first. RPC, upgrades, the worker and the manifest are never cached.
An offline phone can draw the shell and reconnect when the core returns.
[Phone](phone.md) owns adding a device, secure origins and device limits.
