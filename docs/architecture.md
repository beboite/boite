# Architecture

## The core is the host, the shell is a client

The core is a normal process in the user's session, never a Windows service:
DPAPI, the OAuth callback on `127.0.0.1` and the user profile are all
unreachable from session 0. Execution stays on the machine that owns the folder.
The shell starts a local core and adopts one that already answers, and it can
point at a core on another machine instead; the phone only ever points at one.
On Windows the shell holds a local core it starts in a `KILL_ON_JOB_CLOSE` Job
Object, so a hard shell exit also stops that core. Adopted and remote cores are
not owned by the shell and remain running. The shell also carries a channel, read once from its own
bundle identifier: `Boite` and `Boite Dev` are two installs on one machine, and
the channel is what keeps their data directories, and so their cores, apart.
[docs/releasing.md](releasing.md).

## One WebSocket, one contract

JSON-RPC 2.0 over a single WebSocket at `/rpc`. Two checks guard it, both from
the first commit: the `Origin` header must be absent (a native client) or one of
the shell origins or the core's own, then the first frame must be `hello`
carrying the core token within five seconds, or the socket closes with `4001`.
Owners can add exact browser origins in Machines for connections to multiple
cores. Each socket still requires authentication.
The token is 32 random bytes generated on first start and kept in
`<dataDir>/core.json` beside the port and the pid.

Broadcast events (`project.*`, `settings.updated`, `providers.*`, `accounts.*`)
reach every authenticated connection, so a second shell or a phone follows a
change without a reload. `message.*` and `permission.*` reach only the sockets
subscribed to that thread. A client that connects mid-turn rebuilds the pending
permission card from `permissions.list`, because `permission.requested` only
reached the sockets that existed when it fired.

## The journal is the truth, the tables are a projection

`bun:sqlite` in WAL mode. `events(id, thread_id, ts, type, version, payload)` is
append-only, and the projection tables (`projects`, `threads`, `turns`,
`messages`, `processes`, `accounts`, `settings`) are updated in the same
transaction as the event that changes them. Every event type carries a version.
Text deltas are coalesced per thread every 16 ms before they reach SQLite or a
socket. The provider transcript is never remodelled. A thread resumes the
selected account's native `sessionId`; changing accounts starts a fresh session
with bounded journal excerpts. Each accepted turn freezes its execution target,
so a later picker change cannot redirect queued work.

## The scheduler counts turns, not threads

`maxConcurrentTurns` defaults to 6 and `perAccountConcurrency` to 2. A turn past
the cap is `queued`, visible as queued, and started in order. A thread is not a
process: a process exists only while a turn runs, unless `warmProcessMinutes`
lets a driver keep its own one for the next turn. Raising the global cap alone
changes nothing when every thread shares one account, which is the shape of the
bench.

## Process tracking follows the host OS

`procs.ts` calls the platform interface for native tracking and protections.
The Windows backend and the shared Linux/macOS fallback live under
`packages/core/src/platform/`; the journal and RPC stay shared.
[Trace](trace.md#platform-boundary) describes that boundary and its limits.

On Windows `procs` creates the thread's job on first use, nested in a global
`boite-agents` job, `KILL_ON_JOB_CLOSE` on both and never `BREAKAWAY_OK`, and
assigns the child right after spawn. A completion port drained in a Worker
reports every process that enters or leaves, grandchildren included, as
`process.started` and `process.exited` with pid, executable, command line, CPU
time, peak memory, bytes moved and exit code. That is exact attribution, per
thread, of a tree nobody declared. Linux and macOS track direct children only;
their `TraceCapability` reports the limited fallback. They do not discover
grandchildren or promise whole-tree termination.

Two Windows-only rules ride the same pid set, both in a second Worker and both
switchable from General settings. The focus guard sends a window of a traced pid
to `HWND_BOTTOM` without activation the moment it takes the foreground, then
gives the focus back to the window the user was on. The audio mute walks the
default render endpoint's sessions every second and mutes the ones belonging to
a traced pid, undoing it when the pid exits, because Windows keeps a session's
mute across restarts. Both decisions are pure logic classes tested on a fake of
the Win32 calls, so no test ever creates a window or plays a sound.
[docs/trace.md](trace.md) has the caps and the settings.

## Five drivers, one interface

`Driver.startTurn(ctx) -> TurnHandle`, and the driver's whole job is mapping one
protocol onto the contract's parts. What they share: one process and one agent
session per thread, kept warm across turns where the protocol allows it; a
permission question drawn as the same inline card whatever asked it; a stop that
is the protocol's own cancel; usage folded onto the turn, with a real price only
where the wire carries one; and a lazy module, so a driver nobody used costs
nothing at start.

Where they differ is worth knowing before you touch one. `claude-sdk` runs the
Claude Agent SDK with a `PreToolUse` hook as the single gate that journals and
decides every tool call. `acp` speaks the Agent Client Protocol over the agent's
stdio and sends the thread's permission mode as `session/set_mode`, matching the
agent's own spelling out of a candidate list, because ACP standardises the call
and never the ids. `codex-appserver` carries its own ndjson JSON-RPC peer, since
OpenAI ships the protocol as generated TypeScript rather than a client, and its
permission mode is part of the session key: Codex takes the approval policy and
the sandbox when the thread opens and has no call that changes them later. `pi`
takes its session on the command line rather than through a call, so the driver
mints the id itself. `echo` streams the prompt back, can call a fake tool, ask a
permission and spawn a child on request, and never touches the network.

## Descriptors, tokens, managed installs

A provider is JSON, not code, so adding an ACP agent is a file rather than a
release. `{home}`, `{appdata}` and `{agentsDir}` expand when the descriptor
loads, in `roots`, in every executable candidate and in `launch.args`, which is
what lets a descriptor name a script rather than a program. `{isolationDir}` is
not a load-time token: it is per account and substituted at spawn. A descriptor
that names an `install` block is one Boite downloads itself: the zip is streamed
to disk with its sha256 computed as it writes, a wrong digest or length is
refused with both values, only the files the descriptor lists are unpacked, and
`current` is repointed once `.install-complete.json` is beside them. Field by
field, with an example: [docs/providers.md](providers.md).

## Accounts and isolation

An account is a descriptor plus a directory, and the descriptor's `isolation`
map is what makes one login blind to the others. An account on the provider's
own default location is the user's real CLI login: Boite reads it, reports it,
and refuses to run a login command for it, because that login belongs outside
Boite. For an isolated account the descriptor's `login` block runs through
`procs.spawnPiped` under the synthetic thread `login:<accountId>`, so it sits in
a Job Object and in the trace like any agent process, and its output streams back
line by line with the first link it prints carried separately.
[docs/accounts.md](accounts.md).

## The probe, because an agent owns its models

A descriptor's model list is a starting point. A Claude, ACP, Codex or pi agent owns the
real one, so `providers.probe` spawns one short-lived process under the synthetic
thread `probe:<providerId>:<accountId>`, asks the protocol's own models call,
kills the child on every path, and caches the answer per provider and account
until `providers.reload`, a manual refresh or a change to that account. The UI
keeps a persistent display cache while it reads models asynchronously. `threads.create` and
`threads.update` accept what the last probe listed on top of the descriptor's;
a model nobody probed is refused, saying to open the picker. Two callers at once
share one process, and `providers.probed` lets a second client see the same
answer. A probe that finds no executable, whose agent dies, or that passes twenty
seconds throws with the reason and caches nothing.

## The UI streams, and stops streaming

Each machine owns its client and Store. Route actions through the owning Store;
project and thread IDs can collide across machines. Only the open thread on the
visible machine streams. The rest of the list lives on `thread.updated`
summaries. Inside a message, the markdown of a streaming part is rebuilt at most
every 48 ms rather than on every token, and a tool card opens on its own while
the model is still typing its input, then folds back once the parsed input lands.
Past sixty messages the timeline renders a window: the slice that meets the
viewport plus eight messages of overscan each way, two spacers carrying the
summed heights of the rest, every message worth 80 px until a `ResizeObserver`
measures it, and a height measured above the reading point put back into
`scrollTop` so the viewport never jumps. Under sixty, the list renders whole.
The transport sits behind one `Client` interface, so the same UI runs on the real
core, on a WebSocket to a remote core, and on an in-memory fake.

## The phone keeps the app

`packages/ui/public/sw.js` is plain JavaScript that Vite copies untouched, one
cache, registered after the first paint and only on the core's own http(s)
origin. A navigation is network first with the precached shell behind it,
`/assets/` is cache first, and `/rpc`, any upgrade, the worker and the manifest
are never cached: the socket is the only thing carrying live state. The core
serves the shell, the worker and the manifest as `no-cache` and the hashed
assets as immutable for a year. What a phone gets with the core asleep is the
shell painting from disk and "Connecting" in the footer until the socket comes
back. [docs/phone.md](phone.md).

