# Restart handoff

A core that restarts for an update does not wait for every thread to go idle.
It hands its turns to the next core.

## What the stopping core does

1. It refuses new turns and writes which turns run and which wait in line. That
   record is in the journal before anything is stopped, so a core killed during
   the wait still hands its turns over.
2. Each running turn is stopped as soon as it is between two tool calls. A turn
   inside a tool call keeps it until the call ends, 30 seconds at most; past
   that, the turn is stopped where it stands. A turn that ignores its stop gets
   the usual 12 seconds before its processes are ended.
3. The process exits. Queued turns are left queued.

The RPC surface stays open during those 30 seconds: a tool that calls `boite`
finishes, and a permission card can still be answered. Stopping a thread
yourself during the wait takes it off the record; that turn is yours to send
again.

## What the next core does

Once its server listens, it reads the record and removes it:

- A queued turn goes back in line as it is, with the prompt it already had.
- A thread whose turn was cut gets a new turn, shown as "Resumed after a
  restart". The agent resumes its own session and is told that the restart
  cut its turn, that a command running at that moment may have been cut short,
  and to continue without starting over. The request the cut turn was
  answering goes along, up to 8000 characters, because a turn stopped in its
  first second may never have reached the agent's session. Images of that
  request are not sent again.
- A turn the old core was still waiting on when it was killed is closed as
  stopped, with no error part, and its thread resumes the same way.

A record older than one hour resumes nothing: a machine switched back on the
next day does not start paid work by itself. Those turns end as they do after a
crash, and the prompt is yours to send again. A thread archived or deleted
meanwhile, or whose agent cannot run any more, is skipped with a warning in the
log.

Not resumed: sub-threads of a delegation or a workflow, persistent agent
sessions, compactions and coordination wakes. [Delegation](delegation.md),
[workflows](workflows.md) and [agents](agents.md) pause across a restart and
resume on your word. Background work an agent left running, terminals and warm
sessions end with the core, as in any shutdown.

## What starts it

| Caller | How |
| --- | --- |
| Desktop update | The shell sends `POST /shutdown-for-update?pid=<core pid>` once you confirm the installation ([desktop updates](updates.md)). |
| Service manager, reboot | `SIGTERM`. A second `SIGTERM` skips the wait and stops the turns now; they still resume. A third exits. |
| Your own script | The same `POST`, on a loopback name, with `Authorization: Bearer <token>` from `core.json`. It answers 202, 412 when `pid` is not this process. |

`SIGINT`, `SIGHUP`, `POST /shutdown` and `core.shutdown` stop the core as
before and resume nothing. `POST /shutdown-if-idle` still refuses a busy core;
the Windows installer run by hand uses it.

On a server, give the service manager time for the wait and let it signal only
the core, as [server](server.md) shows. With systemd's default
`KillMode=control-group` every agent receives `SIGTERM` together with the core:
tool calls are cut at once, and the threads still resume.

## Verification

`packages/core/test/restart-handoff.test.ts` covers a tool call that finishes
during the wait, one that outlasts it, a queued turn, a thread stopped by the
user, a core killed during the wait, an expired record and the HTTP admission.
`apps/shell/src-tauri/src/update_stop.rs` covers the shell's request and its
fallback for an older core.
