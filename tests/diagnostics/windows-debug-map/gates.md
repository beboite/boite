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
The generated helper also includes `identity.h`, `ownership.h`, `roundtrip.h`, `setter.h`, `creator.h`,
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

## Matched assignment-caller experiment

The original RED and concurrent A/B cases retain their existing roundtrip,
boundary and fatal cleanup assertions. Two additional root-only cases follow
their independently established process/caller/ambient safety prerequisites:
DIRECT creates and assigns its private map once in the helper; SCOPE creates
the same kind of map in the helper but assigns it in a trusted setter child.
Neither additional case performs RED's A/B/A roundtrip. The creator/helper stays
alive through target exit, owned-handle cleanup, immediate and 2000 ms absence
gates and the later ownership checkpoint. Root marker success and descendant
map loss are checked independently of cleanup, as in RED.

The setter receives exactly two purpose-made inheritable duplicates through
PROC_THREAD_ATTRIBUTE_HANDLE_LIST: the captured target with SET_INFORMATION,
QUERY_LIMITED_INFORMATION and SYNCHRONIZE, and the owned directory with QUERY
and TRAVERSE. The parent's transfer duplicates close immediately after creation.
Before assigning, the setter validates the target's captured PID and creation
time, live state and the directory's exact object name/type; it clears both
inherit flags and never creates a child. Invalid arguments cannot authorize
explicit handle closure. It only calls ProcessDeviceMap on that supplied
target, closes both validated received handles and reports through its exit code.
It inherits no stdio or job handle and never changes its own device map.

The setter starts suspended, enters a separate kill-on-close job and only then
resumes. The helper waits at most five seconds for its successful exit, closes
the three captured setter/job handles and requires success before the original
root ResumeThread. Failure kills only this captured setter or its owned job;
the original failure path terminates the still-suspended target's owned job.
Transfer and closure logs supplement the registries' process-handle trace.
Ordinary NUL/drive/map/privilege observations must remain equal throughout.
Reconcile the setter PID's captured registry handles as well as mapped target
handles before attributing a negative result to setter process-object lifetime.

A changed SCOPE cleanup outcome compared with DIRECT would implicate the
assignment caller in this fixture, without identifying the kernel owner. Equal
failures would show that early setter exit alone does not cure retention.
Equal successes would instead implicate the removed roundtrip or another RED
difference. No outcome grants production admission or retroactively passes an
original cleanup failure. Native SDK/MinGW results are required; cross compilation
alone establishes no routing, lifetime or Server support.

The fd0f6ba4 Server run keeps both DIRECT and SCOPE maps through all absence
gates. The setter exits normally, and its two captured registry handles close
2076 ms (SDK) and 2084 ms (MinGW) before the still-retained-map checkpoint.
This excludes those captured setter handles at that checkpoint; early setter
exit alone does not cure this fixture. It does not identify the kernel owner.

The diagnostic captures the existing SetProcessWindowStation, CloseDesktop,
CloseWindowStation and three stream CloseHandle return values once in their
original order. Failure codes are saved immediately, before logging, and remain
fatal. No new USER32 call is made before creation, so thread-desktop initialization
is not perturbed. In particular, this experiment neither adds SetThreadDesktop
nor changes cleanup to make a map disappear. A failed desktop close would show
an incomplete teardown, without proving its relationship to map retention.

The c8fd2bf4 Server run reports success for all three stream closures, station
restoration, desktop closure and station closure in every SDK/MinGW case. The
maps still persist immediately, after 2000 ms and at the later checkpoint.
Failed returns from these cleanup calls therefore do not explain that run.

QUIET matches DIRECT's root-only assignment without the A/B/A roundtrip. Only
the optional ObjectBasicInformation counts and ProcessHandleInformation snapshot
observations are disabled, including their NtCompareObjects calls. Counters
require zero such queries for QUIET and nonzero queries for every original case.
Object identity queries needed by the boundary and caller observations remain.
Registry tracing, caller/ambient equality, marker routing, job confinement,
normal descendant exits, successful owned-handle/stream/window closure, immediate
and eventual map absence, checkpoint and independent post-exit observation all
remain mandatory. RED/A/B/DIRECT/SCOPE retain their count/snapshot assertions.

A changed outcome between DIRECT and QUIET would implicate this group of
optional observations, without identifying an individual API or kernel owner.
Equal retention would exclude removing that group alone as a remedy here.
The original failures remain fatal regardless of the control's result. Native
SDK/MinGW execution is required; this control grants no production admission.

The dab398d5 Server run reproduces this negative QUIET comparison with the same
diagnostic source: 26 manifest hashes verified, SDK/MinGW ownership complete at
277/279 acquisitions and closures, and all 72 stream/window cleanup calls succeed.
All six primary maps still exist immediately, after 2000 ms and at the later
3000 ms checkpoint. All seven names per compiler are absent after helper exit;
RED's empty swap already disappears after restoration. This excludes neither an
unidentified kernel holder nor a creation/acquisition lifetime effect.

REOPEN matches DIRECT's root-only, helper-local, single assignment. After the
unchanged directory and NUL link creation, it explicitly opens those exact owned
names while both creation anchors remain held. NtCompareObjects must identify
each opened object with its creation anchor; native name, exact access/attributes,
noninheritability and the link's unchanged NT destination must also agree.
Only then do the two known creation handles close and the opened handles become
the anchors. Local snapshots must show two directory handles before handoff and
one afterward, before assignment. No zero-handle interval, namespace enumeration,
map replacement, creator process change or unknown handle closure occurs.

REOPEN requires the same root marker/descendant-loss, LPAC/job, caller/ambient,
normal-exit and immediate/eventual/checkpoint cleanup gates as DIRECT. Malformed
observations, open/identity/target/closure failures and incomplete handoff abort
before target resume. The original RED/A/B/DIRECT/SCOPE/QUIET assertions remain.
If reopening changes retention, it is a confound for a future external-creator
experiment; if both retain, reopening alone is not a remedy in this fixture.
Neither result identifies a kernel owner. Native SDK/MinGW results are pending;
strict cross compilation alone establishes no lifetime or production success.

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

## Matched creation-context experiment

The 25f4d364 Server run verifies all 26 manifest hashes. REOPEN retains its map
at immediate, 2000-ms and additional 3000-ms checkpoints under SDK and MinGW,
despite verified 2-to-1 local-handle handoff before assignment. Both compilers
have exactly 22 failures, limited to the seven cases' exit/immediate/eventual
gates and retained synthetic state. All 84 stream/window cleanup calls succeed;
318/318 and 321/321 captured registry handles close. All eight owned names per
compiler are absent after helper exit. Reopening alone does not cure retention;
this does not identify a creator, setter or kernel owner.

CREATOR matches REOPEN's root-only execution, names, marker destination, explicit
self-relative descriptor, creation calls/flags and opened-anchor access. Only
creation moves into a temporary trusted child. The parent holds the exact image
file against replacement, verifies the captured child's file ID, PID/creation
time, session and membership of a separate kill-on-close job before resume.
Its handle list contains just one preconnected overlapped pipe endpoint. The
parent closes its transfer endpoint before resume; no target, token, map, job,
thread or stdio handle is passed to the creator. The pipe admits the existing
caller user only and rejects remote clients; no host ACL or map is changed.

A versioned, exactly sized request binds the nonce and captured process identity
to the precomputed directory, NT destination and bounded descriptor bytes.
RtlValidRelativeSecurityDescriptor validates offsets against the received byte
extent before use. The child creates directory/link without OPENIF and holds
both anchors through READY. The parent opens only the exact directory and its
relative NUL link, validates names, rights, attributes, noninheritability and
destination, then sends HANDOFF. RELEASED follows successful closure of both
creation anchors; only then does EXIT allow child exit. Exit 0, known resource
closures and unchanged caller observations precede the helper's single map
assignment and the original target resume. Every original control and fatal
cleanup gate remains required. The creator's PID, creation time and exit wall
time supplement both registry traces; exit alone proves no process-object
destruction. Reconcile those captured handles at the later map checkpoint.

Connection, message reads/writes and process waits are bounded. A timed-out I/O
cancels only its exact OVERLAPPED operation. Its event/buffer remain alive until
completion; an undrained cancellation remains fatal and retains its backing
memory until process exit, with io-retained=1, rather than returning a dangling
buffer. Only the captured creator or its job can be terminated on failure; the
existing failure path terminates the still-suspended target's owned job.
Every acquired I/O event must close, including on rejected protocol exchanges.
Five additional native probes require rejection before target execution for a
wrong nonce, truncated descriptor, truncated message, early exit and stalled
reply. Each checks successful owned-handle cleanup and exact-name absence both
before and after helper exit. None can substitute for CREATOR's normal
routing/cleanup proof.

If REOPEN retains and CREATOR releases, only the changed creation/handoff context
is implicated. Creator lifetime would still need the otherwise identical arm
kept alive with both creation anchors already closed before target resume, then
observed after its exit while the outer helper remains alive. If both retain,
early creator exit does not resolve this fixture. Cross compilation and static
review establish no native result or production admission for this control.

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
