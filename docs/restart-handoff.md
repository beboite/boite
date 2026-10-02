# Restart handoff

An update or graceful restart records eligible turns before stopping them,
then lets the next core continue that work. The journal owns the record;
`packages/core/src/threads/handoff.ts` owns its lifecycle.

## What the stopping core does

1. Close admission and persist the running and queued turns before requesting
   any stop. A core killed during the wait therefore leaves a handoff.
2. Stop each running turn between tool calls. An active tool has up to
   30 seconds to finish; after that, Stop applies at its current position.
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

Delegated and workflow children, resident-agent sessions, compactions and
coordination wakes are excluded. Their own runtimes require explicit resume
when recovery pauses them. See [delegation](delegation.md),
[workflows](workflows.md) and [persistent agents](agents.md).
Native processes and terminals follow the ordinary [shutdown limits](trace.md#linux-and-macos).

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
[Server](server.md) owns the unit configuration.

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
and late resolve/reject callbacks. These use deterministic fixtures and reopened
temporary journals; they do not prove physical power-loss recovery or provider
side-effect replay. `apps/shell/src-tauri/src/update_stop.rs` covers the shell
request and older-core fallback.
