# AGENTS.md

What is easy to break here without a check failing, and the file that owns each
rule. Machine connections and thread views: [docs/machines.md](docs/machines.md).
What Boite 2 is, the stack and the build commands: [README.md](README.md).
Running the core and the UI, the fake client, the tests and the captures:
[docs/development.md](docs/development.md). Writing or reading a provider
descriptor: [docs/providers.md](docs/providers.md). Isolation directories and
logins: [docs/accounts.md](docs/accounts.md). Managed plugins:
[docs/plugins.md](docs/plugins.md). Pairing a phone:
[docs/phone.md](docs/phone.md). Job Objects, the trace and the two Windows
guards: [docs/trace.md](docs/trace.md). Cutting a build:
[docs/releasing.md](docs/releasing.md).

Everything here is a default the person asking outranks, except the section
called "Rules with no exceptions", where breaking one ships something broken
that nothing in `bun run check` or `bun run test` will notice.

## Words

- core: the Bun process that runs the agents. It owns the journal, the drivers,
  the accounts, the scheduler, the trace and the RPC server, and it is the only
  side of the system that executes anything.
- shell: the Tauri 2 desktop client. A window, a tray icon, the folder picker,
  and the code that starts a local core. No logic beyond that lives in Rust.
- UI: one Svelte 5 app, in `packages/ui`. The shell bundles it and the core
  serves it over HTTP. Same build, two hosts.
- contract: `packages/contracts/src/index.ts`. Every RPC method, every event,
  every shared type. A method that is not there does not exist.
- provider: an agent Boite can run (Claude, OpenCode, Antigravity, Grok, Codex,
  pi, and the echo fake). descriptor: the JSON file that describes one, shipped in
  `packages/core/src/providers/shipped/` or dropped by the user under
  `<dataDir>/providers/`.
- account: a descriptor plus an isolation directory. isolation directory:
  `<dataDir>/accounts/<id>/`, pushed into the agent's environment by the
  descriptor's `isolation` map so one login cannot see another. An account whose
  `isolationDir` is null runs on the provider's own default location, which is
  the user's real login.
- thread: one conversation in one folder. Its selected account owns a native
  session, never a process that has to stay alive. Changing accounts keeps the
  conversation and carries journal excerpts to a fresh native session.
  [docs/model-switching.md](docs/model-switching.md). turn: one prompt and the answer to
  it. A turn is what the scheduler counts and what a process belongs to.
- part: one piece of a message, as the contract spells it: `text`, `thinking`,
  `tool`, `permission`, `error`. A driver's whole job is turning its protocol
  into those.
- driver: the client half of one agent protocol, in `packages/core/src/drivers/`.
  Five today: `claude-sdk`, `acp`, `codex-appserver`, `pi`, `echo`.
- probe: `providers.probe`, one short-lived agent process that asks an agent for
  its own model list, because no descriptor can carry it.
- trace: every process a thread launched, with what it cost. Job Object: the
  Windows kernel object that makes that attribution exact. focus guard: the
  Windows-only rule that keeps an agent's window from stealing the foreground.

## The four ways to hurt yourself

1. Touching the real data directory or a real login. `%LOCALAPPDATA%\boite2` (or
   its Linux and macOS equivalents, and `boite2-dev` beside it once the dev
   channel is installed) holds the user's journal, projects and
   accounts, and the accounts point at real CLI logins that cost money and can
   be revoked. Every test and every bench sets `BOITE_DATA_DIR` to a fresh
   temporary directory. The opt-in live tests are the deliberate exception and
   they say so in their names.
2. Killing by pattern. Never `taskkill /IM`, never `pkill -f`, never a pid you
   found by matching `boite`, `bun`, `node` or a worktree path. The user is
   running the app while you work, and your own process carries those strings
   too. Kill a pid you captured at spawn, or call `resources.killTree`.
3. Putting the shell on the user's screen. From an agent the shell executable is
   only ever started with `BOITE_SHELL_HIDDEN=1`. The end to end suite does that
   already; a plain `tauri dev` or a bare run of the release exe raises a window
   over whatever the user was doing.
4. Editing a doc from a worktree. The private working notes under `.claude` are
   excluded from git, so an agent worktree has no copy of them. A write by
   absolute path lands in the original checkout, outside the worktree and outside
   the branch's commit. Tracked docs, this file included, are the ones a worktree
   can actually change.

## Rules with no exceptions

1. Every agent process goes through `procs.spawn`, `procs.spawnChild` or
   `procs.spawnPiped`. Never a bare `Bun.spawn`, never `child_process`. That
   launcher is what puts the child in the thread's Job Object before its first
   instruction, and what puts it in the trace, the load, the focus guard and the
   audio mute.
2. Change the contract first. A method or an event lands in
   `packages/contracts/src/index.ts` before either side implements it, and both
   sides then follow. A client and a core that disagree fail at runtime and
   nowhere else.
3. Tests and benches set `BOITE_DATA_DIR` to a fresh temporary directory. See
   the first way to hurt yourself.
4. A descriptor, a path, an origin or a token that is wrong is refused loudly,
   naming the file, the field and what was expected. Nothing is skipped in
   silence, and a rejected descriptor is still listed to the client as rejected.
5. The UI takes its colours, radii and durations from the tokens in `app.css`
   and its strings from `lib/strings.ts`. No native `<select>`, no
   `window.confirm`, no hard-coded hex.
6. Nothing heavy loads at core start. The Claude SDK costs about 69 MB and a Bun
   Worker about 31 MB, so the SDKs, the Job Object Worker and the guard Worker
   are all loaded on first use.
7. A new RPC method is the owner's until `DEVICE_METHODS` in
   `packages/core/src/access.ts` says otherwise. The router checks that list
   before any handler runs, so opening a method to a paired phone is a decision
   somebody makes on purpose, in one file, with the reason beside it.
   [docs/phone.md](docs/phone.md).

## The core is the host, the shell is a client

The core is a normal process in the user's session, never a Windows service:
DPAPI, the OAuth callback on `127.0.0.1` and the user profile are all
unreachable from session 0. Execution stays on the machine that owns the folder.
The shell starts a local core and adopts one that already answers, and it can
point at a core on another machine instead; the phone only ever points at one.
The shell holds its core in a `KILL_ON_JOB_CLOSE` Job Object, so a shell killed
hard takes its core down with it rather than leaving an orphan holding the
installed executable open. It also carries a channel, read once from its own
bundle identifier: `Boite` and `Boite Dev` are two installs on one machine, and
the channel is what keeps their data directories, and so their cores, apart.
[docs/releasing.md](docs/releasing.md).

## One WebSocket, one contract

JSON-RPC 2.0 over a single WebSocket at `/rpc`. Two checks guard it, both from
the first commit: the `Origin` header must be absent (a native client) or one of
the shell origins or the core's own, then the first frame must be `hello`
carrying the core token within five seconds, or the socket closes with `4001`.
An owner can add exact browser origins in Machines to let a browser or phone
connect to multiple cores. Authentication is still required for each socket.
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

## Every process sits in a Job Object

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
[docs/trace.md](docs/trace.md) has the caps and the settings.

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
field, with an example: [docs/providers.md](docs/providers.md).

## Accounts and isolation

An account is a descriptor plus a directory, and the descriptor's `isolation`
map is what makes one login blind to the others. An account on the provider's
own default location is the user's real CLI login: Boite reads it, reports it,
and refuses to run a login command for it, because that login belongs outside
Boite. For an isolated account the descriptor's `login` block runs through
`procs.spawnPiped` under the synthetic thread `login:<accountId>`, so it sits in
a Job Object and in the trace like any agent process, and its output streams back
line by line with the first link it prints carried separately.
[docs/accounts.md](docs/accounts.md).

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

Each connected machine has its own client and Store. Route actions through the
Store that owns the row; raw project and thread IDs can collide across machines.
Only the open thread on the visible machine streams. The rest of the list lives on `thread.updated`
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
back. [docs/phone.md](docs/phone.md).

## Hit every surface

The defect that gets through here is a change that works on the path it was
written on and is missing everywhere else. Before calling something done, walk
this list and say which entries applied.

- Both clients. The shell and the phone load the same build, but the shell has a
  title bar, a native folder picker, drag and drop and the opener plugin, and the
  phone has none of them. A feature reachable only from a right click does not
  exist on a phone.
- Every driver. Five protocols that answer differently by nature: one has no
  approval gate at all, one cannot change its permission mode on a live session,
  one carries a real price on the wire and the others carry none. A
  provider-shaped change needs a decision per driver, even when the decision is
  "not supported here".
- Both transports. The in-memory fake client and the real core implement the same
  contract on purpose. A rule written in the UI against one shape has to hold on
  the other, and the fake is what most UI tests run on.
- Reverse states. A way in needs the way out and the way to see it: create needs
  archive, install needs uninstall, subscribe needs unsubscribe, a warm session
  needs the thing that drops it. A one-way door is a bug.
- Both operating systems the trace promises something about. Windows gets exact
  events, everything else polls. A feature that reads process data has to answer
  on the poll path too, even if the answer is a `TraceCapability` note.

## Checking your own work

The UI does not answer a screenshot alone, and neither does a core with no
client. Three ways in, in the order they cost:

- The in-memory fake. `bun run dev:ui` with `?fake=1` runs the whole UI on
  `lib/fake-client.ts`, no core, no agent, no tokens spent. `&long=1` opens the
  four-hundred-message thread the windowed list is looked at on.
- A capture through the hidden browser. `tests/e2e/lib/cdp.ts` launches Chromium
  with `--headless=new`, on the real GPU through ANGLE, muted, in a throwaway
  profile, and drives it over CDP; `page.screenshot(path)` writes a PNG under
  `tests/e2e/.artifacts/`. That is the honest proof for anything visual, and it
  never puts a window on the user's screen.
- The end to end suite. `bun run e2e` starts a real core over WS with the echo
  driver, serves the UI from it into that hidden browser, and drives the release
  shell executable over the WebView2 debugging port with `BOITE_SHELL_HIDDEN=1`.

The opt-in live tests are the only ones that touch a real agent. They use the
user's own CLI logins and spend real tokens, so they run when their variable is
set and never by default. [docs/development.md](docs/development.md) lists them
with their variables.

## Measure before claiming

An optimisation with no number attached does not stay, and the numbers here have
a baseline: `bench/run.ts` measures cold start, idle RSS, and RSS and throughput
with fifty echo threads against Boite Legacy's headless server and running app,
writing `bench/results/<date>.md`. `bench/idle-rss.ts` measures the core's idle
working set against bare Bun, which is the floor no core can go under. Run both
fresh before quoting either, and quote the date with the figure.

## Before pushing

```bash
bun run check
bun run test
bun run e2e
```

`bun run e2e` needs a browser and the staged sidecar, so run `bun run stage:core`
first when the change touched the core: the shell test drives whatever
`boite-core.exe` sits beside the release shell executable and refuses a stale one
rather than timing out. `bun run bench` is worth it when the change touched
memory, process handling or the scheduler.
