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
The generated helper also includes `identity.h`, `ownership.h`, `roundtrip.h`,
`startup-site.h` and `startup-site.json`; their hashes are part of the manifest.

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

Creation events are handled before target user-mode execution. Only the exact
verified `LdrpDoDebuggerBreak+0x35` INT3 on the initial event thread, at first
chance and once per captured process, can be consumed. Its ntdll volume/file ID
must equal the trusted helper's loaded ntdll, which must pass the pinned PE,
RSDS and complete 62-byte runtime-function fingerprint in `startup-site.h`.
An unknown image or startup breakpoint fails the experiment; application
exceptions are forwarded with `DBG_EXCEPTION_NOT_HANDLED`. A range, basename,
first breakpoint or guessed symbol offset never suffices.

The d63e9d54 run disproved equality with exported DbgBreakPoint. The fc39484d
Server 26100 run identified the actual second image as System32/conhost.exe,
confined, and its exception on the exact initial TID at matching ntdll RVA
0x11ee1d. The Microsoft image and matching public symbols establish the precise
site; `startup-site.json` records both official URLs and SHA256, PE identity,
PDB GUID, DBI age 1, separate PDB Info age 4, symbol section/offset and runtime
function bounds. This is a pinned diagnostic candidate, not cross-kernel support
or fresh native success. Other native images remain fatal.
Image/DLL file handles are closed; Windows owns debug process/thread handles
through their exit continuation. Separately returned process handles remain
owned by the helper. No attach, privilege enabling, unrelated-process access,
memory/context modification, runtime patch, host ACL/map mutation or ordinary
execution fallback exists. LPAC, file ACLs and the non-breakaway job remain the
boundary; mapping only enables availability.

## Startup identity and owned-map observations

For every normal creation event, log the exact native file path, volume/file ID,
size and write time from the event file. Independently open the process's queried
image path read-only and require its file ID to agree. Compare that identity with
the synthetic target opened before root resume, or the exact file ID of conhost
opened read-only from GetSystemDirectoryW. Record `target`, `auxiliary`, or fatal
`unknown`, plus root/auxiliary position, event/handle thread IDs, thread owner,
image base and start address. A basename alone never classifies an auxiliary.
All captured processes still require the full LPAC/job boundary before mapping
and continuation. Three unique inspector PIDs must match three exact target
identities, each with one identified console auxiliary. The hidden root uses
CREATE_NEW_CONSOLE; ordinary children use CREATE_NO_WINDOW, which also produces
a separate conhost on the observed Server image. Bind the root's native parent
to this helper, each later target to a live captured target with no previous
target child, and each auxiliary to a live captured target with no previous
console helper. Unknown, exited, auxiliary or self parents are rejected. At most
three targets and three auxiliaries enter mapping/continuation. Tests require
the exact three-generation parent chain, one distinct auxiliary parent per
target, and six mapped processes, consumed startup exceptions and normal exits;
each PID must have its own verified boundary and exact startup site. No
auxiliary can satisfy any of the three marker/exit generation assertions.
After a normal root exit, continue its exit event and allow five seconds for
the console helper's orderly exit; a timeout still terminates the job, drains
and fails. An abnormal root exit keeps the original immediate termination path.

The 6aadedd5 Server run forwards the custom application exception once at each
MinGW root, then refuses a second exact conhost image before mapping it. SDK
stops earlier with error 13, without enough event information to attribute it.
The e3cf335f run identifies SDK's event as UNLOAD_DLL_DEBUG_EVENT (7), and
MinGW's second conhost has the second exact inspector as native parent, with
the full LPAC/job boundary independently verified before the old count refusal.
Record ProcessBasicInformation only through each captured event process handle,
including query status, returned size, process and parent IDs; require success,
the exact expected size, matching process ID and a DWORD-sized parent. Never
open that parent PID. Parent association supplements file identity and LPAC/job
verification; it cannot replace them. A second auxiliary for the same target
still fails, rather than merely increasing a global count bound.
Handle ordinary DLL unload events on captured live processes, logging their
base; unloading the verified ntdll remains fatal before that base can be reused.
Log the first fatal event kind/PID/TID/error before termination and the native
error/type of RIP_EVENT; RIP and unknown event kinds still fail and drain.

Record matching ntdll file identity, local PE machine/timestamp/image size,
export RVA and the local RSDS PDB name/GUID/age key when present. At exceptions,
record actual/main thread IDs, verified-native-image membership and RVA for
future exact symbol lookup. Metadata alone do not authorize an exception.
Unknown startup breakpoints remain fatal; unexpected/application exceptions
retain `DBG_EXCEPTION_NOT_HANDLED`. Each of the three target generations also
raises a continuable application exception with `RaiseException` after startup,
using the customer-defined code `0xe0424f49` rather than a breakpoint code.
Its vectored handler requires the owned marker and PID, must run exactly once
and be removed; the host must log those two parameters with consumed=0 and
DBG_EXCEPTION_NOT_HANDLED. The handler does not change any context.
The 8a3660ad native run showed the previous raw INT3 fixture repeating at
DbgBreakPoint: continuing unchanged resumes at the trapping instruction.
That fixture could not demonstrate handling without a context change.
The ec43df09 Server run compiled with both compilers, but software-raised
EXCEPTION_BREAKPOINT was followed by first- and second-chance access violations
one byte before its exception address. The application code avoids breakpoint
instruction-pointer semantics; no supplied context or instruction is modified.
This scenario verifies a continuable software exception; unhandled traps
remain a separate required gate. Unknown startup exceptions retain failure termination
and drain. Creation/exiting thread and process events are also recorded.

For map lifetime, query `ProcessHandleInformation` (51) on this helper only,
with a 1 MiB allocation ceiling. From its own directory handle's type index,
compare candidate handles with that live handle using `NtCompareObjects`.
Only exact matches are emitted; no foreign table or unrelated handle contents
are queried, and no matching extra handle is closed. Observe after directory
creation, after link creation, before/after every map assignment, and before/after
each known owned handle closure while the directory anchor exists. Compare the
matched local handles with `NtQueryObject` counts. A count alone, especially
PointerCount with kernel fast references, still cannot establish a leak owner.
An unsupported, malformed or failed snapshot remains an error.

The fc39484d native snapshots showed exactly one local anchor throughout;
global HandleCount rose from one to two at first assignment. RED's name vanished
only after helper exit, while A/B names survived separate post-exit observers.
This identifies the first retained phase, not the owner of the other handle.
ContinueDebugEvent owns closing event process/thread handles on exit, as the
Microsoft API contract specifies; do not close those borrowed values manually.

RED now performs one bounded map-lifetime experiment before ResumeThread of its
already confined suspended root. With the same private ACL it creates an empty
owned directory B, assigns known A -> B -> A to that exact root and samples both
objects after each call. PHNT's PROCESS_DEVICEMAP_INFORMATION.Set input is a
directory handle with DIRECTORY_TRAVERSE; both explicitly created handles have
that access. No original or ambient map is inferred. Any failed restoration
aborts launch and terminates the job. Root's later positive marker proves the
expected A mapping was restored. B has no link and the root's user thread stays
suspended while it is assigned. Only the explicitly created B handle is closed,
after restoring A.
Its namespace is checked immediately after restoration, again at final cleanup,
and independently after helper exit. Every failed absence stays fatal even if
a later observation is absent. A/B debug tasks remain independent behind the
existing RED safety prerequisites. This experiment does not claim a retention
fix, transfer ownership of a kernel handle, or authorize closing one.

After the exact spawned helper has exited and its capture reached EOF, a new
registry-owned helper opens only the recorded `boite.route.<helper-pid>` name
and, for RED, its exact `.swap` name read-only. This is recorded separately by
kind as `mapAfterHelperExit` and `map-after-exit-*.log`.
Absence after helper exit can distinguish helper-local retention from persistence,
but never replaces the immediate in-helper absence gate or its fatal failure.
Post-exit observation failure also blocks state deletion. No extra reference is
held across cleanup polls, and only explicitly acquired handles are closed.

The event deadline is checked even under continuous events. Early launch errors
also terminate the owned job and drain debug events before polling job cleanup.
Native waits, inspector child waits and outer registry captures have diagnostic
deadlines. This bounds the experiment, not product or workflow concurrency.
Forced termination is recorded as failure; it is not graceful-cleanup proof.

## Registry ownership trace

The opted-in native launcher generates separate instrumented copies of the
current Windows `jobs.ts` and `jobs-worker.ts` under `ownership-source/` before
importing the core. Both original SHA256 hashes are pinned; checked single-match
substitutions preserve native calls, branches and ownership decisions. Relative
imports resolve to the original source files; only the worker entry points at
the generated worker. `sha256.json` includes the actual relative artifact paths
for both generated modules, preload and provenance. Compile-only runs do not
install interception or require a native harness, even on opted-in Windows.

A test-only Bun preload redirects the canonical jobs module before either the
launcher registry or the native test harness imports core code. Both owners
verify this interception; a missing owner or incomplete trace fails the trace
summary. The native child uses `bun test --preload <file> <test>`: putting the
preload flag before `test` selects a package script on the tested Bun version.
The isolated two-owner test exercises that actual command and checks the
canonical module and `ProcessPlatform.attach` together.
Each generated worker receives the current compiler directory and owner explicitly
through Bun Worker argv, then records `worker-configuration`; it does not rely on
worker environment inheritance. The 035e2065 Server run lacked the launcher's
worker files, so its reconciliation was incomplete despite both main owners
being intercepted. A real-worker test removes those environment values and
requires independent SDK/MinGW trace files through the explicit arguments.

Each compiler has a separate `ownership/` trace directory. A registry
and its worker record separate owner PID/thread files with monotonic sequence,
monotonic nanoseconds and common wall-clock milliseconds. Worker acquisitions,
send/post/receive stages, captured PID/creation identity, tracked records,
STILL_ACTIVE deferrals and original closure results retain distinct handle
generations. Pending transfers are separate from records retained by the main
thread. The final summary reconciles transfers and successful closures by their
generation identity, never by a reused numeric handle alone.

Only already-acquired or explicitly transferred process handles are observed.
The original CloseHandle executes once and its return/error are captured before
telemetry. Reads and file writes preserve the original thread's GetLastError.
There is no new process open, duplication, foreign table query, flush, release
policy or tracker disablement. Undecodable identity, missing transfer, failed
closure or missing owner shutdown makes the evidence incomplete. A failed-close
value is not queried again. Snapshots run every 250 ms while an owner is active,
with a 180-second diagnostic ceiling; hitting it marks evidence incomplete.
Timers stop and individual append operations retain no open file descriptor.

After the unchanged immediate and 2-second map-absence gates, an owned helper
emits `ownership-checkpoint` with helper PID, exact verified target PIDs and
wall-clock time. It remains alive for 3000 ms, then separately logs a read-only
`checkpoint-map-open` of its exact recorded directory name and closes that
observer. This later observation never replaces either gate or clears its
fatal error. The trace changes no production behavior and does not establish a
retention owner until fresh Server results correlate those observations.

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
