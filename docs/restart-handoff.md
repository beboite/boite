# Restart handoff

An update or graceful restart records eligible turns before stopping them,
then lets the next core continue that work. The journal owns the record;
`packages/core/src/threads/handoff.ts` owns its lifecycle.

## What the stopping core does

1. Close admission and persist the running and queued turns before requesting
   any stop. A core killed during the wait therefore leaves a handoff.
2. Stop each running turn between tool calls. An active tool has up to
   30 seconds to finish; after that, Stop applies at its current position.
   A tool already running for 30 seconds when the restart starts gets no
   wait: on 2026-10-22 two updates each spent the whole grace on such a call
   (a nine-minute script, a polling loop) and cut it anyway: 30.6 and 30.2
   seconds between the `core.handoff.started` and `core.shutdown.started`
   events of `%LOCALAPPDATA%\boite2\logs\core.*.ndjson`, each line's `at`
   subtracted. On Windows:

   ```powershell
   Get-Content "$env:LOCALAPPDATA\boite2\logs\core.*.ndjson" | ConvertFrom-Json |
     Where-Object event -in 'core.handoff.started', 'core.shutdown.started' |
     Sort-Object at | Select-Object at, event
   ```
   Normal stop enforcement ends processes after 10 seconds and force-settles
   a remaining turn two seconds later.
3. Exit after draining. Eligible queued turns remain queued in the journal.

RPC stays open during the grace so tool calls to `boite` and permission answers
can complete. An explicit user Stop removes that thread's pending handoff;
it cannot be resumed automatically afterward. A turn that finishes or fails
during the grace needs no continuation.

## What the next core does

Construction validates the record without deleting valid entries. After the
server listens, each eligible entry is handled separately:

- A queued turn re-enters the scheduler with its existing prompt and identity.
- A cut running turn gets a continuation shown as "Resumed after a restart".
  It resumes the native session and asks the agent to check interrupted command
  results before continuing. Up to 8,000 characters of the original request
  accompany it; images are not resent.
- A turn left running when the old core was killed is closed as stopped, without
  an error part, then gets the same continuation.

A core that dies without a handoff (a crash, a kill, the shell's Quit) leaves
its work to [automatic resumes](#turns-that-stop-before-their-answer).

A continuation uses a stable request identity derived from its interrupted turn.
Admission persists the request-to-turn mapping before scheduler dispatch. The
handoff retains accepted-but-queued continuations and failed admissions until
the continuation starts or the entry is explicitly excluded. Repeated recovery
reuses an accepted continuation rather than creating another turn. A second
restart retains pending entries; a repeated resume note does not quote itself.
Each admission rechecks ownership and stopping state, including a user Stop
triggered while an earlier continuation starts.

An unreadable record or one older than one hour resumes nothing. Archived,
deleted or non-runnable threads are excluded; failed admission logs its reason.
This protects admission identity, not exactly-once execution of arbitrary shell
side effects. The agent must inspect what completed before relying on it.

Delegated and workflow children are cut the same way but never counted as
finished: a cut child sends its parent no result and a cut workflow step waits
again with "Interrupted by a core restart", its run still running. Once the
next core listens, each cut child gets the continuation above with its task
from the parent, and each run launches its waiting steps again. A child the
owner stopped, steered or archived meanwhile, or whose team was paused, stays
as it is. After a crash, or when the record is past its hour, recovery
pauses the team and the runs instead, marked as held by a restart: the parent
agent resumes them with `boite delegate resume`
([delegation](delegation.md#stop-pause-and-resume),
[workflows](workflows.md#failure-stop-and-restart)).

Compactions and coordination wakes are excluded. A bot's thread
resumes like any conversation; a wake that was waiting for its thread to be
free survives the restart ([bots](bots.md#wakes)).
Native processes and terminals follow the ordinary [shutdown limits](trace.md#linux-and-macos).

## Turns that stop before their answer

`packages/core/src/threads/auto-continue.ts` resumes a conversation whose turn
stopped before the agent gave its answer, with a `resume` turn whose prompt
says why and asks the agent to carry on without repeating work:

| Trigger | Label | When it goes out |
| --- | --- | --- |
| The turn failed: an API or stream error, a process exit | Resumed after an error | 1 min, then 5 min |
| The core died mid-turn | Resumed after a crash | 3 s after the next start |
| The turn ended on a compaction part, nothing after it | Resumed after a compaction | 1 min, then 5 min |
| Background work the agent waited on ended without waking it (failed, vanished, cut by a restart or an [agent update](agent-updates.md#background-work)) | Resumed after background work was interrupted | 1 min, then 5 min; 3 s after a restart |

A crash resume quotes the cut turn's request like a handoff continuation. When
a crash paused the conversation's subagent team or workflow runs, the prompt
asks the agent to check them and run `boite delegate resume`; a parent that had
no turn running gets a resume for that alone.

Nothing resumes for a turn that answered, a turn the user stopped, a refusal
at capacity or at a usage limit, which retries on its own
([usage](usage.md#when-a-provider-refuses-a-turn)), a compaction or coordination turn, a
sub-thread, or background work a Stop or an archive ended.
After a crash, nothing resumes when the previous core wrote its last thread
event over an hour ago, or when it was stopped on purpose without a handoff
(`core.shutdown`, `SIGINT`, `POST /shutdown`), which leaves the journal setting
`auto-continue-stopped`.

Each plan sits in the journal setting `resumes` with the usage limit resumes
(`threads/resume.ts`; a core that still has the older `auto-continues` or
`limit-resumes` reads them into it once), so a restart arms it
again; one caught while dispatching is dropped. The row shows it as `retry`
(`kind: 'auto-continue'`) with Do not resume. When it fires it is dropped
instead if the thread was archived, answered or is busy, a card waits for the
user, or the user paused its team. A cache ping in the way stops and lets it go.
Two resumes in a row that stop again end
the row: the third stop stays on the thread and notifies like any failure. The
user's next message, or a turn of another kind that answers, starts a new row;
a resume that answers but leaves background work that dies again does not.

## What starts it

| Caller | Trigger |
| --- | --- |
| Desktop update | Shell `POST /shutdown-for-update?pid=<core pid>` after installation confirmation |
| Service manager or reboot | `SIGTERM`; a second skips tool grace, a third exits |
| Owner script | Same loopback POST with the owner token; returns 202, or 412 for a different PID |

`SIGINT`, `SIGHUP`, `POST /shutdown` and `core.shutdown` stop without handoff.
`POST /shutdown-if-idle` refuses a busy core; the manual Windows installer uses
that path. See [desktop updates](updates.md) for installer behavior.

A service manager must allow the grace and signal only the core to preserve
running tools. systemd's default `KillMode=control-group` signals the agents
immediately; eligible turns can still resume, but their tool calls are cut.
While the handoff runs, an error from an agent that dies (a process exit, no
provider refusal) ends its turn as stopped, with no error part, so the turn
resumes instead of reading as a crash. [Server](server.md) owns the unit
configuration.

## Close fences

Core drain shares its shutdown promise and closes automatic launchers before
waiting for turns. Coordination cancels its local acknowledgement waits so a
completed warm turn cannot block driver teardown. Its letters remain uncertain
when acceptance is unknown. Late acknowledgement paths cannot write after
coordination or the journal closes. Workflow callbacks check closed state and
cannot admit an output correction after teardown begins.

## Verification

`packages/core/test/restart-handoff.test.ts` covers tool grace, queued turns,
owner cancellation, expiry, pre-listen replacement loss, durable admission,
partial recovery, repeated restart and reentrant Stop.
`coordination-lifecycle.test.ts` covers acknowledgement waits released by close
and late resolve/reject callbacks. `auto-continue.test.ts` covers each
automatic resume trigger, a team a crash held, the two-resume limit,
cancellation, a cache ping in the way, a crash older than an hour, a
deliberate stop and a plan carried across a crash. These use deterministic fixtures and reopened
temporary journals; they do not prove physical power-loss recovery or provider
side-effect replay. `apps/shell/src-tauri/src/update_stop.rs` covers the shell
request and older-core fallback.
