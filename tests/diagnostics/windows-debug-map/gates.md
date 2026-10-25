# Windows DEBUG_PROCESS marker diagnostic

Run only on a disposable native Windows runner, with explicit opt-in:

```sh
BOITE_TEST_DEBUG_MAP=1 bun tests/diagnostics/windows-debug-map/run.ts <absolute-artifact-directory>
```

In PowerShell, set `$env:BOITE_TEST_DEBUG_MAP = '1'` first. The existing
`windows-2025` core job runs this command before Native Windows protected tools.
This additional diagnostic uses `continue-on-error`; its actual exit code is in
`diagnostic.json` and `launcher-exit.txt`. Its result never grants production
admission and never changes the required two-compiler protected suites.
The `windows-debug-map-diagnostic` artifact expires after three days. It includes
kernel version, compiler commands, generated source, input/helper SHA256 hashes,
complete native stdout/stderr, per-compiler structured results and cleanup logs.

On Linux, `bun .../run.ts <absolute-artifact-directory> --compile-only` verifies
strict MinGW cross compilation. Without the Windows opt-in, the launcher and
native test allocate no native fixture. Cross compilation is not routing proof.

## Source provenance

`generate.ts` reads the current `packages/core/src/platform/windows/protected-tool.c`
and rejects any SHA256 other than
`8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a`.
This is the unchanged source from commits `2f13085b` and `a174bb2b`.
It applies individually checked, single-match substitutions, writes a separate
test-only helper and leaves all runtime production source untouched.

`routing.h` and `inspect.h` adapt the retained candidate whose generated C
SHA256 was `9c66639e4888be6086a19f6c7d506ed71ebdc9d471cac6cfbc90ea1618bba3ec`;
the retained header was
`09e5a2691804274599e075babdb9c57aa6f28f2868d5e793017a70da220486bd`.
That candidate compiled. Its launcher stopped on PowerShell 5 stderr handling
before fixture allocation; loss of the native machine then interrupted it.
It was never natively disproved. Original scratch and evidence are unchanged.
`retained-red.json` records the earlier root-only observation as historical
evidence, never as a fresh run. The test must reproduce it before debugging.

## Initial gate

The fixture uses the real core harness, ProcRegistry and ProcessPlatform with
fresh synthetic state, selected environment and all live-provider opt-ins off.
Both SDK clang and MinGW compile with `-O2 -Wall -Wextra -Werror`; MinGW also
uses `-static`, matching the existing helper builder.

1. An LPAC root opens its private marker through ordinary `NUL`; an ordinary
   child loses that root-only map. This expected red task must exit 1.
2. Two tasks with distinct markers run concurrently. A parent-controlled file
   barrier holds both roots alive before releasing their ordinary children and
   grandchildren. Every generation must read its own exact marker via `NUL`.
3. Before each mapped debug creation resumes, verify the exact package, single
   enabled registryRead capability, `WIN://NOALLAPPPKG=1`, membership of the
   owned job, kill-on-close and absence of both breakaway flags. Each target
   reports AppContainer/job membership and ambient-package-only file denial.
4. Self `ProcessDebugObjectHandle` queries must deliver no debugger control.
   WAIT_STATE_CHANGE, ADD_REMOVE_PROCESS and SET_INFORMATION all reject it.
   Undecodable returned handles or unknown query statuses fail closed.
5. The helper compares its own privilege blob, resolved caller map name, NUL
   and the dynamically selected project-drive mapping before/after. Ordinary
   observer processes must agree before/during/after both tasks.
6. Captured tasks exit, owned debug exit events continue, the job reaches zero
   active processes, and the owned map disappears. Delete/recreate/delete each
   owned profile; remove synthetic state only with native cleanup evidence.

Creation events are handled before target user-mode execution. Only the
identified ntdll exported DbgBreakPoint address on the initial thread, at first
chance and once per captured process, can be consumed. Its DLL volume/file ID
must equal the trusted helper's actual loaded ntdll. An unknown initial
breakpoint fails the experiment; application exceptions are forwarded with
DBG_EXCEPTION_NOT_HANDLED. The address rule itself needs native validation.
Image/DLL file handles are closed; Windows owns debug process/thread handles
through their exit continuation. Separately returned process handles remain
owned by the helper. No attach, privilege enabling, unrelated-process access,
memory/context modification, runtime patch, host ACL/map mutation or ordinary
execution fallback exists. LPAC, file ACLs and the non-breakaway job remain the
boundary; mapping only enables availability.

The event deadline is checked even under continuous events. Early launch errors
also terminate the owned job and drain debug events before polling job cleanup.
Native waits, inspector child waits and outer registry captures have diagnostic
deadlines. This bounds the experiment, not product or workflow concurrency.
Forced termination is recorded as failure; it is not graceful-cleanup proof.

## Gates still required

Passing this initial gate does not cover or waive:

- The complete inherited/helper/job/token/process/control handle matrix and
  cross-task namespace/file denial. Distinct markers alone do not prove denial.
- Global-map identity, complete caller token identity and network denial. Caller
  mapping/privilege snapshots are only the specific observations listed above.
- Explicit child DEBUG_PROCESS, detach and debug-inheritance-disable cases,
  continued LPAC/job/ambient denial and truthful mapping availability limits.
- Loader breakpoint identity across kernels, handled/unhandled application
  exception fidelity and exact exit-status preservation in those scenarios.
- Cancellation, helper death, all exit-event races and draining on those paths,
  all handle/object/view/profile cleanup under abnormal termination.
- A bounded NUL-compatible endpoint with immediate EOF reads, discarded writes,
  simultaneous modes, real Bun ignore/pipe/inherit behavior, resource figures,
  and independent feasibility review. A marker is not a NUL endpoint.

Actual Windows Server native output is required even for this initial gate.
No provider, installed account, real contact or production support is tested.
