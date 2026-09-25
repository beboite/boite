# Trace, caps and the two guards

Boite claims to know what every thread launched and what it cost. That claim is
only true because one launcher owns every spawn and, on Windows, puts the child
in a kernel object before its first instruction. This page is what the claim
covers, and where it stops.

## Platform boundary

The shared process registry calls `ProcessPlatform` in
`packages/core/src/platform/types.ts`. `platform/index.ts` selects the backend:
`platform/windows/` owns Job Objects, FFI, native workers, focus protection,
audio mute and the `taskkill` fallback. `platform/posix.ts` supplies the current
Linux and macOS behavior without importing the Windows modules. Both systems
share that backend until their native tracking implementations differ.

The registry owns spawning, journal entries, exit handling and thread events.
Every driver uses the same registry. Adding native tracking for another OS
means implementing this interface, not adding OS branches to drivers or RPC
handlers. Unsupported protections stay off even when their settings are enabled.

The shell follows the same boundary under `apps/shell/src-tauri/src/platform/`:
core ownership, launch flags, data paths, toast delivery and native appbar queries
live there. IPC caller checks remain in the shared shell commands. This split
does not add system toasts or hard-exit process ownership on Linux or macOS.

## One launcher, one Job Object per thread

`packages/core/src/procs.ts` is the only place a process is created:
`spawn`, `spawnChild` and `spawnPiped`. A driver that reached for `Bun.spawn`
would produce a process nothing here can see.

On Windows the first spawn of a thread creates that thread's Job Object, nested
inside a global job. Both are created unnamed, so neither can be looked up from
another process. Both carry `KILL_ON_JOB_CLOSE` and neither carries
`BREAKAWAY_OK`, so nothing a thread starts can leave the job, and
a core that dies takes every agent process with it. The child is assigned right
after spawn, and `windowsHide: true` is set on every one of them.

A completion port on the job reports every process that enters or leaves it,
grandchildren included, and a Worker drains it. The Worker is built on the first
traced pid rather than at core start, like everything else heavy here. Those
events become `process.started` and `process.exited` on the wire, each carrying
pid, parent pid, thread, executable, the command line when it is readable, start
and exit times, exit code, CPU milliseconds, peak memory and bytes moved.

Two details are not obvious and are load-bearing. `TerminateJobObject` sends no
per-process exit on the completion port, only the "no active processes" message,
so a tree killed that way would stay marked live forever if nothing handled it.
And `conhost.exe` joins the job the moment a child's stdout is piped, so console
hosts are filtered out of the trace and the load while their CPU stays in the job
totals.

## What a client sees

- `trace.get` gives one thread's processes, newest first.
- `resources.list` gives every thread with its live processes and its totals.
- `resources.killTree` kills one thread's tree, `TerminateJobObject` on Windows
  and registered direct children elsewhere. It returns before the completion port has
  reported the exits, so anything that then reads the trace on the next line
  still sees them live: wait for the live count to reach zero instead.
- `ThreadLoad` is sampled on a timer and carried on every thread summary: how
  many processes, what percentage of CPU, how many bytes of memory. It is what
  the gauge in the trace panel reads.

The trace panel lists active processes first, then the most recently started.
Each expandable row shows the executable name, running or exit status, duration
and peak memory. Expanding it reveals the command, full path, PID, parent PID,
CPU time and I/O. Unmeasured values remain unknown. The top summary separates
recorded processes from active ones and labels current CPU and memory usage.
The tracking capability disclosure explains the limits of polling hosts. The
Protection page under Settings keeps its wider resource table.

## Caps

Two settings turn the jobs into limits. Both are Windows only, both are ignored
elsewhere, and both apply to jobs that already exist as well as to new ones.

- `agentCpuCapPercent`: a hard ceiling for every agent process together, as a
  percentage of the whole machine, applied as the global job's CPU rate control.
  0 disables it.
- `threadMemoryCapMb`: a ceiling for one thread's whole process tree, applied as
  that thread's job memory limit. A tree that reaches it fails its next
  allocation, which the agent reports as its own out-of-memory error. 0 means no
  cap.

## Orphans

Stopping a shell does not stop what it started. When an agent's command is
interrupted or refused, the agent ends the shell and whatever that shell
launched keeps running inside the thread's job: a test runner, a dev server, a
browser. The job holds it, so the trace and the load still count it, but
nothing will ever stop it before `resources.killTree` or the core's exit.

Ten seconds after `turn.finished`, if no new turn has started in the thread,
the registry sweeps it. A process is an orphan when the job reported it, it is
at least ten seconds old, and its parent pid is not a live process of the
thread, or belongs to one that started after it (a pid Windows gave to someone
else). Each orphan is stopped with everything under it, through the process
handle the job listener opened when the process started, never through a fresh
open by pid. Each stop is a `core.log` line naming the thread, the pid and the
executable.

The agent process and anything else the core spawned have the core as their
parent and are never taken. Neither is a process whose shell is still
running, such as a background command the agent is still waiting on. A process
an agent detaches on purpose and means to keep across turns is stopped too:
that is what the switch below is for. Off Windows, only direct children are
tracked, and their parent is the core, so the sweep finds nothing.

## The focus guard

An agent that opens a window takes the foreground, and the user loses whatever
they were typing into. The guard is a second Worker holding a system-wide
`SetWinEventHook` on `EVENT_SYSTEM_FOREGROUND`, out of context and skipping the
core's own process, plus the message pump that hook needs, because an
out-of-context event is delivered on the thread that installed the hook and only
while that thread pumps. The main thread posts it the pid set and the setting.

When the window that just took the foreground belongs to a pid a thread
launched, two remedies fire in order. `SetWindowPos` to `HWND_BOTTOM` without
activation, which needs no foreground right and always works. Then
`AttachThreadInput` around `SetForegroundWindow` to give the focus back to the
window the user was on, which a background process cannot do otherwise.
`process.focusPushed` says which thread, which pid, which window title, and
whether the restore took.

Job Object UI limits are not the answer and are never set: none of them blocks
showing a window or taking the foreground, and setting any would refuse the
nested job the whole trace depends on.

The decision itself is a pure logic class over an interface of the seven Win32
calls, so every case is proved on a fake and no test creates a window. The one
test that needs a real one steals the keyboard for a blink and is opt-in behind
`BOITE_E2E_GUARD=1`.

## The audio mute

An agent that plays a sound reaches the user's speakers, and there is no
notification to hook for it: the session-created callback wants an MTA thread and
a COM object whose return values a thread-safe FFI callback cannot provide. So
the sessions are polled instead, on the same Worker, over the same pid set.

`CoInitializeEx` runs on the thread that already pumps. Every second, and right
after every new pid, the sessions of the default render endpoint are walked over
`bun:ffi`: the device enumerator to the default endpoint, the session manager,
each session's process id, then its volume interface. A session whose process id
is a traced pid and that is not muted already is muted, and its volume interface
is held.

Holding it is the point. Windows keeps a rendering session's mute across
restarts, so a process that exited muted would come back muted. The mute is
undone and the interface released when the pid exits, when the setting goes off
and when the Worker stops. A session the user muted by hand in the mixer reads as
muted already, so it is left alone and never unmuted on exit. `process.muted`
says which thread and which pid, and a machine with no render endpoint says so
once and keeps that half off for the Worker's life.

Like the guard, the rule is a logic class decided on a fake. The one test that
touches the real endpoint plays two seconds of zeroed PCM, which is a session in
the mixer and silence in the speakers.

## Turning them off

All three live under Settings, Protection, and all three are on by default.

| Setting | Effect when off |
|---|---|
| `focusGuard` | an agent's window keeps the foreground it took |
| `muteAgents` | an agent's audio reaches the speakers, and anything muted is unmuted |
| `reapOrphans` | what a thread leaves running after its turn runs until the thread's tree is killed or the core exits |

The notifications switch, under Settings, General, is the UI's own and never
reaches the core: a system toast when a thread finishes, fails or asks
something while another thread is open or the window is not in front. The
shell carries it as a Windows toast through its `notify` command, the phone
through Web Notifications, a click on either opens the thread, and the switch
is stored per machine under `boite.notifications`.

## Linux and macOS

There are no Job Objects. The registry records direct children at spawn and
exit; it does not discover grandchildren or poll a process group. Bun supplies
exit usage for its own subprocesses, while the Node spawn path has no exit
usage off Windows. The reported `poll` mode denotes this limited fallback.

Nothing hides that. `TraceCapability` carries the operating system, a `mode` of
`events`, `poll` or `none`, and a note saying why, and every client reads it
before promising anything. Windows with a working FFI surface reports `events`;
Windows where that surface failed to load reports `poll` with the error in the
note. Off Windows, `resources.killTree` kills registered direct children only.
The focus guard and audio mute do not exist there. A hard kill of the shell
does not guarantee that its core exits on Linux or macOS.
