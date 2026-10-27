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

`generate.ts` reads the frozen historical `tests/diagnostics/windows-protected-reference.c`
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

The 66b66bc4 Server run verifies 26 hashes. MinGW completes CREATOR's exact
handoff, exit 0, five owned-handle closures and six I/O-event closures before
the original single assignment; the root reads its marker and descendants
retain the expected root-only denial. Both captured registry handles for the
creator PID/creation identity close 2073 ms before the ownership checkpoint
starts. The map still exists immediately, after 2000 ms and after the additional
3000-ms hold. Early creator exit therefore does not resolve this fixture.
All five malformed/timeout probes pass, including bounded cancellation and
name absence before/after helper exit. MinGW has exactly 25 failures, limited
to the eight normal cases' exit/immediate/eventual gates and retained state;
456/456 registry handles close and all 48 normal-case stream/window cleanup
calls succeed. SDK execution is blocked by three deprecated wcscpy calls under
-Werror. Their replacement uses bounded memcpy after checking source lengths;
fresh SDK compilation/execution remains required. Production still fails all
seven NUL probes per compiler; no cause or production acceptance is established.

The d82f8c44 Server run verifies 27 hashes and compiles with both SDK and
MinGW. Each compiler completes CREATOR and all five fault probes, but retains
the map through the immediate, 2000-ms and additional 3000-ms gates. The
creator's two recorded registry handles close 2068 ms before the SDK checkpoint
and 2072/2074 ms before the MinGW checkpoint. SDK closes 454/454 captured registry
handles; MinGW closes 457/457, with no ledger failures. All 96 normal-case
stream/window cleanup calls succeed. Each compiler has exactly 25 diagnostic
cleanup failures and seven production NUL failures. Early creator exit alone
therefore does not resolve this fixture with either compiler.

## Exited-root retirement control

RETIRE matches DIRECT through its single assignment, root marker, expected
descendant map loss and normal exits. Only after the owned job reaches zero,
the original root handle is signaled and its exit status is available, create
an empty unnamed directory with the same security descriptor. Verify its empty
object name and noninheritable handle; replace only that captured, already
terminated root's map before closing the original process/thread handles.
Require the root to remain signaled with its exact exit status unchanged.
Close the known unnamed handle and retain every original named-map absence,
caller/ambient, profile and registry gate. No target resumes and no inferred
ambient map or foreign handle is restored, inspected or closed.

The existing RED A/B/A control already demonstrates that replacing a map can
release its old counted handle. RETIRE asks whether that replacement is also
possible after root termination. Success would establish only that the named
working map can disappear before helper exit. The anonymous replacement may
still have kernel references: its complete rundown, descendants, cancellation
and a real NUL endpoint would remain separate requirements. No native RETIRE
result or production admission is established by compilation.

The 5694aa2a Server run verifies 27 hashes. SDK and MinGW both accept
replacement of the exact signaled root after job-zero, preserve exit 1 and
close the known anonymous handle. The old named map is absent immediately,
on the first bounded-poll attempt and at the additional 3000-ms checkpoint.
All eight earlier cases retain their 25 fatal failures per compiler; each
compiler still fails seven production NUL probes. SDK closes 497/497 captured
registry handles and MinGW 499/499; all 108 normal stream/window calls succeed.
This proves named-map retirement only, not anonymous-map rundown or production
admission.

RETIRE-NAMED is a separate matched control. It gives the empty replacement the
exact owned name `<original-map>.retired`, with no OPENIF, shadow directory or
links; it otherwise retains RETIRE's descriptor, rights, signaled PID, job-zero
and exit-status checks. The helper verifies the returned exact name and
noninheritable handle before assigning it. After closing that known handle and
the original process/thread/job/working-map handles, require replacement-name
absence immediately and after the existing 3000-ms ownership checkpoint. Each
successful observer open closes before returning. An external observer also
requires both owned names absent after helper exit; post-exit absence never
substitutes for either earlier gate. RETIRE and all previous cases remain.

A retained replacement would show that named-map retirement can relocate
retention to a new empty map. An absent replacement would establish only this
named empty-directory arm's absence; it would not prove every anonymous object
reference gone, debug-descendant or cancellation cleanup, or NUL compatibility.
No RETIRE-NAMED native result is established by local compilation.

The dee68dc4 Server run verifies 27 hashes. Both compilers complete
RETIRE-NAMED's guarded replacement, preserve the terminated root's exit code
and close the known replacement handle. The original name disappears
immediately; the replacement name remains at both in-helper gates. Each
compiler reports the same 25 earlier failures plus the replacement's failed
exit/absence gates and two failed external-observer assertions, for 30 total.
The external observer rejects `.retired` with path error 123 before attempting
an open, so replacement existence after helper exit remains unknown. The
observer now admits only this additional exact suffix; the existing post-exit
assertions remain, and near-match/nested suffixes must still fail before open.
SDK closes 545/545 captured registry handles, MinGW 547/547, and all 120 normal
stream/window cleanup calls succeed. Five creator fault probes pass for each
compiler. Production remains 0/7 NUL error 5 per compiler. The in-helper result
shows that named-map retirement can leave the new empty name retained; no
complete rundown, owner attribution or production admission is established.

The 327bba06 Server run verifies 27 hashes and closes the observer regression:
under both compilers, the exact `.retired` observer succeeds after helper exit
with absent=1, and both near-match/nested paths reject with error 123 before
open. The replacement still exists at both earlier in-helper gates. Each
compiler retains 28 fatal diagnostic failures and seven production NUL failures;
all 12 observed names are absent after helper exit. Captured registry closures
reconcile 557/557 and 559/559; all 120 normal stream/window calls succeed.
Neither post-exit disappearance nor the parser repair establishes full cleanup
while the helper lives or identifies a kernel owner.

The same existing RETIRE-NAMED arm now observes its owned replacement once more
after launch returns and the final caller snapshot completes, helper still
alive. This covers the interval after the remaining SID/group/command-line
cleanup; its exact-name observer closes before returning. Final absence is
required in addition to every prior gate, never as their substitute. The
already-existing launch-token and boundary-token CloseHandle calls now capture
their immediate result before logging; failed closure is fatal. Assertions
require the root launch token and all verified target/auxiliary boundary tokens
closed. No new token, handle, assignment, arm or cleanup reorder is introduced.
A retained final name with successful closures would rule out incomplete
explicit launch cleanup as a sufficient explanation, without attributing an
internal reference. No native result of this added observation is established
by compilation.

## Target creator lifetime pair

TARGET-EXITED and TARGET-WAITING retain the root-only RETIRE-NAMED setup and
every original immediate, eventual, checkpoint, final and post-helper gate.
Only the suspended LPAC target's CreateProcess call moves into the exact trusted
helper image. The controller still creates the map/link, adjusts the target
token default, verifies its boundary, assigns/resumes it and performs retirement.
The intermediary creates no job, requests no breakaway or PARENT_PROCESS, and
never resumes the target. It inherits the existing ancestor chain; the same
private target job is supplied atomically in the target's JOB_LIST, with the
same LPAC capabilities, descriptor, desktop, argv, environment, cwd and three
stdio handles. No production source, job identity/name/policy or assignment
changes.

Two private 5-second barriers block intermediary resume and target handoff.
Each requires exact PID/creation identity and equal membership in the actual
owned global/thread job references of BOTH launcher and harness. The generated
jobs copy emits launcher membership automatically at its existing tracked
event; the harness queries its existing captured handles afresh. Record
globalJob/nestingRefused and actual membership, including an explicit missing
global job or nesting refusal. Missing acquisitions, identities or memberships
never release a barrier. No PID is reopened for these checks, no job/process
handle is transferred out of its registry, and no assignments or access masks
change. This verifies the two registries' owned ancestor jobs; it does not
enumerate or identify any other runner-owned jobs.

An owner-only nonce-bound overlapped pipe carries extent-validated frames,
the exact self-relative SD and independently validated package/capability SIDs.
The intermediary initially inherits only that pipe, a minimal QUERY/ASSIGN
duplicate of the private job and three stdio duplicates. Its target HANDLE_LIST
contains only the three stdio handles. The controller duplicates only the two
explicit newly returned target process/thread handles through its captured
intermediary process handle, while their source handles remain live until the
handoff acknowledgement. No table search, PID reopening or remote close occurs.
Before acknowledgement it validates creation identity, thread ownership,
image file ID, native parent, private job, noninheritance and exact process/thread
DACLs. Windows maps GENERIC_ALL in the created process/thread DACL; compare
against the expected object-specific PROCESS_ALL_ACCESS/THREAD_ALL_ACCESS
mask, without changing the descriptor passed to CreateProcess. Both ACLs
must otherwise retain the exact header, ACE count/order/type, inheritance
flags, trustees and rights; missing/additional bits or malformed extents
refuse handoff. DACL protection must remain set. Log raw equality, the object
mapping and the exact comparison result. The original controller token
setup and boundary checks still precede map assignment/resume.

RELEASED requires the intermediary to close its two target handles, job/stdout/
stdin/stderr duplicates and attribute resources; only its control channel and
bounded I/O event remain among known resources. TARGET-EXITED requires exit 0,
controller closure and a third closure-only handshake reconciling every known
creator reference in both registries before map assignment/root resume.
TARGET-WAITING keeps the same intermediary alive through the unchanged final
gate, then requests exit and the same registry reconciliation while the outer
helper remains alive. Only after that handshake, observe both original and
replacement names with no observer spanning creator exit. Earlier failures
remain fatal even if this later observation succeeds.

Creation/handoff takes at most 5 seconds after intermediary resume; its control
wait has an independent 30-second lifetime. Each I/O cancellation gets a 1-second
drain; an undrained heap-backed buffer/OVERLAPPED remains alive until process
exit and makes the trial fatal. Cleanup uses only captured intermediary and
owned target-job handles. Parent and successful-child I/O event acquisition/
closure counts must match. Five native protocol faults (nonce, descriptor
extent, short frame, premature exit, stall) and two comparison-only rights
faults (process/thread) must reject before any target instruction or map
assignment and reconcile cleanup. The rights faults change only an expected
comparison mask; no security descriptor or object is modified. The same
serialized ACL comparator runs in a portable C regression with 18 cases,
including mapped rights, missing/additional authority, changed trustees,
inheritance, ACE order/type and invalid extents. Portable tests also exercise
invalid identities, missing/wrong owner membership, nesting refusal, transfer/closure evidence and
actual barrier release. The aggregate diagnostic test/launcher watchdogs allow
150/170 seconds for the additional cases; existing per-target/process/map
deadlines and all required production suites are unchanged.

Releasing only after an exited target creator would correlate the fixture's
retention with that lifetime, without identifying an internal owner. An invalid
protocol/identity/topology/closure makes the comparison unusable; no production
admission follows.

The first native attempt at 687b341f did not establish this comparison. The
SDK rejected five deprecated string copies under -Werror; MinGW rejected both
arms with ERROR_INVALID_ACL before root membership or handoff. Its seven
creator-phase proofs and five protocol faults passed, and all 705 registry
references closed. The GENERIC_ALL mapping regression fails against the old
raw byte comparison and passes after normalization.

The corrected bebaad5f run compiles under both SDK and MinGW. Both TARGET arms
complete exact process/thread ACL checks, the three membership/closure phases,
handoff, root-only marker routing and creator exit 0. All seven target faults
reject before target execution and map assignment. Registry process references
reconcile 783/783 (SDK) and 785/785 (MinGW). Both arms retain their replacement
at immediate/checkpoint/final observations; TARGET-WAITING also retains it after
creator exit and registry closure. All 16 observed names per compiler are absent
after outer-helper exit. Each compiler records 38 fatal diagnostic failures,
including the earlier controls. Early target-creator exit does not release the
replacement in this fixture. The owning reference and cause remain unknown;
this does not isolate helper lifetime from ancestor-job lifetime. Required
production suites still fail all seven cases per compiler on NUL access error 5.

## Independent ordinary pipe semantics

The 5d3a9d6a run verifies 39 source/helper hashes. Both ordinary pipe probes
compile and complete 32 EOF reads, 32 zero-message writes/flushes and 32 64-KiB
writes, with 225/225 I/O events, three joins and nine fixture handles closed.
SDK counts only 983,040 received bytes; MinGW counts 1,015,808, and both report
1460. Neither result is accepted. Registry references reconcile 793/793 SDK and
797/797 MinGW; all 38 map failures per compiler and production NUL failures
remain. The artifact does not identify the failing wait or initial read branches.

The overlapped wrapper used the synchronous ReadFile byte output and skipped
GetOverlappedResult after immediate ERROR_MORE_DATA. Microsoft requires
asynchronous callers to retrieve the actual count through GetOverlappedResult.
The wrapper now does so after immediate success or partial completion as well
as pending completion, and preserves partial data for its caller. A queued
32-byte prefix must produce an immediate seven-byte MORE_DATA fragment with
exact contents, then the remaining 25 bytes. Its immediate-partial count and
byte total are recorded separately from the subsequent 2-MiB discard total.
The summary records the main failure stage. This fixes a documented accounting
assumption; whether it explains the observed deficit requires a new native run.
No successful SDK/native result is established for this patch.


The same opt-in launcher also compiles `null-message.c` separately with both
strict compiler configurations and launches it through the real ProcRegistry.
It creates one private message pipe, leaves the client's default byte-read
mode unchanged, sends zero-length messages separated by FlushFileBuffers,
and drains incoming writes independently. Acceptance requires 32 successful
zero-byte reads, 32 zero writes/flushes and 32 discarded 64-KiB writes
(2,097,152 bytes), three joined workers, nine closed fixture handles and
balanced per-operation I/O events. The prefix adds three operations and must
verify both fragments before the concurrent exercise. No pipe handle closes before workers join;
undecidable cancellation keeps its buffer/event alive until process termination.
A 15-second process watchdog and 20-second registry capture bound the trial.

`pre-read-flush-pending=1` records only that the first flush completion event
was still unsignaled during a 50-ms wait before client reads. Scheduling can
affect that observation; it does not establish a general bounded-queue claim.
Results and source/helper hashes remain separate in the diagnostic artifact.
Only a successful process exit and complete exact record can set
`ordinarySemanticsAccepted`; `productionAccepted` stays false. Compilation
alone sets neither semantic nor production acceptance. Map and required native
suite failures remain fatal regardless of this probe's result.

This is an ordinary one-connection experiment. It does not establish LPAC pipe
access, peer denial, reopen/concurrent/read-only/write-only behavior, standard
stream modes, descendant routing or production cancellation/resource bounds.

## Helper exit with the original thread job populated

TARGET-HELPER-EXITED adds one matched TARGET-WAITING arm. It retains the same
creator and ancestor jobs, target JOB_LIST, LPAC/descriptor/marker checks and
RETIRE-NAMED cleanup. There is no added process/job, job assignment, breakaway,
parent substitution, changed access mask, PID reopening or foreign handle query.
All existing arms and fatal immediate/checkpoint/final absence gates remain.

After final cleanup the helper negotiates HOLD/HELD over its existing pipe.
The creator closes its only remaining inherited pipe, with all seven inherited
and target anchors closed and its I/O events balanced, then publishes a private
nonce-bound file containing the three captured identities and a deadline.
The helper verifies that file and closes its own creator/pipe references before
exiting with its real result. The creator's original 30-second lifetime remains;
the file hold independently expires within three seconds of this handoff,
strictly before three seconds after helper exit. Transport faults abort through
only captured owners and cannot count as normal-exit evidence.

The harness awaits the captured helper's exit plus EOF and both registry
process-reference closures. Around each original/replacement name observation,
it requires the captured creator incarnation live in the same owned thread-job
handle/key and ancestor memberships, accounting ActiveProcesses >= 1, matching
launcher registry membership, and no earlier ACTIVE_PROCESS_ZERO for those
keys. Accounting reads use only the generated diagnostic registry's existing
job handle and preserve last error. No populated job is closed or terminated
to manufacture an empty transition.

The harness releases the exact file frame only after both populated
observations, before the three-second deadline. A five-second external budget
covers release, normal creator exit 0 witnessed by both registries' original
exit reads, all reference closures, ActiveProcesses=0 on the same job and both
empty observations. Each observer has a remaining-budget capture deadline;
failed capture cleanup may drain separately but cannot validate the trial.
Protocol validity, accounting/ordering/closure rows and present/absent statuses
are recorded separately in results.json. Existing map failures stay fatal;
the new arm also requires both names absent after the empty transition.

Absence while the helper is gone and this job remains populated would exclude
job emptiness as necessary in this fixture. Persistence until the last member
exits does not identify a unique internal owner. productionAccepted=false.
SDK and MinGW runs at 4ebe6410 and f8add2ae validate this control: both names
are absent while the unchanged job still has two active processes. The
replacement name was retained before helper exit. No internal owner is known.

## Matched DIRECT execution-thread lifetime pair

THREAD-EXITED and THREAD-WAITING append two root-only arms. DIRECT and both
arms call the same generated direct_body function; every other arm keeps its
existing inline body and selection. The worker uses DIRECT's settings, with
no debugger, retirement, creator, roundtrip or new job/process architecture.
Production source and all original fatal gates remain unchanged.

Each helper starts one CRT-managed _beginthreadex callback suspended, captures
its returned owned handle/TID/creation time and helper PID/creation identity,
then resumes it. Main logs its start proof before the body; main calls neither
USER32 nor stdio concurrently with the body. The callback runs the entire
original before/launch/cleanup/after/final body, saves its immutable real result,
flushes output, verifies no known map/creator/pending-I/O anchors, and publishes
READY with Interlocked synchronization. Heap context and argv remain alive
until confirmed join. No OpenThread/OpenProcess, new rights, job assignment,
SetThreadDesktop, ACL/map change or thread termination is introduced.

Both arms first observe the exact successfully created map with the worker
live. Captured helper incarnation is corroborated by the existing owned
registry trace; a private per-execution nonce binds all native phase frames.
The parser independently requires the exact root assignment/marker, lowbox,
descendant denial, normal exits, caller equality and original token/window/
stream/known-object cleanup prerequisites. Missing retained baseline is a
separate reproducibility failure, making comparison inconclusive while keeping
protocol/status evidence and every original absence assertion intact.

EXITED releases the callback to return normally; WAITING remains parked for
the comparison. Both sample at least100ms after READY, recording actual times.
The terminated arm observes first with the known thread handle still held,
then after its successful close. WAITING later releases and repeats normal
exit0/join, held-handle and closed-handle observations with main still alive.
The callback's protocol exit0 never overwrites the body's original failure125.

READY starts a maximum3s park and maximum5s main observation budget. Native
checks surround every identity/query/observation and waits use remaining
budgets; the existing40s whole-helper capture bounds a stuck native call.
An unjoined callback keeps its heap/argv while main waits at most45s for the
existing captured owner to terminate the helper. A late join remains failure;
if the owner watchdog fails, only this helper fails stopped with TerminateProcess
on its own process, without CRT teardown or closing a live worker handle.
Neither forced cleanup nor incomplete phase output counts as evidence.

results.json records protocol validity, prerequisites, body result, retained
baseline, actual phase times and presence separately. Retention through return,
release at normal return and release only after known thread-handle close are
distinct outcomes. Thread termination includes USER32/CRT/TLS rundown; this
pair cannot identify their individual roles or an internal kernel owner.
At f8add2ae both arms validate under SDK and MinGW. Each reproduces retention
with the worker live and keeps the map through normal thread return, join and
successful closure of the known thread handle. All four exact names are absent
after helper completion and registry closures. Worker termination is therefore
insufficient at these measured times; helper termination and external process
reference closure are not yet separated. productionAccepted=false and
CAUSE_CONFIRMED=no remain unconditional.

## f8add2ae native evidence and ignored PID reuse

Run 40243791436 / job 121321816191 executes the pinned source under Windows
10.0.26100 and Bun 1.4.3. All 45 manifest and nine provenance hashes match.
Process reference ledgers balance936/936 (SDK) and944/944 (MinGW), with no
incomplete ledger or failed closure. The ordinary pipe probes remain accepted;
they do not qualify LPAC/Bun or production execution.

All 42 preceding fatal failure labels remain per compiler, with six additional
THREAD cleanup failures. SDK adds one incomplete nonce-fault trial, totaling49
versus48 under MinGW. Its captured creator never reaches the topology proof or
exchange; original launch error1460 remains distinct from abort cleanup1067.
The suspended target and exact-name absence cannot replace missing fault proof.
Original production protected tests remain0/7 per compiler at NUL error5.

The launcher closes the SDK nonce creator's newly captured handle immediately
without tracking it; the harness tracks the same exact incarnation. These logs
do not identify the launcher guard branch. A separate deterministic regression
reproduces a real PID-only ignored-cache bug: a missing old exit packet prevents
a replacement from being traced or terminated through its captured owner.
The registry now reclassifies each newly captured start instead of inheriting
that ignored bit. Duplicate tracked starts and late exits retain their existing
ownership checks. The generated diagnostic logs ignored-pid-reclassification
without additional native reads or rights, and pins the reviewed registry hash.
No timeout, topology, map-cleanup or production acceptance assertion is relaxed.

## decccab2 native registry evidence

Run 40245532358 / job 121326349430 executes the reviewed registry under the
same Windows10.0.26100 and Bun1.4.3. All45 manifest and nine provenance hashes
match. Four SDK starts and one MinGW start emit ignored-pid-reclassification,
then enter tracked with their captured incarnation and receive exactly one
successful close-result. The native trace confirms the new branch runs and
preserves ownership through closure; the earlier missing nonce guard remains
unattributed because its cache branch was not recorded.

All seven target-creator fault trials now reach their required proofs and
cleanup under each compiler. SDK nonce reaches the creator topology barrier,
balances its two exchange events and rejects with the intended original
error13. Abort cleanup1067 remains a separate result. Both complete process
ledgers balance: SDK941/941 references and715/715 transfers, MinGW945/945 and
719/719. There are no incomplete records or failed closes.

Each compiler still records48 fatal diagnostic failures. Both worker arms
retain their original names after normal thread return and handle closure;
the original helper-exited control finds both owned names absent while its
same job still counts two processes. Every production protected test still
fails at NUL error5, zero of seven passing under each compiler. The registry
fix does not qualify map cleanup or protected execution. CAUSE_CONFIRMED=no
and productionAccepted=false remain unchanged.

## Exited helper with one captured process reference

`TARGET-HELPER-HELD` executes the unchanged `target-helper-exited-run` native
body beside the original `TARGET-HELPER-EXITED` control. Before releasing the
root topology barrier, the generated harness registry arms one exact captured
helper reference, bound to its ledger ID, owner, PID, creation time, nonce and
existing job identities. At normal exit125, its original close site transfers
custody into a diagnostic slot. The tracked entry is removed and the original
exit notification proceeds normally. The launcher never arms a slot.

Every other helper reference and worker transfer in both registries must drain
before observations begin. The slot queries creation identity and exit125
through the retained handle before and after each held observation. These
handles lack SYNCHRONIZE: no wait, extra right, process open, duplication,
foreign handle-table read or job assignment is added. Native last error is
preserved. The exact successfully created original and `.retired` names are
observed twice with the reference retained, then again after its one successful
actual closure. The same known creator stays alive and its unchanged job stays
populated around each observation. Results record sample times and captured
registry exits for comparison with the no-hold control.

The existing creator3s hold and5s external observation budget still apply.
An armed slot awaits the normal registry exit packet within that budget;
capture completion alone cannot substitute for the custody transfer. Deadline
or error cleanup closes only the still-proven owned slot, once. Missing,
changed or undecidable ownership and failed closure invalidate the control;
no numeric handle is retried. Creator release, reaping and empty-job evidence
retain their original requirements, as do every fatal map-cleanup assertion
and the protected production tests.

Absence while this exited helper reference is held excludes deletion of its
process object as necessary in this fixture. Retention while held followed
by absence after closure implicates that known reference lifetime, subject to
the separately recorded baseline timings. Neither outcome identifies the
internal map owner or establishes a unique cause.

Run40247292488 / job121331632325 executes head7dde2949 under Windows10.0.26100
and Bun1.4.3. All49 manifest and11 provenance hashes match. SDK and MinGW each
validate four held observations: both names are absent while the exact helper
process reference remains open, the helper has exited125 and the creator is
alive in the same job with two active processes. The retained reference closes
exactly once after the last observation, successfully; both names remain absent
after that close and after creator release. Complete ledgers balance1027/1027
SDK references and1033/1033 MinGW references. All14 target-creator fault trials
retain their required proofs and cleanup.

This excludes final helper-process-object deletion as necessary for namespace
disappearance here. It does not identify the process-termination resource
rundown that releases the remaining state. Each compiler retains52 diagnostic
failures, the previous48 plus four fatal cleanup failures from the new arm.
Production remains0/7 per compiler at NUL error5. CAUSE_CONFIRMED=no and
productionAccepted=false.

## Replacement before versus after normal root exit

`RETIRE-LIVE` and `RETIRE-EXITED` compare the ordering of one replacement
assignment across normal root termination. Both add the same final nonce-bound
barrier after inspector work, descendant joins and owned child-handle closure,
with the original result frozen. The helper verifies the captured root and
original main thread through their existing handles, including creation times,
thread ownership, live process state and the unchanged LPAC/job boundary.
Both arms suspend that owned main thread with previous count0 and resume with
previous count1; the cooperative barrier supplies synchronization. Other root
threads are not claimed to be suspended.

LIVE installs and closes the known empty named replacement while the root is
live and parked, then releases it to normal exit. It must never install another
replacement after exit. EXITED performs the same park, suspend, resume and
release without a live assignment, then uses the existing exited-only
retirement path. Its preconditions remain unchanged for every old arm.
The new pair runs in independent fixtures alongside the existing serial
controls; no existing deadline or fatal assertion is relaxed.
The validator requires the actual directory creation, assignment and anchor
closure lines to appear on the selected side of root exit, in addition to the
phase frames. Child-closure evidence must precede READY. All parallel
continuations, including their post-exit observers, join before the registry
and harness stop on success or failure.

Immediate, checkpoint, final and post-helper namespace observations stay
separate from protocol validity. A retained EXITED replacement and absent LIVE
replacement would implicate posttermination attachment in replacement-name
retention in this fixture. Equal retention would reject ordering alone as a
remedy; equal absence would fail to reproduce the retained comparison. None
repairs DIRECT's original retained map, identifies an internal owner or admits
production. Missing identity/nonce/normal-exit/closure/deadline proof or a wrong
suspend/resume count invalidates the control.

Run40250246620 / job121340539439 executes head9482eb14 under SDK and MinGW.
All52 manifest and11 provenance hashes match. All four timing controls validate
the captured identities, real operation order, suspend0/resume1, unchanged
original result1 and normal root exit. Both timings retain their replacements
at immediate/checkpoint/final:12/12 present observations, with every observer
closed. Original names are absent and all8 names disappear after helper exit.
The live assignments precede root exit; the exited assignments follow it in
actual log order, including the same-timestamp MinGW case.

This rejects posttermination assignment as necessary for replacement retention
in this fixture. Moving it before normal exit is insufficient. It neither
identifies an internal owner nor proves both timings use the same mechanism.
Ownership ledgers balance1123/1123 SDK and1129/1129 MinGW; all14 target faults,
held-reference and worker controls preserve their prior results. Exactly60
fatal diagnostic failures/compiler preserve52 old failures plus8 new timing
cleanup failures. Native suites finish in81.74s SDK and80.94s MinGW, without
changed deadlines. Production remains0/7 per compiler at NUL error5.
CAUSE_CONFIRMED=no and productionAccepted=false.

## Unattached empty-directory twin

DIRECTORY-TWIN is a separate diagnostic control alongside the unchanged
LIVE/EXITED baseline. It compares two owned empty siblings
in one independent LIVE-barrier fixture: attached `.retired` and never-attached
`.unused`. Both use identical SD bytes, access0xf000f, attributes0x40, NULL
shadow, creation flags0, no links and noninherited anchors. Matched explicit
opens are checked against their live owned anchors and closed; only `.retired`
can enter the single replacement assignment. Both creation anchors must close
before the root resumes/releases. Collision or identity failure never grants
ownership or permission to observe the collided name.

The same immediate/checkpoint/final/post-helper observations distinguish
protocol validity from fatal cleanup gates. Exact suffix validation must admit
only `.unused`, rejecting near matches. Unused absence with attached retention
would exclude ordinary creation/open/close alone as sufficient here. Equal
retention leaves shared helper/namespace or attachment side effects unresolved;
equal absence fails to reproduce the retained comparison. No result identifies
an internal reference owner or grants production admission. All old controls,
deadlines, caller/confinement/cleanup gates and joined-observer requirements
remain. Local validation reports50 pass,1 native skip,0 fail and535 assertions;
types, architecture and both strict MinGW compilations pass. All11 worker-owned
source hashes match the compile manifest. The parent reviewed the final delta
and revalidated the four prior native timing controls with the shared validator.
Run40252765978 / job121348217179 executes headf04322fe on kernel10.0.26100
with Bun1.4.3. All56 manifest and11 provenance hashes match. SDK and MinGW
both strictly compile and validate the18 actual twin operations, nonce, exact
helper/root/thread identities, rights/noninheritance, suspend0/resume1 and normal
original result1. The eight twin anchors close successfully across both helpers.
Never-attached `.unused` is absent in all6 immediate/checkpoint/final observations;
attached `.retired` remains in all6. All6 exact twin names are absent post-helper.
The eight invalid-suffix probes reject125/error123 before a native open result.

SDK1190/1190 and MinGW1193/1193 registry process references close; transfers
balance898/898 and901/901. The14 faults, held-reference, worker and original
LIVE/EXITED controls retain their earlier outcomes. Each compiler has exactly
64 fatal diagnostic failures: the60 old failures plus4 twin failures. Production
remains0/7 at NUL error5. Bun reports native suites81.48s/81.22s, without a
changed deadline. Both ordinary message-pipe semantic probes pass; LPAC/Bun
integration remains unverified. Independent review confirms VALID_DIFFERENTIAL
and no new protocol defect. CAUSE_CONFIRMED=no and productionAccepted=false.

The measured difference associates retention with attachment in this fixture;
ordinary creation/open/close alone is insufficient here. Name suffix and creation
order remain coupled to role. The reference owner, full object destruction and
behavior on other Windows builds remain unknown. No result grants production
admission or clears any earlier fatal cleanup gate.

## Helper anchor overlap at attachment

A separate matched pair, ANCHOR-EXCLUSIVE / ANCHOR-HELD, is implemented
at the same LIVE final barrier. Both arms prepare identical empty attached and
unused siblings. The same suspended trusted setter, outside the private LPAC
target job, receives only a captured root-process handle and the attached
directory handle, with the narrow rights already used by SCOPE. The setter alone
performs this replacement. Parent transfer duplicates and explicit opened
anchors close before either GO. Existing DIRECTORY-TWIN and SCOPE stay unchanged.

The sole intervention is closure of the helper's attached creation anchor:
EXCLUSIVE closes it before GO permits Set; HELD closes it after authenticated
ASSIGNED and before RELEASE permits setter-directory closure. The setter keeps
its known directory handle until RELEASE, closes its validated handles and exits
successfully before root resume in both arms. Private nonce-bound proof binds
helper/setter/root PID and creation, exact names, actual native operation order,
status and closure to the captured root deadline. Logical phase labels alone do
not establish the native close/Set order. No PID reopen, foreign-table scan,
unknown close, global ACL, privilege or caller-map change is permitted.

The setter's5s allowance fits within the original absolute root15s deadline;
helper40s, checkpoint3s and outer budgets stay unchanged. All prior boundaries,
normal result1, caller/token/job/window/stream cleanup and exact-name absence
gates remain fatal. Known setter registry references must close before checkpoint,
using exact PID plus creation. Every continuation and observer joins before
registry shutdown on success and failure.

Protocol validity, reproduction by HELD, unused absence and all cleanup gates
remain separate results. A retained HELD and absent EXCLUSIVE would implicate
the overlap interval here, without identifying an owner. Both retained rejects
overlap as necessary in this fixture; both absent fails to reproduce the matched
positive control. Five concurrent nonce/early-release/assigned/release/stall
faults require rejection before final root resume, balanced owned closures and
post-helper absence. All six actual binary protocol frames are archived,
including partial failure transcripts, for independent native reconciliation.

Local validation reports54 pass,1 native skip,0 fail and626 assertions; scoped
types, architecture1219 modules and both strict MinGW compilations pass. All12
worker-owned source hashes match the compile manifest. Parent review confirms
the final frame-archival delta and unchanged production C; current validators
also retain the four prior timing and two twin native verdicts. SDK compilation,
Windows execution, the five native faults, anchor-pair outcomes and runtime
were not established by those local checks.

Run40256516989 / job121359610880 executes head625b17ea under SDK and MinGW.
All59 manifest and11 provenance hashes match. All14 new arms stop before setter
creation: the first process duplicate is acquired and closed, but verification
returns13 with setter0, files0/0 and exit259. No binary frame or topology proof
exists, and none of the10 configured fault injections is reached. Both normal
protocols correctly reject; the pair is inconclusive, not a negative retention
comparison. All7 original names per compiler remain present post-helper;
the14 sibling names are absent. These abnormal failure paths provide no normal
root result or evidence about the overlap interval.

Registry references close1537/1537 SDK and1543/1543 MinGW; transfers balance
1157/1157 and1163/1163. All64 prior fatal failure labels are preserved, with29
additional failures per compiler from the invalid new controls. Earlier timing,
twin, worker, held-reference and14 fault outcomes remain unchanged. Production
still fails0/7 at NUL error5 per compiler. Independent review confirms
INVALID_PRE_SETTER and no admissible causal comparison.

The first duplicate's guard currently collapses object-query size, granted mask,
handle flags, type or object-comparison mismatches to13. The next delta logs
those actual values and the rejecting stage, preserving the existing strict
mask, short-circuit query order, native calls, return values and all deadlines.
No access normalization is accepted without a measured Windows result. Local
recheck reports54 pass,1 native skip,0 fail and626 assertions; scoped types and
both strict MinGW compilations pass. Independent static review confirms the
guard remains unchanged. These checks did not establish native telemetry,
successful setter handoff or fault coverage.

Run40258008601 / job121364137508 executes integrated heade7e1d34c. All59
manifest and11 provenance hashes match. Every one of the14 new arms reports
the same successful object-basic query: bytes56, requested0x00101200,
granted0x00103200, attributes2. The exact access comparison rejects13 before
GetHandleInformation, type comparison, the second duplicate or setter creation.
The extra0x2000 is PROCESS_SET_LIMITED_INFORMATION. This establishes the
diagnostic guard mismatch, not a retention cause. Registry references close
1538/1538 SDK and1539/1539 MinGW. Prior64 fatal labels and earlier lifetime/twin
outcomes remain; total93 failures/compiler and production0/7 NUL5 persist.
Independent native review confirms all14 measured rejections and revalidates
the four prior timing and two twin traces.

The next delta compares the complete granted mask with0x00103200 only for
the exact Process request0x00101200. DuplicateHandle still requests0x00101200;
the directory request and exact grant remain3. No generic/subset comparison or
additional requested right is introduced. Every other missing or additional
grant bit, handle flag, query size/status and type remains a rejection. Frame
fields continue to record requested rights; child validation uses the same
complete grant check. Existing API order, pair protocol and deadlines remain.

The regression compiles the actual C guard with replayed query results. Before
the change it rejects the measured process grant:0 pass,1 fail. After the change
it passes78 cases, including every single-bit mutation of both granted masks,
inherited/cleared flags and failed query/type paths. This replay does not emulate
kernel access mapping or prove real inheritance. The complete local diagnostic
suite reports55 pass,1 native skip,0 fail and633 assertions; scoped types,
architecture1219 modules and both strict MinGW compilations pass. Independent
static review confirms complete exact comparison and unchanged requested rights.
SDK compilation, corrected native handoff, five actual fault injections and the
anchor retention comparison remain pending. CAUSE_CONFIRMED=no and
productionAccepted=false.

Run40259396602 / job121368480507 executes head9dd94b7d under SDK and MinGW.
All60 manifest and11 provenance hashes match the reviewed sources and generated
C. The corrected grant guard passes. All four normal ANCHOR arms are valid,
with24 authenticated binary frames and exact setter-registry closure before
checkpoint. Both closure orders retain the attached map at all12 observations;
the unused sibling is absent12/12. All12 normal pair names are absent after
helper exit. This is a matched negative for helper-anchor overlap as necessary
here, not an identified owner or unique retention cause.

All ten injections reach their intended rejection before final root resume.
All ten fault-cleanup gates still fail: assigned/release retain the replacement;
nonce/early-release/stall retain the original name after helper exit. Final
references balance1562/1562 SDK and1571/1571 MinGW, but final totals do not prove
closure before an earlier observation. For every fault root, the exact
launcher-main registry reference remains owned throughout that observation
and closes only at final teardown. Independent native review and a separate
parent audit confirm this10/10. All64 older failure labels remain, total77 per
compiler; production still fails0/7 at NUL error5.

## Fault root reference release control

A separate follow-up uses those same five fault arms. Existing observations and
fatal cleanup flags remain unchanged. Within one absolute3s control deadline,
the harness observes the owned names while the root reference remains held,
requests its release through the actual launcher registry, then observes again.
Other exact-incarnation registry references and transfers must drain before
the held observations and remain reconciled afterward. Private compiler/nonce
bound request and response files preserve the actual custody and close result.

Only the exact captured exited125 root with matching PID, creation, owner,
ledger ID and current compiler job can reach the existing reportExit close
path. The registry removes its tracked slot so late events and teardown cannot
close it again. No incoming numeric handle, new process open, duplicate,
unknown close, job close, rights change or production edit is involved.
The existing inspection handle lacks SYNCHRONIZE; terminal state uses its
GetExitCodeProcess result plus the helper's existing job-zero evidence.
No additional wait right is requested. Services and observers join before
registry teardown on errors as well as success.

A later absence never repairs the old fault flags. The new record can associate
a disappearance with this known reference's release, or reject its sufficiency;
it cannot explain the normal matched pair or grant production admission.
SDK/native execution of this follow-up remains pending. CAUSE_CONFIRMED=no and
productionAccepted=false.

Run40262987885 / job121379334706 executes headf751c4c5. All63 manifest
and13 provenance hashes match; generated C is unchanged. All ten owner-held
replies authenticate and other root references drain, but all ten controls
reject their held observers before verified/release. Successful retained-name
observers emit their object query and close records on stderr; the new
validator incorrectly required empty stderr. No controlled release occurred.
Their ten original launcher references close only at teardown, after the
control deadlines. Final references balance1651/1651 SDK and1659/1659 MinGW.
All77 earlier failures per compiler remain, plus five invalid controls each;
production remains0/7 per compiler at NUL error5. This result establishes no
release effect or retention cause.

The parser correction requires the exact successful query-only object record
and matching successful close record for a retained name, with no other stderr.
Absent-name observers still require empty stderr. Exact stdout, exit, timeout,
identity, custody, registry and deadline checks remain. The existing transport
regression fails on the captured native stderr before correction and passes
afterward; failed queries/closes, missing or foreign records and extra output
remain rejected without releasing the root. All30 archived native outputs now
pass the held-observation parser in a replay that performs no native release.
Corrected SDK/MinGW native service and release observations remain pending;
CAUSE_CONFIRMED=no and productionAccepted=false.

Run40264036895 / job121382549194 executes headb777bbf6. All63 manifest
and13 provenance entries match. The corrected parser permits all ten complete
held/verified/release protocols:30 raw phases,10 exact successful native closes
and60 complete observers. One name per fault is retained before release;
all30 names are absent afterward. Other known root references drain before
the baseline, and the selected reference closes between the two observation
batches. SDK1710/1710 and MinGW1716/1716 references close successfully. The
native close event and its returned proof use separate wall-clock samples;
one differs by1ms, both within the authenticated phase interval.

This is a positive fault-specific intervention differential. The eight normal
ANCHOR/RETIRE-LIVE/RETIRE-EXITED roots still retain their retired names after
their two known registry process references and the C root-thread/root-process
handles close. The fault result therefore does not explain normal retention.
All77 older failures per compiler remain fatal, including old fault cleanup;
production remains0/7 per compiler at NUL error5. Elapsed-time/asynchronous
cleanup is not excluded by the single-reference before/after control.

## Matched fault root reference pair

The next diagnostic compares two additional instances of the existing ASSIGNED
fault, with distinct private fixtures/nonces and one shared absolute3s bound.
Both exact exited roots authenticate and drain other references before a shared
baseline. After both verified samples, only one owned launcher reference closes
through reportExit. Both arms then use the same observer window; the held arm's
reference must remain owned until every observer has joined, then close through
the same original owner. Missing custody or natural early closure invalidates
the pair. No unknown handle, new native right or C/production change is involved.

The separate result cannot repair old fault flags or grant production admission.
Local implementation passes75 tests/869 assertions, with one native skip;
scoped types, architecture1219 modules and strict MinGW compilation of both
programs pass. Parent review confirms the shared parser preserves all ten old
controls in an archived-data replay (30 replies), with no native operation.
The two new modules are in the manifest; all20 C/header sources and generated
C remain identical to b777bbf6. SDK compilation, actual paired Windows execution
and the complete observer schedule inside the unchanged3s bound remain pending.
CAUSE_CONFIRMED=no and productionAccepted=false.

## Matched root reference native result and live helper control

Run40266608186 / job121390457293 executes head1b2bb76b. All65 manifest
and13 provenance entries match. Both SDK/MinGW matched ASSIGNED pairs are
valid:30 total observations,12 during the shared comparison windows and four
exact successful root-reference closes. RELEASED.retired is absent while
HELD.retired remains present throughout the same window. HELD closes only after
all six comparison observers join; its final three names are then absent.
The complete schedules take817ms SDK and645ms MinGW inside the unchanged3s.
All ten old release controls remain valid; SDK1933/1933 and MinGW1940/1940
references close, with transfers1439/1439 and1446/1446. Parent and independent
audits agree. This establishes a reference-release effect in the matched fault
protocol; the internal owner and general retention cause remain unestablished.

Eight normal ANCHOR/RETIRE arms still retain retired after all four known
C/registry root handles close. The old77 failures per compiler remain, plus
two new helpers' original retired-post-exit absence failures; no flag is repaired
by the later differential. Production remains0/7 per compiler at NUL error5.
Linux, UI/types and CodeQL pass; Windows is red. No readiness or production
admission follows from the matched result.

The separate live pair keeps the same ASSIGNED fault but parks both helpers
at an authenticated final pre-return fence, after every existing body cleanup,
caller/final-map check and creator cleanup. Only the two explicit live labels
use live-fence authorization; completed-helper admission stays strict. Both
helpers must remain exactly captured and live across baseline, release and the
shared comparison, with one bound no later than either autonomous3s fence or
the existing root15s deadline. Root closure remains reportExit-only. All raw
captures, unchanged failure results and original post-exit observers join before
cleanup; no old flag, right, job or deadline changes. READY requires successful
native root/thread/job, stream and window cleanup (mask0x1ff). Its fixed232-byte
receipt binds both captured incarnations and the original result125; later real
captures and complete cleanup evidence remain required. Progressive startup and
all acquired continuations join even if the second helper fails to start.

Local Bun1.4.3:90 pass,1 native skip,0 fail,1544 assertions, including15 live
protocol tests. Scoped and generated-copy typing, architecture1219 modules,
strict MinGW cross compilation of both programs and diff-check pass. The
reviewed compile-only snapshot has64/64 matching manifest entries and14/14
generated-owner provenance entries, including live-root-fence.ts. Production
sources remain byte-identical to1b2bb76b. Archived data replays preserve all ten
old controls and both completed-helper pairs without native operations. Red/green
regressions cover partial startup, failed cleanup, publication clock sampling
and changed helper-reference custody. SDK compilation, the actual live Windows
schedule and its fit inside the original shared3s bound remain unverified.
CAUSE_CONFIRMED=no for general retention; productionAccepted=false.

## Live helper native admission directory correction

Run40270030872 / job121400814843 executes4a224306. All70 manifest and14
generated-owner provenance hashes match. The four live helpers produce exact
232-byte READY/RETURN receipts, native cleanup mask511 and successful fence
I/O3/3; their original exit125 is preserved. Admission nevertheless fails before
the first held sample under both compilers: the owner reads READY in the
compiler capture directory, while the harness publishes it in its separate
fault-root-control directory. All four held replies report ENOENT, with no root
sample, controlled root close or live observer. Both pairs are inconclusive.

The original ten release controls and two completed-helper pairs stay valid.
All79 previous failures per compiler remain fatal; two live final-absence and
two live post-exit absence failures plus the invalid control bring the total
to84 per compiler. SDK2034/2034 and MinGW2041/2041 references close, with
transfers1516/1516 and1523/1523. Production remains0/7 per compiler at NUL5.

The owner now receives the private control directory explicitly from the runner
through ownedFaultRootReference and the generated export. Completed-helper logs
continue to use the original capture directory. The existing generated-export
service test reproduces the separate capture/control directories: ENOENT red,
then one passing test/37 assertions after the correction. The full Bun1.4.3
diagnostic suite passes90 tests/1544 assertions with one native skip; scoped
and generated-copy typing and architecture1219 modules pass. No production,
C helper, rights, cleanup gates or deadline changes. Corrected native admission
and the actual live comparison remain unverified. CAUSE_CONFIRMED=no;
productionAccepted=false.

## Live helper native drainage prerequisite

Run40271156948 / job121404229365 executesf2aae697. All70 manifest and14
generated-owner provenance hashes match. Corrected private-directory routing
admits all four held samples with exact READY bytes, cleanup mask511, live
helpers259 and terminal roots125. No baseline, comparison, verified or release
phase follows. All four native fences expire with1460, preserve exit125 and
join without capture timeout; no RELEASE/RETURN receipt is produced.

The harness still owns one registry reference to each terminal root. Its
pre-READY snapshots already read125, but its original close occurs after the
common deadline: SDK+100/+22ms and MinGW+11/+50ms. The SDK rejects drainage;
MinGW records drainage only after the deadline, then rejects before spawning
observers. Neither compiler supplies a valid live comparison. Launcher
references remain owned until later teardown, not a controlled release.

The diagnostic now explicitly drains the two harness references symmetrically
through their own reportExit before the shared comparison. Exact READY,
nonces, captured PID/creation identities, terminal root125, live helper259,
ledger custody and each harness job remain prerequisites. Closure evidence
must be unique and the original slot removed; retries cannot replace failed
closure. The strict other-reference drain still precedes baseline. This
intervention changes only the common harness prerequisite, preserving the
launcher HELD/RELEASED variable and original3s/native bounds. Actual corrected
Windows feasibility and effect remain unverified.

Ten old release controls and two completed-helper pairs remain valid. All84
fatal failures per compiler remain, including79 previous gates; SDK2034/2034
and MinGW2044/2044 references close, transfers1516/1516 and1526/1526. Production
remains0/7 per compiler at NUL5. No C, production or requested access changes.
CAUSE_CONFIRMED=no for general retention; productionAccepted=false.

Local Bun1.4.3 regression first fails with0/2 harness drains, then passes with
both original owner closures before baseline. The full diagnostic suite passes
97 tests/1692 assertions, with one native skip and zero failures. Scoped and
generated-copy typing, architecture1219 modules and strict MinGW cross
compilation of both programs pass. Generated-owner provenance now covers16
entries. Rejections cover changed identity, custody, job, helper lifetime,
private receipts and failed closure without retry. Both serialized drain proofs
are rechecked on one fresh snapshot before any baseline observer. No corrected
Windows execution or shared-window performance is claimed by these local checks.

## Valid live helper comparison after symmetric drainage

Run40272768823 / job121409194037 executes9aca65b9. All73 manifest and16
generated-owner provenance hashes match. Four authenticated harness roots
and four launcher roots close exactly once through their original owners.
All30 live observers run within the original common3s bound; four RETURN
receipts and captures125 validate without timeout. Both SDK and MinGW pairs
are valid and both-retained. Ten retired-name observations remain present
after the controlled root-reference releases while helpers live. All12 names
are absent after helper exit. No internal owner or general cause follows.

SDK2129/2129 and MinGW2132/2132 acquired registry references close successfully;
transfers1581/1581 and1584/1584 reconcile. These counts cover the registered
process references, not every native handle. Ten old release controls and
two completed-helper pairs remain valid. All79 historical fatal entries
remain, plus two live final-absence failures, totaling81 per compiler.
Production remains0/7 per compiler at NUL error5. No production fix or
acceptance is established; CAUSE_CONFIRMED=no; productionAccepted=false.

The helper closes three duplicated child streams before READY but retains
its three GetStdHandle originals. A separate stdio-held/closed comparison
tests those originals with the helpers alive. The existing live pair and
all its requirements remain unchanged. The new pair authenticates the CRT
ownership and pipe type before flushing both outputs; the closed arm uses
fclose and immediately proves each saved handle invalid before opening
receipt files. Both launcher root references must close before the shared
stdio comparison. All subsequent receipts and failures use private binary
files, never the closed streams. This additional control is unverified;
no pipe security context, token owner or causal effect is inferred yet.

The additional labels are ASSIGNED-STDIO-HELD and ASSIGNED-STDIO-CLOSED,
selected by anchor-stdio-run. Both retain their root-held baseline, then
discharge both exact launcher references before twelve total live observers
and six post-helper observers per compiler. Private stdio receipts use a
distinct400-byte format and separate explicit admission. A native failed
receipt invalidates the control even if a RETURN receipt exists. Actual
stdio captures must finish before the unchanged shared deadline; a missing
failure file cannot excuse a late exit. Failed-control bytes remain evidence.

Local Bun1.4.3 tests pass109 cases with one native skip, zero failures and1898
assertions. Regression runs first accept a valid RETURN with a later native
failure and accept a late capture without a failure file; both now reject.
The real stream guard also runs against non-native API stubs to check exact
mapping, alias rejection, output-only flush, owner closure order and immediate
invalidity without closing unknown handles. These checks establish no SDK,
Windows runtime, native scheduling, stdio effect or production acceptance.

## Native original-stdio lifetime result and stdout discriminator

Run40275974985 / job121418872575 executes09d74bf2. Parent and independent
audits reconcile80 manifest entries and18 generated-owner provenance hashes,
12 private400-byte receipts,24 live observers and12 post-helper absences.
Both STDIO pairs are valid and both-absent within the original3s bound.
All four retired-name baselines retain the directory with launcher roots
held; all four comparison observations are absent after both roots close.
HELD keeps all originals open with0/3 closes; CLOSED proves3/3 successful
owning closures. Original stdio closure is therefore not necessary for this
observed disappearance. No internal owner or general cause follows.

The simultaneous legacy live pairs remain both-retained. Ten old release
controls and two completed-helper pairs remain valid. All81 historical fatal
entries remain, plus two STDIO final-absence failures, totaling83 per compiler.
SDK2306/2306 and MinGW2312/2312 acquired registry references close; transfers
1710/1710 and1716/1716 reconcile. Production remains0/7 per compiler at NUL
error5. Later name disappearance never clears an earlier fatal cleanup gate.

An additional independent pair compares only the helper's stdout marker
write. ASSIGNED-STDOUT-SILENT and ASSIGNED-STDOUT-WRITE keep all three original
streams open. Both perform the same CRT/Win32 preflight, stderr barrier,
stdout/stderr flushes, authenticated harness drainage, root-held baseline,
both-root release and private receipt protocol. Only WRITE emits the additional
stdout marker before the common flush. Exact captured output and distinct
receipt admission authenticate the chosen arm. The old pairs and all bounds
remain unchanged. Local implementation and compilation do not establish a
native stdout effect. CAUSE_CONFIRMED=no; productionAccepted=false.

Local Bun1.4.3 passes116 tests with one native skip, zero failures and2221
assertions. The missing write-selector interface first fails compilation.
A scratch mutation that writes stdout for SILENT compiles but fails the actual
operation-order assertion; the current function passes both old ownership cases
and the exact silent/write, common-flush, zero-close sequences. Scoped/generated-owner types,
architecture and strict MinGW compilation of both programs pass. The final
compile snapshot has78 manifest entries and generated-owner provenance has19.
Replaying archived09 captures preserves timing4/4, twin2/2, anchor4/4, STDIO4/4,
live4/4 and their original fatal flags. Four archived child-output prefixes,
adapted only for the new labels/marker lengths, pass the new grammar;16 changed
prefix/root/barrier variants reject. This replay launches no native process.
The new paired Windows schedule, SDK build and causal result remain unverified.

## Native stdout write differential and zero-byte discriminator

Run40278827854 / job121427551378 executes37c1c22c. Parent and independent
audits reconcile84 manifest entries and19 generated-owner provenance hashes,
12 private400-byte receipts,24 live stdout observations and12 post-helper
absences. Both compiler pairs are valid within the original3s bounds. Both
retired-name baselines retain with launcher references held. After both exact
launcher references close, SILENT retains and WRITE loses the retired name.
All three original streams remain open in all four arms. Both helpers remain
alive throughout comparison; all names are absent after helper exit.

The nonempty helper stdout write distinguishes these two paired outcomes.
Its effect depends on root-reference release: the WRITE baselines still retain.
The shared preflight, stderr marker and explicit flushes do not explain the
split alone. No internal pipe/process owner, CRT mechanism, general retention
cause or safe production operation is established by this single native run.

SDK2475/2475 and MinGW2399/2399 acquired registry references close exactly
once; transfers1831/1831 and1779/1779 reconcile. Observer identities bind exact
tracked thread IDs to PID incarnations, including reused SDK PIDs8736/5928.
Ten old controls and both completed-helper pairs remain valid. Simultaneous
legacy live pairs remain both-retained. The old STDIO pair remains both-absent
for SDK; MinGW STDIO is inconclusive, with CLOSED READY3644ms after its common
deadline and no admitted drainage or live observer. Its failure receipts and
failed gates remain visible, with no widened bound or rerun.

All81 historical fatal prefixes remain for both compilers. SDK has85 failures;
MinGW has87. The latter adds two stdout failures, two STDIO post-helper retained
names and the inconclusive STDIO control, while its old STDIO-CLOSED final-map
failure does not occur on this path. That assertion remains present. Production
remains0/7 per compiler at NUL error5; productionAccepted=false.

The next independent pair compares SILENT with a single zero-byte WriteFile on
the exact original stdout pipe. Both arms keep every original stream open and
preserve the common preflight, stderr marker, flushes, authenticated drainage,
held-root baseline, both-root release and unchanged deadlines. Neither emits
a helper stdout marker. A separate private receipt must authenticate the actual
write result, transferred count and timestamp. No zero-byte effect or corrected
production behavior is yet verified.

ASSIGNED-ZERO-SILENT and ASSIGNED-ZERO-WRITE select anchor-zero-run. Both keep
the original three-generation child stdout transcript without a helper stdout
marker. The WRITE arm calls synchronous WriteFile once after common output
flushes, on the saved original stdout pipe, with a valid buffer and count0.
A separate424-byte frame records attempted, BOOL result, transferred bytes,
error and operation time; success requires result1/count0/error0. SILENT records
no call. Failed evidence remains archived and invalidates the comparison.
The distinct magic and explicit owner admission reject every older protocol.

Local Bun1.4.3 passes125 tests with one native skip, zero failures and2590
assertions. The compiled real stream path first fails because the selected
write was not called, then passes110 guard assertions. A compiling count1
mutation is rejected for its nonzero write count. Codec and controller tests
cover cross-protocol admission, real owner export/transport, immutable native
metadata, exact stdout, late capture, failed receipts and joined cleanup after
synchronous launch failure. Replaying37 preserves20 old400-byte and12 old232-byte
receipts, four stdout captures, two SDK STDIO captures,30 active proofs and10
drain proofs. The original MinGW STDIO timeout remains invalid. These checks
run no Windows process and establish no zero-byte retention effect.

## Native zero-byte result and isolated paired scheduling

Run40282349237 / job121438451815 executes503efe41. Parent reconciliation
matches87 manifest entries and20 owner provenances, including generated C.
Eight raw424-byte zero READY/failed frames preserve exact helper/root identity,
open original streams, balanced private I/O and immutable operation metadata.
Both WRITE calls return TRUE with transferred0/error0; SILENT records no call.
Twelve baseline observations validate with launcher references held, retaining
the retired names. Neither compiler admits a complete comparison; zero-byte
retention effect remains unknown. Four native zero fences expire with1460.

SDK attempts six comparison observers, but its time guards reject the batch.
Both SDK and both MinGW raw launcher release responses prove successful exact
root closes before their deadlines. The MinGW clients expire before admitting
those replies, so finalDrained=false does not prove a remaining reference.
All five paired families are inconclusive in this run; no prior positive or
negative paired result is promoted to a current valid observation. These logs
establish missed windows, not the internal owner of the timing delay.

SDK2628/2628 and MinGW2620/2620 registered references close exactly once;
transfers1944/1944 and1940/1940 reconcile. Each compiler retains92 fatal entries.
The production protected-tools gate still fails0/7 at NUL error5; later Windows
provider/core suites are skipped after that failure. Linux, UI/types and CodeQL
pass. No production fix or causal zero-byte effect is established.

The diagnostic previously started all five pairs alongside legacy timing and
serial scenarios on the same harness. Paired callbacks are now lazy: legacy
timing continuations and existing captures join first, then each complete pair
joins its captures and post-helper observations before the next pair starts.
Both native arms within each pair remain concurrent. Every existing scenario,
fatal assertion, ownership/admission rule and deadline stays in place, including
the3s windows and150s suite timeout. Failed background work or a synchronous
batch refusal cannot skip later pairs; errors remain fatal before registry
cleanup. This scheduling change tests isolation from unrelated harness work;
it does not establish that contention caused the previous native delay.

Local Bun1.4.3 regression first starts both pairs before a pending capture,
then passes with neither admitted early. The test runs the real stream root
controller/export fixtures and requires both concurrent baseline arms, all12
observers joined, unchanged3s deadlines and the first pair's final capture
before the second admission. A synchronous batch refusal is preserved while a
following real pair completes. The actual routing finally prefix also retains
delayed-observer and paired-batch failures before killAll. The complete suite
passes127 tests, one native skip, zero failures and2653 assertions; scoped
typing and architecture pass. No isolated Windows schedule or budget result
has been verified locally.

## Isolated native result and one-byte raw stdout control

Run40285568173 / job121448537661 executes8025e955. Parent reconciliation
matches89 manifest hashes and20 owner provenances. All five paired families
complete under both SDK and MinGW within their original bounds. Forty-eight
private frames and192 observations reconcile with raw files and exact tracked
thread/PID/creation identities. All81 legacy fatal entries remain; each compiler
has87 failures. Registered references close2652/2652 for SDK and2659/2659 for
MinGW; transfers1960/1960 and1967/1967 reconcile. The protected-tools production
gate still fails0/7 at NUL error5; later Windows provider/core suites are skipped.

The completed-helper pair retains HELD and removes RELEASED after the exact
owned root close. The live pair retains both. STDIO removes both, while the
stdout marker pair retains SILENT and removes WRITE. The zero-byte pair retains
both despite successful zero-byte API calls in each compiler. Its twelve held
baselines and twelve comparisons validate; the successful call has no observed
retirement effect in these windows. Live/stream post-helper names disappear;
completed-pair post-helper observations precede controlled launcher release and
still retain their retired names. Isolation yields admissible comparisons here;
it does not prove the internal cause of the earlier scheduling delay or the map
retention. The stdout contrast remains limited to these matched diagnostics.

An additional BYTE pair compares silence against one synchronous native
WriteFile on the exact original stdout handle, with one ASCII exclamation byte.
Both arms keep every original stream open, use the same CRT preflight, common
stderr marker and output flushes, then the existing private protocol. The WRITE
call follows those flushes and precedes READY; there is no CRT stdout write.
Distinct424-byte receipts authenticate the actual BOOL, transferred1/error0 and
timestamp through READY, release and RETURN. SILENT records no call. Captured
stdout must be the exact original three-generation inspect transcript, followed
by precisely one exclamation byte only for WRITE. Raw captures remain unchanged;
the topology validation view inserts a newline between separate stdout/stderr
streams because the new raw byte has no newline.

The existing owners, reportExit close path, fresh harness drain and both-released
strategy apply through explicit BYTE admission. The new consumed fence enters
owner provenance. The sixth pair joins after the five existing lazy pairs; its
two arms remain concurrent. No original assertion, scenario, permission or bound
changes, including3s windows,15s root and150s routing timeout. No production
source changes. This tests one native byte separately from CRT conversion and
the longer stdout marker; its effect and native budget remain unverified.

Local regression rejects the new experiment before implementation, then passes
the actual codec, generated owner export, private transport and controller.
The compiled verbatim stream guard accepts count1/payload exclamation and rejects
count0 or a different character after successful compilation. Failed/partial
calls, stale sentinels, altered metadata, suffixes and identities remain refused.
The complete Bun1.4.3 suite passes133 tests, one native skip, zero failures and
2942 assertions; scoped types and architecture pass. Current validators replay
all48 archived232/400/424-byte frames,12 stream captures and48 owner proofs.
Windows, SDK, native timing and the internal mechanism are not verified locally.

## Repeated native byte result and isolated stdout closure control

Run40288016977 / job121456435461 at4efcd622 and run40289233720 /
job121460372328 atb580e68c both validate all six paired families under SDK
and MinGW. Each raw audit reconciles92 manifest hashes,21 owner provenances,
60 private frames,228 observations,16 stream captures and60 owner proofs.
All24 exact root references have terminal125 snapshots before HELD. The
owned-exit trace is emitted by reportExit immediately before controlled closure;
it is not the kernel termination time. Both runs preserve all81 legacy fatal
prefixes and all87 preceding fatal entries, with89 failures per compiler.
The later BYTE write does not waive its earlier fatal cleanup failures.

The BYTE pair retains both retired names in baseline. During comparison,
SILENT retains and WRITE disappears under each compiler in both runs. The
successful native call records BOOL1/count1/error0 and the capture has exactly
one exclamation suffix only for WRITE. All original streams remain open, and
the shared preflight, stderr marker, output flushes, owner drain, three-second
window and private return checks pass. Zero-byte writes still retain both maps,
while the CRT stdout marker reproduces the same differential. These observations
establish the bounded effect without requiring a CRT stdout marker, long payload
or fclose in these pairs. They do not identify an internal Windows reference or
establish a production cleanup mechanism. All ordinary NUL probes still fail5,
seven per compiler; production admission stays false. Registered references close
2829/2829 and2833/2833 in4efcd622, then2830/2830 and2837/2837 inb580e68c.
CodeQL succeeds onb580e68c after complete LF-to-CRLF fixture conversion; Linux and
UI/types also pass. Windows remains failed, so no ready or merge follows.

The next additive PIPE pair keeps stdout silent in BOTH arms and closes only
the original stdout in CLOSED. The earlier STDIO pair wrote a stdout marker in
both arms before closure, so its both-absent result cannot isolate fclose.
Both new arms retain the exact three-generation transcript, common CRT mapping
preflight, stderr marker and successful output flushes. HELD keeps all originals
open. CLOSED calls fclose(stdout) exactly once; stdin and stderr stay open. There
is no new stdout byte, duplicate, reopen or replacement. A distinct400-byte
protocol authenticates fd1-only success0, immediate invalidity/error6 and the
immutable close timestamp. READY/release/RETURN and failure receipts use the
existing private files. The same owner-only drain, reportExit closure path,
both-released comparison and original bounds remain required. The seventh pair
runs after BYTE, with its arms concurrent. No old assertion, gate or production
source changes. Local codec and compiled verbatim C guard regressions fail before
implementation and then pass. Seven closure mutations compile and fail at runtime,
covering unwanted stdout output, wrong or missing closures and skipped native
result checks. The Bun1.4.3 suite passes140 tests, one native skip, zero failures
and3323 assertions; scoped types and architecture pass. Current validators replay
all48 archived frames/12 stream captures/48 owner proofs from8025e955 and all60
frames/16 stream captures/60 owner proofs fromb580e68c. Routing remains900 lines.
Cross compilation does not verify Windows execution; SDK, native closure effect
and its budget remain unverified.

## Native stdout closure result and normal DEBUG cleanup control

Run40293073260 / job121472762966 executes996587ad. The archived evidence
reconciles95 manifest hashes,22 owner provenance hashes,14 pairs,72 private
receipts and264 tracked observations. All28 controlled roots have terminal125
snapshots before HELD. SDK3012/3012 and MinGW3013/3013 references close; their
2224/2224 and2225/2225 transfers reconcile. No native retry was performed.

Both PIPE comparisons retain the retired directory in HELD and remove it in
CLOSED after the launcher roots close, while both helpers remain alive. Neither
arm adds helper stdout bytes. CLOSED alone closes originalfd1 successfully,
proves immediate invalidity with error6, and preserves the other streams. The
12 closure receipts,36 observations, exact output and immutable stream metadata
agree. All six previous families reproduce their earlier outcomes. This proves
the bounded closure effect in this fault pair, not a Windows internal owner or
a production NUL fix. The prior final-map failures occur before this experiment
and remain fatal:91 failures per compiler, all89 previous and81 historical
entries retained. Production still rejects all7 NUL probes with error5 per
compiler. CodeQL, Linux and UI/type checks pass; the PR remains a draft.

The additive DEBUG-PIPE-HELD/CLOSED pair now tests the normal DEBUG path without
fault injection, retirement or a replacement map. Both arms retain debug-run's
process creation, assignment, three target generations and three identified
console auxiliaries. After the owned job/root/duplicate streams and USER32
cleanup, both run the same CRT preflight, stderr marker and output flushes;
CLOSED alone calls the existing stdout-only closure guard. This action precedes
the unchanged first map_close observation. Its native trace binds helper/root,
role, cleanup mask511, three original CRT mappings and closure times. Exact
three-generation stdout must contain no new helper output. Invalid or partial
proofs reject admission, and a new cleanup error never clears an earlier one.

The original A/B assertions are shared with the new pair, including image and
parent identity, LPAC/job checks, pinned loader and application exceptions,
six exit events, both drains, caller observations and all cleanup gates. The
seven prior reference families and their ordering remain intact. The new arms
run concurrently after them, join with post-helper observers on every path,
and preserve the2s map wait,3s checkpoint,150s test and170s outer capture bounds.
These are diagnostic-only changes; Windows effect, SDK execution and native
budget for this new normal-path control remain unverified.

## Normal DEBUG closure result and literal transcript checks

Run40297536540 / job121487480273 executes95e46d5f. Both SDK and MinGW
normal DEBUG CLOSED helpers exit0: the original private map is absent immediately
(elapsed0,attempts1), at the unchanged3s checkpoint and after helper exit.
HELD retains it immediately, through the2s wait and3s checkpoint, exits125,
then the map disappears after helper exit. Native ordered mask511 traces prove
successful stdoutfd1-only closure before map_close; stdin/stderr stay open and
three-generation stdout contains no new helper bytes. All six process exits and
both DEBUG drains remain successful. This establishes the bounded normal-path
closure effect, not the Windows internal mechanism or production NUL support.

The archived audit reconciles100 hashes,22 owner provenances,14 prior pairs,
72 receipts,264 observations and4 new DEBUG captures. Each compiler closes
3094/3094 references and reconciles2286/2286 transfers. All91 prior and81
historical fatal entries remain, plus three HELD failures:94 per compiler.
Production still rejects all7 scenarios with NUL error5 per compiler.
Six observer reportExit/close callbacks follow their narrow comparison-window
end by46-63ms; authentic terminal-zero observations stay within those windows,
and all observation references close before the original common deadline.
The audit records terminal observations and later reference closure separately.
No source admission or deadline changes.

CodeQL99 flagged dot-only regex escaping in the transcript validator. Its
existing marker grammar excludes backslashes, but literal line membership now
removes the unnecessary escaping. Both allowed debugger statuses and malformed
labels are covered by the existing scenario. The suite passes143 tests with
one native skip and3405 assertions; scoped types pass. Current validators replay
all4 archived DEBUG captures and108 shared DEBUG gates with232 assertions.
GPT-6.1 Sol approved this two-file diff in one round; the broader prior review
remains skipped503. The live CodeQL rescan remains pending. This change leaves
generated C, production sources, all prior controls and their bounds intact.

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
