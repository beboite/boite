# Trace, caps and guards

Every agent process starts through one registry. Windows records Job Object
tree events; Linux and macOS expose more limited tracking. The trace reports
observed processes and resources, with unknown values left unknown.

A running turn's footer shows its last observed activity: startup, thinking,
compaction, retry, tool work or provider wait. Its timestamp advances on an
event, not a timer. After a minute without execution activity it offers Trace;
silence does not establish that a provider is stuck. Reconnect restores the
snapshot and completion clears it. Provider signals have a separate timestamp,
so repeated status notifications do not imply execution progress.

Codex reasoning boundaries count as activity without reading encrypted content
or inventing thinking text. Completed public messages render immediately and
update the native item already shown; reconnect does not duplicate them.

## Platform boundary

The registry calls `ProcessPlatform` in `packages/core/src/platform/types.ts`.
`platform/index.ts` selects `platform/windows/` or the shared Linux/macOS
`platform/posix.ts` backend. Windows owns Job Objects, FFI, workers, guards and
native fallback termination. Drivers and RPC handlers use the registry rather
than importing OS backends. Unsupported protections remain off even if saved
settings enable them.

The registry owns spawn, exit, journal process rows and thread events. A process
row is written at start and exit, without copying it into the operational event
journal. Thread rows remain until thread/project removal. Synthetic operations
without a real thread lose their rows when the registry forgets them, 30 seconds
after the last process exits. Existing rows from older cores are not retroactively
cleaned by that rule.

The shell has a separate native boundary under
`apps/shell/src-tauri/src/platform/` for core ownership, launch flags, data paths,
toasts and appbar queries. Shared IPC commands still check their callers.

## One launcher, one Job Object per thread

`procs.spawn`, `procs.spawnChild` and `procs.spawnPiped` in
`packages/core/src/procs.ts` own process creation. Bypassing them loses registry
tracking and protections.

Windows creates an unnamed per-thread Job Object nested in an unnamed global
job. Both use `KILL_ON_JOB_CLOSE`, with no `BREAKAWAY_OK`. Children are assigned
immediately after spawn and use `windowsHide: true`. Closing the core's jobs
ends their member processes. An empty thread job is forgotten after 30 seconds;
a job that still reports members remains held.

Codex initialization can temporarily use normal priority for at most 30 seconds.
The driver restores below-normal priority on ready, failure or Stop; the registry
also restores it on exit or deadline. A refused downgrade retries every 250 ms.
Warm sessions get no new boost. CPU and memory caps apply throughout. Failed
global assignment or cap application, or a disabled/full CPU cap, withholds the
boost. Other threads and POSIX scheduling retain their existing behavior.

A completion-port Worker reads tree membership events, grandchildren included.
It starts on a turn or the first traced PID and sleeps until a packet arrives.
After 30 seconds with no occupied jobs it stops; the port remains open for the
next Worker. Process handles are opened when packets arrive. A process that
already exited may have no readable identity and stay outside the trace while
its CPU remains in job totals. Console hosts are similarly excluded from trace
rows and load while remaining in totals. Terminating a job requires explicit
exit reconciliation because the port may report only the empty-job event.

`process.started` and `process.exited` carry the available PID, parent PID,
executable, command line, timestamps, exit code, CPU time, peak memory and I/O.

## What a client sees

| Method or field | Meaning |
| --- | --- |
| `trace.get` | One thread's recorded processes, newest first |
| `resources.list` | Threads with live processes, their last sampled `ThreadLoad`, busiest first |
| `resources.usage` | Agent identity and cached CPU, memory, storage and TCP readings, without process arguments or paths |
| `resources.killTree` | Stops the registered thread tree or groups; wait for live count zero before treating exits as observed |
| `ThreadLoad` | Sampled process count, CPU percentage and memory on each thread summary |

Manual archive also cancels temporary side questions throughout the retained
family. Their retired requests cannot publish answers after restoration.

Manual archive stops the thread's turns and those of its child threads, then
ends their registered processes once the stopped turns settle. Exited
processes remain in `trace.get`. An archived thread appears in `resources.list`
only while it has live processes, including ones explicitly started after
archive cleanup.

Protection settings refresh resources every two seconds while visible. Trace
lists active processes first, then recent starts. Expand a row for command,
path, IDs, CPU and I/O. Its capability disclosure identifies incomplete tracking.
A command line belongs in this authorized trace view, not diagnostic logs.

## Agent task manager

Settings > Task manager shows this machine's live processes grouped by agent,
with search and sorting by memory, CPU, disk or network activity. Desktop owners
can stop an agent's processes after confirming. Paired phones can read the same
measurements and open the owning conversation, but cannot stop processes.

The view asks for cached measurements every two seconds while visible.
`resources.usage { watch: true }` holds a six-second lease owned by its connection;
closing, hiding or disconnecting releases that connection's lease. Detailed
collection stops when no lease remains. A request without `watch` reads the
snapshot without enabling collection. Unsupported cores show an update message
and wait for an explicit retry.

CPU is a percentage of the machine's logical processors; memory is the current
platform sample, not lifetime allocation. A missing measurement displays
"Not available". Totals disclose when only some agents have readable counters.
Linux sampling separates independently registered nested agents, so their
subtrees do not contribute to both rows.

Linux disk activity uses task-local procfs storage counters, excluding character
I/O and a parent's accumulated counters from reaped children. TCP activity joins
kernel payload counters to an agent's currently held socket descriptors,
checking process birth, network namespace and socket identity. Shared sockets
between separately registered agents remain unattributed. Download/upload rates
and byte totals cover observed intervals while collection is active, not the
agent's entire lifetime. Short processes or connections can escape observation;
UDP traffic and protocol overhead are outside these TCP counters. Disk activity
does not describe folder size.
A failed TCP dump displays unavailable; a later valid reading can recover the
actual byte delta only when the socket and process identities still match.

Windows supplies job CPU and memory measurements. macOS supplies readable
physical footprint measurements, with CPU unavailable. Storage and network
activity on unsupported platforms display unavailable rather than zero.

## Structured diagnostics

Diagnostics are written apart from SQLite events, one JSON record per line,
under `<dataDir>/logs/`:

| Files | Writer | Rotation |
| --- | --- | --- |
| `core.0.ndjson` to `core.7.ndjson` | the core (`packages/core/src/logs.ts`), plus `origin: "ui"` records clients send | 2 MiB per file |
| `shell.0.ndjson` to `shell.3.ndjson` | the desktop shell (`apps/shell/src-tauri/src/shell_log.rs`) | 1 MiB per file |
| `exports/boite-diagnostics-*.txt` | an export | the newest 10 |

Every record carries `id`, `runId` (one per process start), `at`, a level
(`debug`, `info`, `warn`, `error`), `origin` (`core`, `shell` or `ui`; absent
on older records, which are the core's), `source`, a dotted `event` and a
readable `message`. Optional fields correlate it: `threadId`, `turnId`,
`requestId`, `durationMs`, and `data`, at most 16 scalar values. A record
about a thread also names its agent, `providerId`, `model` and
`parentThreadId`, resolved when it is written, so a delegated child reads as
`[thr_child claude/claude-opus-5-5 <thr_parent]` on every line. Turn records
carry the queue wait, the duration, the token counts and the effort; process
records the program's file name, pid, exit code, CPU time and peak memory.

The sink redacts configured credentials and recognized sensitive fields before
bounding messages to 4,096 characters, metadata to 200 and `data` strings to
300. It accepts explicit diagnostic metadata, not RPC payloads or process
arguments. Raw provider output classified as `kind: 'provider-output'` stays
visible in the owner's live log, including usable login links, with
configured credentials removed and the same 4,096-character limit. Paired
devices and agents do not receive that log event. Persistence and diagnostic
queries replace it with `[provider output omitted]`. A turn's own error text
can carry provider output, so `turn.finished` records only the status; the
cause is in the `turn.failed` record built from the driver's diagnostic.
Producers must classify output; text redaction alone is not a transcript
filter.

Writes use a bounded 1,024-record pending buffer and 250 ms batching, with
earlier flushes for large batches. Overflow reports dropped persistence;
recent memory retains up to 4,096 records. A failed sink reports once and
leaves core work running. Queries merge recent memory, the core files newest
first (stopping once an older file cannot change the answer) and the shell's
files, ignore malformed or partial crash records, sort by time and serialize
reads with rotation. Close flushes writes. POSIX directories use `0700` and
files `0600`.

### Anonymization

Local files keep redacted text. What leaves the owner, an export, an issue or
an agent's read, also goes through `createLogAnonymizer` in
`@boite/contracts`. Project paths and names become `<project:xxxxxx>`, worktree
and thread folders outside a project too; the data directory `<data>`, the
home `~`, other accounts' homes `<user>`, the account name `<user>`, the host
name `<host>`, account labels `<private:xxxxxx>`, e-mail addresses `<email>`,
non-loopback IPv4, IPv6 and MAC addresses `<ip>`, `<ip6>` and `<mac>`. A URL
keeps its host and path only for public services (provider APIs, GitHub,
package registries); any other host becomes `<host:xxxxxx>/<path>`, and a
GitHub owner other than Boite's own `<owner:xxxxxx>`. `xxxxxx` is a hash
salted with `<dataDir>/logs/anonymize.salt`, so one machine's exports agree
with each other and differ from another machine's. Thread, turn and run ids,
versions, times and loopback addresses stay readable.

### Reading them

`core.logs { limit?, threadId?, turnId?, level?, minLevel?, origin?, source?, since?, until?, search?, anonymize? }`
is owner-only because redacted causes can still describe paths or other
conversations. It returns newest first, defaults to 100 and accepts 1 to 1000
records. Invalid fields, filters and levels are refused.

`diagnostics.logs`, `diagnostics.summary`, `diagnostics.export` and
`diagnostics.issue` return the anonymized view. The owner calls them freely;
an agent names its own thread and is refused while the `agentLogAccess`
setting is off (Settings > Diagnostics). An agent is held to its own thread,
like every agent call: it reads the records about no thread (the core, the
shell, the clients), which say whether Boite itself failed, plus those of its
thread and of every thread it started, never another conversation's. With
`scope: 'thread'` it leaves the records about no thread out. The owner reads
everything, or one thread's family with `scope: 'thread'`.
`diagnostics.summary` groups warnings and errors by origin, source, event and
level, and lists each thread in reach that the window touched with its agent,
status, parent, project placeholder and error count. An agent's export covers
the same reach and leaves out the raw `core-output.log` and `shell-error.log`
tails, which can name any conversation.

`diagnostics.export` writes one text file a developer reads top to bottom:
environment (version, channel, OS build, CPUs, memory, uptime, trace mode),
agents and their versions, behaviour settings without addresses or paths,
grouped problems, threads, log file sizes, the ends of `core-output.log` and
`shell-error.log`, then the timeline oldest first, one `formatLogLine` per
record. It covers the last 24 hours by default, at most 20,000 records.

`diagnostics.issue` drafts a GitHub issue for `beboite/boite`: the user's
description, the environment, the problems and as many of the newest log lines
as fit. With `submit: true` it runs `gh issue create` under the core's own
`gh` login and returns the issue URL; without a signed-in `gh` it returns a
prefilled `issues/new` link the user opens in a browser signed in to GitHub.
Either way the saved export path is returned so the full file can be attached.

`diagnostics.report` takes up to 50 records from a client, owner or paired
device, stored with `origin: "ui"`, the client kind and whether it is remote.
A connection may send 300 a minute; the rest of that minute is dropped with one
warning. A client time more than 10 minutes off is replaced by the core's.

[CLI](cli.md#diagnostics) documents `boite logs` and `boite issue`, and the
built-in `boite-report-issue` skill agents receive ([brain](brain.md#boite-guide)).

## Caps

Windows applies `agentCpuCapPercent` to the global job and
`threadMemoryCapMb` to each thread job, including existing jobs. A configured
zero disables those explicit caps. A tree at its allocation cap can fail its
next allocation. The automatic memory guard is separate and also runs on POSIX.

Settings > Protection > Limits controls `memoryProtection`, quotas and reserve.
Turning protection off removes automatic memory stops and Windows allocation
caps immediately while retaining configured values. Zero quota or reserve means
automatic sizing, not disabled protection. Resource readings remain visible;
the OS can still refuse allocations.

The automatic reserve is the larger of 10% of physical RAM and 3072 MB.
On machines with less than 12288 MB of RAM, it uses 25% instead, so the
desktop and a small agent can run without permanently tripping the guard.
An explicit reserve keeps its configured value.

Memory stops appear beside the interrupted tool. Persisted message/part
boundaries keep later output from relocating the notice. Repeated notices at
the same boundary, reason and threshold share a folded process list. Owners can
open the owning machine's memory settings, including from phone-width Settings.
Paired devices cannot change core protections.

## Orphans

Windows can retain processes after the shell that launched them exits. Ten
seconds after a turn or an agent release, with no intervening turn, the registry
checks traced processes at least ten seconds old. A missing parent, or a parent
whose start time is newer than the child because its PID was reused, identifies
an orphan. Before stopping it, the platform checks whether the untracked parent
still runs and was created before the child; a live original parent keeps its
child. Termination uses the original held process handle and its descendants,
not a newly opened PID. Each action emits a thread-correlated diagnostic.

Processes directly launched by the core and children of live shells remain.
Detached descendants and launcher children can qualify even when intentionally
left running; `reapOrphans` controls that policy. Release paths include archive,
Stop, account/provider changes, child cleanup and resident-agent checkpoints.
The sweep is linear in live processes. POSIX tracks direct core children only,
so orphan reaping finds no additional descendants there.

## The focus guard

A Windows Worker installs `SetWinEventHook` for foreground changes and runs the
required message pump. The registry supplies traced PIDs and settings. When a
traced window gains focus, the guard sends it to `HWND_BOTTOM` without activation,
then attempts to restore the prior window through `AttachThreadInput` and
`SetForegroundWindow`. `process.focusPushed` records the thread, PID, title and
restore outcome. Job Object UI limits are not used; they do not prevent window
creation or foreground activation and can interfere with nesting.

The shared guard/audio Worker starts with a turn or traced process, stops after
30 seconds without a traced PID, and stops after both protections remain off for
30 seconds. A turn resets the grace. Both off means no Worker starts. Startup
failures log once per core run; a refused focus hook can leave audio protection
running and exposes its failure through `guardStatus()`.

Logic tests use fake Win32 calls. `BOITE_E2E_GUARD=1` is the opt-in real-window
case and briefly takes focus; ordinary automation must not enable it.

## The audio mute

The same Windows Worker initializes COM and polls the default render endpoint
once per second and after a new PID. It mutes unmuted sessions belonging to
traced processes and holds their volume interfaces. Unreadable sessions are
reported once; a failed or changed endpoint is reopened. With no endpoint it
retries every 30 seconds. A COM startup refusal disables this half for that
Worker's lifetime.

On process exit, setting disable or Worker shutdown, it restores only mutes it
applied and releases interfaces. User-muted sessions remain muted. Core shutdown
waits up to one second for release so Windows' persistent session mute does not
carry into a later launch. `process.muted` identifies the thread and PID.
Logic tests use a fake endpoint; the native audio test opens a session with two
seconds of zeroed PCM, without audible content.

## Turning them off

| Setting | Effect when off |
| --- | --- |
| `memoryProtection` | Removes automatic stops, Windows allocation caps and the Linux throttling notice |
| `focusGuard` | Leaves agent windows' foreground behavior unchanged |
| `muteAgents` | Restores agent sessions muted by Boite |
| `reapOrphans` | Retains leftovers until tree termination or core exit |

Protections are on by default. Notifications are a separate client preference
under General, stored per machine as `boite.notifications`. Windows uses the
shell's toast command and phones use Web Notifications; a click opens the thread.

## Linux and macOS

No Job Objects exist. Spawn/exit records cover registered direct children,
without grandchild events. Bun provides exit usage for its subprocesses; the
Node path supplies no POSIX exit usage. `TraceCapability.mode: 'poll'` names
this fallback, not complete process-tree event tracking.

Linux samples procfs every second for registered processes and their descendants.
CPU uses `/proc/<pid>/stat`; memory uses `RssAnon + RssShmem`, falling back to
`VmRSS` on older kernels. The latter includes shared library mappings and can
overcount a parallel workload. macOS uses `proc_pid_rusage` physical footprint
for each direct child and reports CPU as zero. The automatic memory guard can
stop the heaviest child tree when a thread exceeds its share. CPU job caps,
focus guard and audio mute remain Windows-only.

Linux also reads the cgroup of each thread's root agent process on the same
one-second sample: the `0::<path>` line of `/proc/<pid>/cgroup`, then
`memory.events`, `memory.pressure`, `memory.high`, `memory.max` and
`memory.current` under `/sys/fs/cgroup<path>`. Past `memory.high` the kernel
fails nothing; every process of the group stalls near 0% CPU while the `high`
count of `memory.events` climbs. That count alone proves no stall: a group
whose charge is mostly clean page cache reaches the limit during any large
build, the kernel drops cache and no process waits. A sample therefore counts
as stalled only when the `high` count rose and the `some` total of
`memory.pressure` grew by at least 20% of the time since the previous sample
(200 ms per second). A thread with five stalled samples gets one `throttled`
memory notice naming the limit, delivered to the user and the agent like a
memory stop, then at most one every five minutes while the stall continues;
its event also carries the group's current charge. Thirty seconds without a
stalled sample end the streak. A root process found in another cgroup path, or
any counter lower than the last one, starts over as a new group: five new
stalled samples are needed before the thread gets another notice. Two samples
more than five seconds apart only restart the measure: no stall share is
computed over an idle gap.
A reading needs `/proc/<pid>/cgroup`, `memory.events`, `memory.pressure`,
`memory.high` and `memory.current`: when any of them is missing, unreadable or
malformed there is no reading and no notice. That covers cgroup v1, a group
without `memory.high`, a kernel without `memory.pressure` and a path outside
the core's cgroup namespace. `memory.max` is read when present and never
required. The notice follows `memoryProtection` and stops nothing.

Registered POSIX children start detached in their own process group.
`resources.killTree` sends group SIGTERM, probes every 100 ms and sends SIGKILL
two seconds later only if the group remains. It can reach members after the
leader exits. A child that starts its own session escapes that group. Normal
shutdown waits for escalation; a hard shell kill does not guarantee core exit
on Linux/macOS. `TraceCapability` exposes OS, mode (`events`, `poll`, `none`) and
failure notes; clients must read it before promising native capabilities.
