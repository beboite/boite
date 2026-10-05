# Architecture

## The core is the host, the shell is a client

The Bun core owns execution, accounts, scheduling and persistence on the machine
that owns the project folder. The Tauri shell owns windows, tray integration,
native dialogs, desktop updates and local core startup. The Svelte UI connects
to a local or remote core; a phone connects to an existing core.

A desktop core runs in the user's session. Windows session 0 cannot use the
user's DPAPI state, OAuth loopback callback or profile. Local cores are resident
by default: quitting the shell leaves work running until an owner calls
`core.shutdown`. Tests can set `BOITE_CORE_RESIDENT=0`; on Windows that mode
keeps the shell's `KILL_ON_JOB_CLOSE` Job Object. Adopted and remote cores remain
independent. [Persistent agents](agents.md) describes background work.

The shell passes `--data-dir` and adopts a local core only when its PID is alive
and `/health` reports the shell's version. Split JavaScript bundles must also
match the SHA-256 captured at core startup. A mismatched core is stopped through
`POST /shutdown` and replaced. Startup failure includes the last output lines.
A resident core still starting after 60 seconds stays alive for the next endpoint
request. After four seconds without a local response, the UI asks the shell to
resolve the core again.

The shell's bundle identifier selects the stable or dev data directory. Stable
and nightly update tracks share the regular installation's data; Boite Dev is
separate. Desktop updates use main-webview-only IPC and signed installers on the
local machine. See [updates](updates.md), [restart handoff](restart-handoff.md)
and [release layout](releasing.md).

## One WebSocket, one contract

The core serves JSON-RPC 2.0 at `/rpc`. The `Origin` must be absent for a native
client, a permitted shell origin, the core's own origin or an exact browser
origin the owner configured in Machines. The first frame must be `hello` with
an accepted token within five seconds, or the socket closes with `4001`.
The owner token is 32 random bytes generated on first start and stored in
`<dataDir>/core.json` with the port and PID.

| Principal | Credential and authority |
| --- | --- |
| Owner | Core token or owner pairing; may configure the core |
| Session | Paired-device token; limited to `DEVICE_METHODS` and `DEVICE_EVENTS` |
| Agent | In-memory per-thread token supplied to a launched process; limited to `AGENT_METHODS` and its authenticated thread |

Device and agent event lists live in `packages/contracts/src/access.ts`; agent
method reasons live in `packages/core/src/access.ts`. New methods remain
owner-only unless the access lists explicitly permit them. The router and
[in-memory client](development.md#contract-scenarios) enforce the same contract.
The [CLI](cli.md) uses the agent credential inside a thread.

Project, settings, provider and account changes reach authenticated connections
allowed to receive them. Message, permission, question, panel, process and
activity events are scoped to subscribed threads as well as principal access.
Subscribing does not prepare a provider session. A reconnect reads pending cards
from `permissions.list`; an answered, ended or withdrawn request leaves the list
and emits `permission.resolved`. Driver cancellation withdraws the card instead
of leaving an unanswered request behind.

## The journal is the truth, the tables are a projection

`bun:sqlite` uses WAL mode. An append to
`events(id, thread_id, ts, type, version, payload)` and its projection changes
commit in one transaction. Events have versions but are not replayed to rebuild
the tables. Retention runs one minute after startup and daily, deleting events
older than 30 days in batches of 5,000 while retaining the latest agents revision.
Project removal explicitly clears thread-keyed tables; foreign keys are disabled.
A newer journal schema is refused before writing, with the file and both versions.

Text deltas coalesce per thread every 16 ms. Streaming message parts stay in
memory and overlay stored rows on reads. Writes normally happen at most every
500 ms, adapt to slow storage up to 5 seconds, and also happen on completion,
turn end, explicit persistence and close. While writes succeed, a crash can lose
the last write window. Failed background writes retain dirty parts and retry
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
Project removal purges its pending deletions. Files, worktrees, branches and
native provider transcripts stay on disk. See
[thread lifecycle](development.md#thread-lifecycle).

The journal does not replace a provider's native transcript. A turn resumes the
selected account's `sessionId`. An account change starts a fresh session seeded
with bounded journal excerpts. A confirmed missing native session permits one
retry on a fresh session; other failures retain the ID. Each accepted turn
freezes its execution target, so later picker changes cannot redirect queued
work. Permission modes follow the current selection, including during a running
turn. [Model switching](model-switching.md) owns transfer and revision rules.

## The scheduler tracks independent turns

Independent conversations start immediately, including on the same account.
There is no global or per-account interactive turn ceiling. A conversation has
one in-flight turn and can stay queued while its account is being configured or
its team is paused. Process resource guards are separate from admission.

After an unplanned restart, an ordinary queued prompt that never started stays
held with its original turn, input receipt and execution selection. Desktop and
phone offer Resume and Discard through `turns.recover`; neither creates a second
input. Work that may already have reached a provider is never replayed by this
recovery path. Explicit restart handoff keeps its own authorization rules.

Owner and paired-device connections name one visible conversation through
`threads.focus`. Claude and Codex can prepare their traced process and native
session before a prompt, without creating a turn, message or model prompt.
Viewed sessions stay ready across completed turns even when
`warmProcessMinutes` is zero. The last viewer leaving starts a 30-second grace,
extended by a longer configured warm period. Hidden pages and machine or phone
navigation release focus. Preparation uses the normal account isolation and
install leases; failure is logged and a later prompt can start normally.
Other drivers retain their post-turn lifecycle.

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
| `agy` | Stream-json print mode, conversation resume and launch flags |
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

Native task observations persist with the provider, session generation and
originating turn. The UI shows the latest 100 observations separately from
Boite's delegated conversations. A missing live task is marked ended, not
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

`providers.probe` uses a short-lived traced process and the agent's own discovery
operation. Concurrent reads share an operation; caches belong to a provider and
account. Changed descriptors or account state invalidate them, and a stale
completion cannot replace a newer cache entry. The process is closed on every
path. Background failures retain display fallbacks; explicit refreshes report
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

A group is one roster every member core holds: the machines of one owner,
their public keys and addresses, and the devices paired with them. Members
exchange it through the signed coordination endpoint and merge it by revision.
A client of one member gets a signed ticket for another, which that one
exchanges at `hello` for a session of its own; browser origins and coordination
peers are read off the same roster. A member listens on its tailnet address
beside the one it started on. [Groups](groups.md) describes the trust this
assumes and where it stops.

## The phone keeps the app

The service worker registers after first paint on the core's HTTP(S) origin.
Navigation is network-first with a cached shell fallback; hashed assets are
cache-first. RPC, upgrades, the worker and the manifest are never cached.
An offline phone can draw the shell and reconnect when the core returns.
[Phone](phone.md) owns pairing, secure origins and device limits.
