# CI and publication

Changes land through squash-merged pull requests. The repository's merge policy
requires every check a pull request reports ([check names](#check-names)),
`PR title` included, forbids direct pushes, force pushes and
deletion of `main`, and permits admin bypass only when merging a PR. No review
is requested or required: the repository has no CODEOWNERS, whose automatic
requests mailed the owner every event of each contributor's pull request. The `release tags` policy protects
`v*` tags from movement and deletion while allowing their creation.

`PR title` runs `scripts/ci/pr-title.ts` on title edits. The squash title is
`type(scope): summary`, with an optional scope and one of `feat`, `fix`, `perf`,
`refactor`, `docs`, `test`, `ci`, `build`, `chore` or `revert`. Its body is empty.

## Merge queue

`main` takes pull requests through a squash merge queue, so each one is tested
on the `main` it lands on, with the pull requests queued ahead of it. Without
it, two pull requests green on their own can break `main` together: the ruleset
does not require an up-to-date branch, and requiring one would rerun every open
pull request's CI after each merge.

`ci` and `PR title` also run on `merge_group`. A group runs `ci` in `queue`
mode against its `main` base: the same path rules as a pull request, with the
diff covering every pull request ahead of it, and the Windows, macOS, desktop,
E2E, stress, Docker and APK jobs a pull request run leaves out
([pull request runs](#pull-request-runs)). `Bundle size` skips there, since it
compares a pull request with its base. A group's `PR
title` checks the squash title of its last commit, the one `main` receives.
The queue builds up to three groups at once, each on top of the ones ahead of
it, without waiting to fill a group: with five, the full matrices shared the
organization's 20 hosted runners and groups timed out (2026-10-28). Pull
requests land in queue order: one whose group passed waits for those ahead of
it. A failed group removes its pull request and rebuilds the groups behind it
without that one; so do checks that have not reported within 120 minutes.
GitHub does not cancel the `ci` runs of a group it drops: they hold their
runners until they finish, so cancel a `merge_group` run whose
`gh-readonly-queue/main/pr-<n>-<sha>` branch no longer exists. A green `ci` run
takes about 12 minutes (2026-10-20): that is the shortest time from entering
the queue to landing, and waits or rebuilds add to it.

An agent merges with `gh pr merge <number> --squash --match-head-commit <sha>`:
the pull request enters the queue once its own checks pass, and lands when its
group passes. One the queue removes needs a fix or a rebase, then the same
command. `--admin` bypasses the queue and its checks.

## Checks

`scripts/ci/changes.ts` selects jobs from changed paths. Unknown paths run the
complete suite; renames affect both the old and new path. A job left out
skips and still reports its check, which passes; a failed or cancelled job
blocks the merge, and so does a job its failed dependency skipped, since that
dependency is required too.

| Change | Selected checks |
| --- | --- |
| `docs/*.md` and nested Markdown, listed root policies, issue/PR templates, CODEOWNERS, labeler rules, topics, `.coderabbit.yaml` | Changes job only |
| `apps/shell/` | Windows installer, Rust and native shell E2E; three browser/core E2E shards; portable desktop jobs |
| `tests/e2e/` | Desktop and E2E checks plus `check:e2e`; `tests/e2e/lib/` also selects stress |
| `Dockerfile`, `.dockerignore`, `docker/` | Native x64 and ARM64 Docker smoke tests |
| `packages/ui/` | Full type checks and UI tests, desktop/E2E without the shell's Rust tests, Docker and stress; `preview-picker.js` and `preview-highlight.js`, which `browser.rs` embeds, add them |
| `apps/android/`, `android.yml`, `scripts/ci/android-apk.ts` | Unsigned APK build; `android-apk.ts` adds the Boite Server APK |
| `apps/android-server/` outside `termux/`, `android-server.yml`, `scripts/ci/android-server-apk.ts` | Unsigned Boite Server APK build |
| `apps/android-server/termux/` | Core tests, type checks and UI tests, desktop/E2E: the release bundle carries it |
| `telemetry/` | Full type checks and UI tests plus the existing relay behavior suite |
| `tests/stress/`, `bench/agent-stress.ts`, `bench/lib/` | Full type checks, UI tests and stress |
| Other `bench/` files, `scripts/architecture/` | Full type checks and UI tests |
| `packages/core/` | All checks except the shell's Rust tests and the APKs |
| `packages/contracts/` | All checks except the shell's Rust tests and the Boite Server APK |
| Dependencies, shared builds, other workflows and unknown paths | All checks |
| Release or manual full run | All checks, except jobs the caller replaces through explicit inputs |

Contacts changes exercise the core/fake contract scenarios plus the real
three-core `shared-cores.test.ts` and browser `shared-collaboration.test.ts`
fixtures. A local Linux run verifies path and admission logic but does not
replace the native Windows process/file checks selected by CI. Fixture-only
echo execution must not be reported as external-provider sandbox coverage.

A pull request whose selection includes desktop also runs [Bundle growth](#bundle-growth).

The changes job always installs frozen dependencies, runs `bun audit` (with
the ignored advisories named and justified in `ci.yml`), local
link checks, `bun test scripts/ci ./bench ./apps/shell/scripts`, architecture
checks and their tests, translation validation and the no-em-dash UI copy
rule (`bun run check:copy`). Changes to workflows,
composite actions or `scripts/ci/` also run checksum-verified actionlint 1.7.12.

Architecture checks reject runtime dependency cycles, forbidden package imports
and production files above 900 lines. The graph reads TypeScript, JavaScript and
the scripts of Svelte components; the size check also reads the Rust of the
shell and the launcher and the Kotlin and Java of both Android apps
([development](development.md#architecture-checks)). Two files have a
ratcheting allowance in `scripts/architecture/size-budget.json`: no file is
exempt. Complexity reporting is advisory. Missing translations warn on PRs and nightlies; the release version
job requires every sentence ([language](language.md)).

The focused telemetry job runs `bun test packages/core/test/telemetry.test.ts`
when the full core suite is absent. The focused E2E type job runs
`bun run check:e2e` when the web job, which already includes it, is absent.

The required Windows stress job runs all three existing offline scenarios with
`bun run test:stress`: protocol isolation/cancellation/recovery, failed health
reporting, and loaded desktop/phone-width UI. It tests the UI the `Build UI`
job built (below) and retains fixture evidence under `tests/e2e/.artifacts/stress/`. Live-provider tests stay
disabled. See [performance](performance.md#concurrent-agent-stress) for workloads
and [portability](portability.md) for what these fixtures cannot prove.

### Check names

Every job a pull request can run has a fixed name, whether it runs or skips, and
the ruleset requires each one. It replaced a `CI required` gate job that
started after the last job ended, then waited a median 8.5 minutes for a
runner (38 runs, 2026-10-19). A skipped matrix job reports its unexpanded template
(`Core tests (${{ matrix.name }})`) and a skipped caller of a reusable workflow
reports its own name (`Desktop`), never the inner ones. So:

- The core suite is one job per runner of `CORE_ALL` (`core-linux-x64` and so
  on), each skipped unless `coreRunners` lists its label; the E2E suite is
  `E2E 1/3` to `E2E 3/3`. YAML anchors (`&core-steps`, `&e2e-steps`) keep one
  step list.
- `desktop.yml`, `server-verify.yml`, `android.yml` and `android-server.yml`
  take an `enabled` input,
  default on. `ci.yml` always calls them and turns it off when their paths did
  not change: every inner job skips, costs no runner, and reports
  `Desktop / Linux x64` as it would running. The portable jobs are one per
  platform of `PORTABLE_ALL`, each skipped unless `platforms` lists its id.
- A job skipped because its dependency failed counts as passed in a ruleset, so
  the ruleset requires every job of each needs chain (`Plan and repository
  checks`, `Build UI`).

`bun scripts/ci/required-checks.ts` prints the names a pull request
reports. Its tests pin all of them, refuse a matrix or an expression in a name,
and check each written-out job against
`CORE_ALL` and `PORTABLE_ALL`. On main and in a release, the `Ruleset check
names` job runs it with `--live`, which reads the rules for `main`
(`repos/mtsu-dev/boite/rules/branches/main`, public) and fails on a check the
ruleset lacks or one no pull request reports. No job needs it: the tests still
run, and once the ruleset matches, a rerun of that job alone turns the run
green. Pull requests skip it, so it is not required. `--ruleset <file>`
compares with saved `gh api` output instead.

- Adding a job: merge the pull request, then add its name to the ruleset in
  the same sitting; until then main's run fails and the new job is unguarded.
- Renaming or removing a job: a required name no pull request reports blocks
  every pull request. Keep the old job and add the new one, merge, add the new
  name to the ruleset, then remove the old job and its name once no open pull
  request still needs it.

### Run modes and platforms

PRs against any branch use `pr` mode and compare with their base; merge queue
groups use `queue` mode against their `main` base. Main pushes
use `warm`: they run affected core and E2E suites too, add Linux ARM64 and macOS
Intel desktop legs, and save caches. A push event does not prove that an
equivalent PR tree passed. A main push compares with the last main commit whose
CI passed, not with the previous push, so the changes of a cancelled or failed
run are tested again. A green main commit therefore has every suite passing on
a tree no later change affected, as far as the path rules above hold; the
nightly publishes on that. Without an answer from the API, the run selects every
check. Tags, reusable full calls and manual runs use `full`. Queue portable
desktop legs are Linux x64 and macOS ARM64; warm/full runs use both
architectures of each OS. The core suite follows the same rule for its Intel
Mac: a group runs it on Linux x64/ARM64, Windows and macOS ARM64, and warm/full
runs add `Core tests (macOS x64)` on `macos-15-intel` (`coreRunners` in
`changes.ts`). That job took 322 to 409 s a PR on a scarce runner (2026-10-17);
an Intel-only core failure now shows on the main push.

`desktop.yml` holds the desktop builds: the Windows installer job and one job
per portable platform, named after it (`Desktop / macOS x64`). `ci.yml` calls
it with the Rust tests when the `shellRust` plan output is on; the nightly calls
it without them. On Windows they run in `Desktop / Windows x64 Rust tests`, a
job of their own beside the installer build; portable jobs keep them in line.
The tests compile `apps/shell/src-tauri` and the two page scripts `browser.rs`
embeds, and start inline fake cores, so `shellRust` follows those paths and the
ones that select every check. 7 of the 100 PRs before 2026-10-19 touched them,
yet all ran the tests: 3.6 runner minutes on Windows, 3.5 on Apple Silicon and
0.9 on Linux per green PR run. Every check name is required; see
[check names](#check-names) before renaming a job. The `release.yml` job names
that `server-provenance.ts` checks stay fixed too.

Intel macOS packages are cross-built on the Apple Silicon runner with
`BOITE_TARGET=x86_64-apple-darwin`. The core compiles for `bun-darwin-x64`, and
the Rust tests and installed smoke check run as Intel binaries under Rosetta.
Only the core suite still runs on an Intel runner. On 2026-10-04 the Intel
desktop leg took 14.0 minutes and the Apple Silicon one 8.1 (nightly run
37234148865, the longest job of that run).

Core changes run the full core suite on Windows, Linux x64/ARM64 and macOS
ARM64 in the queue, on main and in full runs, and on Intel macOS outside the
queue; a pull request runs it on Linux x64, plus Windows for protection
inputs ([pull request runs](#pull-request-runs)). The two Linux core jobs
then install `xvfb` and `libxcomposite1` with apt and run
`packages/core/test/window-capture-x11.test.ts` alone under `xvfb-run` at
1280x1024x24: the X11 backend of `boite window` lists, captures and fails on
windows the test itself creates, through Composite and without it. The suite
before it has no `DISPLAY` and skips that file. The same step installs
`dbus-daemon`, `at-spi2-core` and `openbox` and runs
`packages/core/test/desktop.test.ts` again: with the tools present, `boite
desktop` starts a real virtual desktop of its own, runs programs on it and
stops it. Linux desktop packages build on Ubuntu 22.04,
setting a glibc 2.35 floor. Portable jobs run Rust tests and installed smoke
checks against Debian, extracted AppImage and macOS application bundles.
These verify startup, UI serving, authenticated RPC and a fixture echo turn
outside the checkout. Native WebView2 E2E remains Windows-only.

New commits cancel an older run of the same PR. A main run is never cancelled:
the newest push waits behind it and replaces any push still waiting, so each
run tests everything merged since the last green commit. After the green run
of 2026-10-18 20:52 UTC, the next merge cancelled 11 of the 12 main runs
started before 2026-10-19 03:30 and the twelfth failed, so the nightly had no
green commit to publish (`commit-ci.ts`). Stable
release and publication groups include the ref and SHA, so different versions
do not replace each other's pending run. Nightlies retain one shared group:
a running publication finishes, while newer pending work can supersede older
pending work.

Artifact uploads retry once, replacing a name reserved by the failed attempt.
A second failure fails the job. Tests and builds are not retried, with two
exceptions. Tests listed in `scripts/ci/quarantine.json` with their reason run
once more, alone and in a fresh process, when they fail in the core suite or
an E2E shard (`scripts/ci/flaky.ts`); the job fails if they fail again, and the
retry leaves a warning on the run. The retry only happens when every failure
of that file (core) or shard (E2E) is quarantined and bun named each one: a
crash, a timed-out file or any other failing test fails at once. The list
started on 2026-10-18 from the 80 runs that passed on rerun since 2026-10-16:
tests that failed at least three first attempts. A fixed test leaves the list;
`flaky.test.ts` fails when an entry no longer exists in its file.
`scripts/ci/hdiutil-retry.ts` bundles the macOS application again,
three attempts at most, when hdiutil reports `Resource busy`. That runner
fault (actions/runner-images#7522) failed the Apple Silicon DMG of nightly
37213994348 and cost a rerun. Before retrying, it detaches what the failed
attempt left attached and removes its partial DMGs. Any other failure ends
the step.

### Hung test runs

A job cut by its `timeout-minutes` keeps no artifact, and its log can be lost
too: E2E 2/3 of run 39321123064 (2026-10-19) left only the annotation
`exceeded the maximum execution time of 35m0s`. So each E2E shard ends its own
run first. Its first step notes when the job started; `scripts/ci/flaky.ts
--job-started --job-minutes 35` runs `bun test` with the Bun inspector and
stops it 4 minutes before the job's limit (`scripts/ci/hang-watch.ts`). From
2026-10-12 to 2026-10-19, 2831 passing shards ran their tests in 7.6 min at the
median and 19.2 min at most, the whole job in 24.5 min at most, so no healthy
run gets less time. `--job-minutes` must equal the job's `timeout-minutes`
(`e2e-harness.test.ts`).

A stopped run fails with an annotation naming the test that was running and
leaves `tests/e2e/.artifacts/hang/` in the shard's failure captures:

| File | What it holds |
| --- | --- |
| `summary.txt` | The tests running and for how long, the last that ended, whether the test process answered, free memory each minute |
| `tests.txt` | Every test that ended, with its status and duration: bun holds its own result lines while its output is a pipe |
| `test-process.txt` | What the test process reports of itself: its file, memory, and each open browser page or shell (`tests/e2e/lib/hang-report.ts`), with the page's in-flight requests, errors and main-thread state, and the shell's log tail and process tree (`shell-diagnosis.ts`) |
| `process-tree.txt` | The `bun test` process and every descendant, with memory, CPU time and command line |
| `browsers.txt` | `/json/version` and `/json/list` of each browser in the tree |
| `machine.txt` | Free memory and disk, and the 15 largest processes |
| `output-tail.txt` | The end of the run's output |

A test process that does not answer within 10 s on an open inspector is
blocked in synchronous code; the summary says so and the files written from
outside remain. An inspector that refuses the watch before any test ran leaves
a warning, and the tests run once without it under the same deadline: a hang
then reports no test names. An inspector that disconnects later is named in
the summary with its time, and the tests listed are those seen before. Bun
gives no list of open handles and no stack of a test that awaits: its
inspector answers only when the JavaScript thread is free.

### Pull request runs

A pull request, draft or ready, runs `pr` mode: the changes job, the Linux x64
core suite, type checks and UI tests, `Bundle size`, and the focused telemetry
and E2E type checks, each only when its paths changed. Protection code,
protected fixtures and shared toolchain inputs also select the existing
`Core tests (Windows x64)` job.
It builds the userspace sandbox helper, runs the opt-in native protection fixture
and keeps the ordinary Windows core suite. No extra required check name is added.
Other pull requests leave Windows out. macOS, desktop packages, E2E, stress,
Docker and the APKs skip: the [merge queue](#merge-queue) runs them on top of
`main`.

The Windows job also archives `windows-null-access-matrix`: a standalone,
opt-in comparison of host and LPAC NUL opens with four requested access masks.
It derives the frozen historical v1 helper in
`tests/diagnostics/windows-protected-reference.c` and preserves that reference's
admission probe. Its non-blocking result reports experiment completeness;
the native production suites still decide acceptance.
It also compares the captured Null descriptor with duplicated host and LPAC
tokens using AccessCheck; an added package ACE exists only in memory.
These DACL verdicts do not demonstrate a device open or cover the full SACL
and driver checks.
The same capture tests a named suffix under the real Null device, using NT and
Win32 opens in both host and LPAC phases. It records device characteristics and
checks EOF and discarded writes on successful Null opens. A complete refusal
is diagnostic evidence; it does not admit a tool or replace the original probe.

The separate `windows-lpac-parent-spike` artifact records a process-broker
prerequisite under SDK and MinGW. An opt-in fixture tests host-created children
with an LPAC parent, the same job and kernel child-process restrictions.
Its non-blocking result decides only this attribute combination, including
parent identity, inherited client handles and the child's own creation refusal.
It neither brokers NUL nor changes the blocking production admission probe.

The opt-in `windows-null-broker-spike` artifact tests a different primitive:
the host opens the fixed real Null device afresh for each request and duplicates
only that handle into a captured LPAC process. A task-local debugger adapter
exercises ordinary native and Bun callers, ordinary descendants, file modes,
denials, output-pointer failures and cleanup. It requires an exact verified
x64 ntdll image and startup site; an unsupported image or partial capture leaves
the experiment incomplete. Both compiler outcomes must agree. This diagnostic
always reports `productionAccepted=false`; its non-blocking CI step does not
replace the blocking native production protection tests. The production v2 helper has
its own explicitly linked Null broker module; diagnostic reference hashes never
attest that production executable. Required useful-tool, provider/shared and
Muse MSP scenarios execute with both SDK and MinGW helpers. The Windows core
job has a 30-minute budget for both matrices and the general suite. A run on
2026-10-27 spent nearly eight minutes in setup/diagnostics, then exceeded its
old 15-minute budget during the second provider matrix. Individual scenario
deadlines and all admission checks remain unchanged. Shared Git fixtures set
their synthetic identity in each repository, including the commit consumer,
and ignore host system/global Git configuration.
Once the helpers build, provider preparation and both provider matrices run
even if protected-tools tests fail. A failed preparation still blocks those
matrices; cancellation stops them. Each test step retains its failing exit code.
The setup ACL root contains only the private view, runtime and home. Synthetic
host files and the process journal stay outside that subtree so inherited ACL
changes cannot invalidate the host control or prevent journal cleanup. The same
native host-path read must succeed both before and after setup.
Console auxiliaries require kernel-event file identity against the system
reference and an independently captured hash. They retain LPAC, startup, event
and cleanup evidence; workload-child requirements never count them. A job-drain
record must precede any accepted auxiliary exit with code 125. Completed calls
and outstanding scenarios remain in the manifest if a later prerequisite fails.
The adapter snapshots a validated security-quality-of-service descriptor into
host-local storage for the fixed Null open. Invalid output spans pass through
to the original syscall under the captured LPAC token, without a host open or
remote write. Pointer admission still requires matching statuses for both
transports, unchanged sentinels, zero handle growth and a successful valid open.
The x64 adapter decodes `EaLength` as a 32-bit `ULONG`; unused upper stack-slot
bytes cannot reject an ordinary call. It records both halves of that slot to
attribute a remaining rejection. Bun stage markers and forwarded-exception
context locate runtime failures without suppressing application exceptions or
relaxing workload admission.
Credential non-inheritance is checked with a complete handle-table snapshot of
the caller and a live stdout-handle control. The candidate must equal the
captured parent handle and be absent at that instant; a numeric collision or
incomplete query leaves the experiment incomplete. This avoids issuing invalid
handle I/O under a debugger, which can raise an application exception.
The breakaway control accepts either an access-denied creation or a completed
fixed-image probe whose kernel binding proves that it stayed in the private
LPAC job. A successful creation flag alone proves neither escape nor confinement.
Probe children retain all token, image, startup, event and handle checks; they
cannot replace the ordinary workload children. Expiry requires an automatic
stop request after the deadline while the scope was live, followed by actual
session cleanup and zero live processes. The observer waits for that cleanup
within its existing deadline rather than stopping at the first empty process
count. Raw `NtSuspendThread` status identifies a failed suspension. An exact
`STATUS_THREAD_IS_TERMINATING` parks the untouched breakpoint owner using
[`DBG_REPLY_LATER`](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-continuedebugevent).
The owner resumes only after every terminating sibling's real thread-exit event
has been continued; its replay is decoded again before any trap removal.
Successful sibling suspensions remain held until the trap is rearmed. A failed
park, an unexpected status or a missing exit/replay still drains the job within
the existing deadline. Failed suspensions never count as held or retired threads.

A skip passes in a ruleset, so a pull request's run satisfies every required
name and the pull request can enter the queue. The group's run reports the same
names on its own commit, and gates the merge on them. There only the path rules
skip a job: `changes.ts` gives a group the `queue` plan whatever its pull
requests' draft flags, and no job condition in `ci.yml` reads the event or the
draft flag, `Bundle size` and `Ruleset check names` aside
(`required-checks.test.ts`). A Windows, macOS, desktop or E2E failure therefore
shows first in the queue, which removes the pull request.

Marking a draft ready starts no run, nor does a conversion to draft: a draft's
run already reports what a ready one would. mtsu-patrol reviews once the pull
request is ready.

Until 2026-10-28 a ready pull request ran the full matrix, then its merge group
ran it again. GitHub Free allows the organization 20 concurrent jobs: with 20 or
more ready pull requests open, jobs waited up to 47 minutes for a runner. On
2026-10-28 a pull request run cost 12 to 16 runner minutes, all on Linux, and a
full run 91 to 108 (9 runs of that day). Each pull request now pays the full
matrix once, in the queue, instead of twice. Of the 5,632 runner minutes spent
by the 86 pull request runs started on 2026-10-18 between 12:34 and 21:35 UTC,
2,476 went to runs a newer push cancelled, a median 9.8 minutes after the push
they tested: the time a review bot takes to answer.

An agent's pull request flow:

1. `gh pr create --draft`.
2. Fix the draft's CI failures in one push.
3. `gh pr ready <number>` once the draft's checks pass.
4. After that, one push per round: wait for the head's CI run and
   mtsu-patrol's review, then fix everything they found together.
5. `gh pr merge <number> --squash --match-head-commit <sha>`. A failure the
   queue finds removes the pull request: fix it, push, and merge again.

## Build cost

Cargo, Vitest, the Bun store and BuildKit save caches only from `main`. Cargo namespaces
separate Windows release builds and each portable runner. Vitest stores
transforms under `node_modules/.vitest-cache`; its namespace includes
`bun.lock`, Svelte/Vitest configuration and `packages/ui/icon-plugin.ts`.
Each Docker architecture has its own BuildKit scope. Agent dependency manifests
are copied before source files, so a core edit does not reinstall CLIs.

Bun follows `packageManager` and installs with `--frozen-lockfile`. The setup
action restores Bun's download store (`bun pm cache`) keyed on OS,
architecture, Bun version and `bun.lock`, falling back to the newest store of
the same Bun; only `main` saves it. Install still links every package and runs
lifecycle scripts, so a stale store costs downloads only. Uncached, install took
20 to 33 s on the Windows and macOS runners (2026-10-17). UI tests use at most eight workers. Core files run in
fresh Bun processes, four at once by default; `BOITE_TEST_WORKERS` accepts 1 to
8 and `bun run --cwd packages/core test:serial` runs one file at a time. Each
core has a fresh data directory and port. Full per-file output and nonzero
exit failures are retained. A file still running after five minutes, its event
loop blocked where no test timeout can fire, is ended and reported with what it
printed (`BOITE_TEST_FILE_DEADLINE_MS`).

Browser command, sharing and profile scenarios run in separate files so their
combined Chromium startup time does not consume one five-minute file budget.
Each file registers its own loopback site and fresh-core hooks through a fixture
factory; individual scenario deadlines and assertions remain unchanged.
Crash-recovery fixtures disarm resident delegation, coordination, workflow and
group readers before closing the journal, without draining interrupted work.
Real-core browser gestures wait for a decoded, enabled frame fitted to the view;
an image can load before the automatic viewport resize has finished.
Deferred-dialog fixtures release a loopback response after the agent's commands
finish and observe the page's completion request before reading its title.
Network-diagnostic assertions wait for the asynchronous response event, which
DOM readiness does not include. Desktop-host fixtures close Chromium and remove
their profiles when setup fails, and register cleanup before returning a host.
The command/dialog scenario prints a bounded, content-free CDP timing trace only
on failure, retaining the original error and restoring its observers afterward.
Fold-reveal coverage includes lazy rows arriving after the opening animation;
the follow period starts when content is ready, and user input still cancels it.

The Windows job shares release-profile Rust dependencies, builds the installer
once, and stages its existing core beside the shell for native E2E. The shell's
Rust tests run beside it in their own job, which restores the same
`desktop-release-v2` cache and never saves it: the test build turns on
`tauri/test` and drops `custom-protocol`, so it needs neither the UI nor the
staged core, and in line it added 97 to 102 s after the 221 s build. Installer
regressions set `BOITE_CI_INSTALLER_REQUIRED=1`, so missing NSIS or generated
fixtures fail rather than skip. Unsupported local runs keep intentional skips.
The tested installer becomes the release artifact.

The shipped shell uses fat LTO over one codegen unit. Its final step is serial:
on 2026-10-17, recompiling only the shell crate took 8 min 57 s with fat LTO and
10 min 18 s with thin LTO on the shared 8-thread development machine, against
1 min 32 s with Cargo's defaults (`bun run --cwd apps/shell tauri build
--no-bundle`). `Cargo.toml` therefore keeps Cargo's release defaults, and
`desktop.yml` sets `CARGO_PROFILE_RELEASE_LTO=fat` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1` only on the steps that build a shipped
shell (the Windows installer, the Debian package, the macOS bundle) and only
when `sign-updates` is on: the nightly and a release. Other steps and runs set
neither, so `test:shell --release` keeps Cargo's defaults even in a release run.
Setting the defaults explicitly is not the same: `CODEGEN_UNITS=16` passes
`-C codegen-units=16` to rustc, which changes every crate's fingerprint. On
2026-10-19, `cargo build --release -p libc -v` in `apps/shell/src-tauri` stayed
`Fresh` with `CARGO_PROFILE_RELEASE_LTO=false` and printed `Compiling` with
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`. In CI, the `Compiling` lines of the
build step (Windows installer, macOS bundle, Debian package) fell from 203, 207
and 260 in pull request run 39165484727 to 1, 33 and 1 in run 39251281108 once
neither was set. The desktop Rust caches moved
to `-v2` keys at the same time: rust-cache never rewrites a key it restored in
full, and the v1 caches of macOS x64 and Linux arm64 held only those crates.
Both desktop jobs get 60 minutes instead of 35 when publishing. The cache is
saved from `main`, so a publishing run also
compiles its dependencies with LTO, an estimated 7 to 8 minutes more per
platform. On Windows `stage:core` no longer compiles `dist/boite-core.exe`:
2026-10-17, four alternating local runs of the old and new command, median
5.4 s against 3.4 s, and a 105 MB write less.

### Bundle growth

`bundle-size.yml` builds the UI and the core on Linux for every push to main,
one job that the next push never cancels, and measures four sizes with
`scripts/ci/budgets.ts`: the UI entry chunk, the UI files without their `.br`
and `.gz` copies, the core `dist/main.js`, and all emitted core JavaScript with
lazy chunks and workers, excluding native binaries and source maps. It keeps
them 90 days as the `bundle-sizes` artifact. The `Bundle size` job in `ci.yml`
measures a pull request the same way when the desktop build covers its change. No file in the repository
holds a limit, so a pull request never edits a shared one to grow.

A pull request is checked twice:

- Against its base: the sizes `bundle-size.yml` kept for the base commit, or
  the base built in the same job when that run is missing or still going. The
  base is the first parent of the merge ref the job checks out, the main commit
  the pull request is merged onto. `pull_request.base.sha` stays at the branch
  point until the branch moves: on 2026-10-19 it charged #665, which touched no
  UI file, with 156e44cf's UI growth over 184e63a7 (run 39319378723). A measure
  growing more than 0.1 % fails until the pull request body explains it under
  a `## Bundle size` heading. The body is read when the job runs: after
  editing it, rerun the failed jobs (`gh run rerun <run-id> --failed`).
- Against a ceiling: the sizes `bundle-size.yml` kept for the newest published
  nightly or release, plus 2 %. A reason does not lift it; only publishing
  does. A pull request fails it only for what it adds: when its base is
  already above the ceiling, the measure fails only if the pull request grows
  it, and otherwise the job summary lists it under "Above the ceiling before
  this pull request". That debt is main's: after measuring each main commit,
  `bundle-size.yml` runs `budgets.ts ceiling` and fails while main is above
  the ceiling, until the next nightly publishes or a change shrinks it.

The job summary shows each measure, its base, the growth and the ceiling.
Reproduce a measurement with `bun run build:ui && bun run build:core &&
bun scripts/ci/budgets.ts measure sizes.json`.

### E2E preparation

`BOITE_E2E_PREBUILT_UI=1` tests the built production UI and refuses missing
artifacts; local E2E rebuilds by default. `shell.test.ts` runs against the
installer in the desktop job. Every other E2E file enters one of three Windows
shards. Files run sequentially within a shard with separate ports, data and
browser profiles. Matrix `fail-fast: false` preserves other shards' results
after a failure.

The `Build UI` job builds both UIs once on Linux: `bun run build:ui` (artifact
`ui-dist`, `.well-known` included) and the fake-client bundle
(`bun tests/e2e/lib/warm.ts --build-only`, artifact `ui-e2e-fake`). The shards
and stress download them instead of building about 31 s each on Windows.
On `6004522f` (2026-10-17), the Linux UI of `app.yml` run 39065496375 and a
Windows build of the same commit had the same 459 files and, chunk hashes aside,
the same JavaScript, HTML and manifest. The only differences: lightningcss
rounds one `lab()` value in the CSS at its sixth decimal (`.857866` against
`.857878`), which renames every chunk importing that stylesheet and the service
worker's build id, and each `.gz` carries its OS byte (3 or 10). The installer
still builds its own UI on Windows.

Shards are cut by `scripts/ci/e2e-shards.ts` from
[e2e-durations.json](../scripts/ci/e2e-durations.json), the seconds each file
took on recorded green runs: files go longest first to the lightest shard, and
a file with no record counts as the median. `bun test --shard` cut by file
count and ran 285 to 317, 410 to 417 and 501 to 519 s of tests; the recorded
seconds of 2026-10-17 split into 376, 376 and 376 s. Refresh the record after
adding or reshaping heavy files, from one or more green `ci.yml` runs:

```sh
bun scripts/ci/e2e-shards.ts refresh <run id> [<run id> ...]
```

It reads each run's `E2E n/3` logs with `gh`, where `bun test` opens a group
per file, averages the runs and prints the new split. `bun scripts/ci/e2e-shards.ts
<shard> 3` prints a shard's files. `e2e-shards.test.ts` fails when the record
splits the current files more than 15 % apart.

`tests/e2e/lib/warm.ts` logs phase starts, elapsed times and errors, optimizes
Vite once with `NODE_ENV=test`, and builds `BOITE_E2E_FAKE_UI` with the same
fixture plugin used by `startDevUi`; in CI it runs `--prebuilt` on the
downloaded bundle and refuses a directory without `index.html`. It consumes the optimized dependency body
before closing Vite. Tests importing or blocking `/src/` URLs still use a dev
server, warming reachable modules within its 60-second hook. Job deadlines stay
35 minutes. Failure captures are attempted on cancellation too.

The first Chrome of a hosted Windows runner can take over 30 seconds to open
its debugging port, which failed the first browser test of a shard on `main`
and on branches on 2026-10-07. `warm.ts` therefore opens the fake-client bundle
in a browser once before the tests, where nothing has a deadline, and only
warns when that browser does not come up. `BrowserPage.launch` starts a fresh
browser once more when the first never reached its page: no debugging port,
no devtools socket, or a first navigation that did not commit in 20 seconds.
It logs `[e2e] the browser did not start` when it does. Nothing the page does
after it has loaded is retried.

Both E2E steps point `TEMP` and `TMP` at `runner.temp`, on the runner's D:
drive, so browser profiles and core data directories leave C:. With them on
C:, Chrome held page loads for 15 to 60 s after the UI server had answered every
request, while a fresh connection to the same server got the file in
milliseconds: 8 such stalls in 5 of 9 shard runs, against none in 9 on D:, and
706 s of tests against 420 s (PR #513, 2026-10-15). They had failed about one
shard in five since 2026-10-10, on `main` as on branches, a different test each
time. `scripts/ci/e2e-harness.test.ts` keeps both variables on both steps.

The desktop job's native shell E2E step does the same for test shells, whose
data directory holds their WebView2 profile. WebView2 holds a fresh profile's
first document request until the profile's cookie database has opened: in 249
of 250 launches on C: the host got the request within 5 ms of that open ending.
On C: the request came 1.1 s after the navigation started on average and
10.4 s at worst, 3 of 250 launches past 5 s; on D: 0.18 s and 0.5 s, none of 150
past 5 s (run 39417347690). The slow tail left the page on `about:blank` past
the 15 s bridge wait in five runs, on `main` as on branches (2026-10-19 and
20). `e2e-harness.test.ts` keeps both variables on that step too.

CI Chromium uses CPU compositing with software GL disabled. Browser launch
failures retain bounded stderr; exited browsers fail promptly. Navigation waits
for committed state and asynchronous conditions, reporting page state, JS errors
and requests still in flight on failure. Background timer throttling is disabled.
WebView2 receives the hidden shell's debug port through its API; normal launches
ignore it. Hardware-audio tests skip hosts without a render endpoint, while
guard logic tests still run. Scripted Claude tests need no CLI login.

Shared Cargo targets are snapshotted into the checkout before shell tests so
another build cannot replace the tested executable. Thread-removal tests assert
RPC errors through `catch` and `toMatchObject` to avoid Bun 1.4.2 Windows
`.rejects` crashes. Kernel-handle assertions use a dedicated child through
`procs.spawn`; mobile Back tests await `popstate`.

### Measuring the E2E partition

`bench/e2e.ts` compares serial and sharded runs using JUnit case identities;
its shards are the CI ones.
It refuses failures, skips or a changed case list. Build/staging commands,
the 2026-09-28 local comparison and the first hosted PR #108 run are preserved
in the [dated report](../bench/results/2026-09-29-resources.md#e2e-partition-measurements-2026-09-28).
Measure local latency separately from hosted CI and review latency. More runners
can shorten elapsed time while increasing total runner minutes.

## boite (de nuit)

The nightly runs at 03:23 UTC and accepts manual dispatches on `main`.
`NIGHTLY_ENABLED=false` disables both; removing it or setting it to `true`
enables them. An already published commit skips every build. An unpublished or
failed build is eligible next time.

The nightly does not run CI again. Its `CI passed` job (`scripts/ci/commit-ci.ts`)
accepts a green `ci` run for this exact commit, whether the push to main started
it or the merge queue that landed it, manual runs on main included: a
merge-queue merge's push run can be dropped or fail to start, and the queue's own
run covers the same tree. A green candidate passes at once, an unfinished one is
waited for, and the newest completed one has its failed jobs rerun once before
the gate fails; a commit with no such run after ten minutes fails. A
main run is only cancelled while pending,
when a newer push replaces it, so a cancelled run has no verdict: the job then
follows the newest main run that was not cancelled, normally the one that
replaced it, and waits for that commit instead. With no newer run it takes the
newest older main commit whose run passed; anything else fails. On 2026-10-19
the 08:59 UTC nightly started on 30287eef while its run was pending; that run
and the next two were each replaced while pending, 9c974e65's passed at 09:33,
and the night was lost on `ended cancelled` (run 39226757576). The job writes the commit it passed as
its `sha` output, and every later job checks out, tags and publishes that
commit, never `github.sha`; the version step runs that commit's `nightly.ts`
with `GITHUB_SHA` set to it. `desktop.yml`, `android.yml`, `android-server.yml`,
`server.yml` and `server-verify.yml` take it as their `ref` input. `app.yml` deploys its own
checkout, so it does not follow and a cancelled run still fails it. The whole
wait is bounded at two hours: 35 minutes behind the main run ahead, 35 for the
followed run and 35 for its rerun.

`desktop.yml` builds and signs each desktop package once and tests what ships:
installer regressions and native shell E2E on Windows, the installed Debian
package, the extracted AppImage and the macOS bundle. The Rust tests are
skipped because the commit's CI already ran them.

A dispatch with `dry-run` builds any branch with throwaway signing keys, even a
commit that already has a nightly. It accepts that branch's pull request CI run
without rerunning or following it, skips reservation and every
publication, and has its own concurrency group.

Versions use `2.0.0-nightly.YYYYMMDD.N`, taking the base from the manifest and
resetting the counter each UTC day. For example, September 15's first build is
`2.0.0-nightly.20260915.1`, then `.2` for a new commit. Build inputs stamp the
version; source manifests retain theirs.

The CI check runs first, since it decides which commit gets built; the
version, desktop builds, APKs and native image builds follow on that commit,
alongside one another. A scheduled run usually finds its CI long finished, so
the wait costs nothing there; a dispatch right after a merge waits for that
run before building. Only after all pass does reservation bind the tag to the exact commit. A publishing
failure keeps that tag for retry, including on a later day. A reserved tag alone
is not a successful release. `server-manifest.yml` promotes the tested digests
to `nightly`, the version and commit tags after reservation. It never moves
stable Docker `latest` or GitHub's latest stable release.

Stable and nightly desktop tracks share the regular install and data; Boite Dev
is separate ([updates](updates.md)). The server uses `dev`; use separate Compose
volumes ([server](server.md)). The signed or reused APK, which opens the phone
app's address, is required too; [Android](android.md) owns the host, signing
and reuse rules. So is the Boite Server APK, signed with the same key or reused
while `apps/android-server` outside `termux/` is unchanged
([Android server](android-server.md#publishing-the-app)).

## The phone app's address

`app.yml` builds the UI on `main` when `packages/ui/`, `packages/contracts/` or
the workflow change, or by hand; from `main` it waits for that commit's CI to
pass (`scripts/ci/commit-ci.ts`, as the nightly does) and deploys it with
GitHub Pages to the
repository's custom domain, `APP_ORIGIN` in the contracts
([phone](phone.md#the-app-on-its-own-address)). It packs the site itself so
`/.well-known/assetlinks.json` ships, which `upload-pages-artifact` would leave
out as a hidden folder. Pages must use GitHub Actions as its source, and the
domain's DNS names `mtsu-dev.github.io`.

## Pull request reviews

mtsu-patrol reviews each ready head; it is not a required check.
`.coderabbit.yaml` turns CodeRabbit's automatic reviews and chat replies off:
its free quota left most pull requests with a limit notice instead of a review.

A review with no critical or major finding is the last one: the push that
only answers it needs no second review. mtsu-patrol skips a push of at most
150 changed lines after such a review (a setting in its panel) and says so in
its summary.

Follow the [PR rules](../AGENTS.md#follow-through-on-pull-requests): inspect CI
and review findings together, verify and group fixes before pushing, and report
unresolved bugs or unavailable reviews. Acknowledgements need no reply or repeat
review request unless they contain a new finding. A regression test must catch
a failure existing coverage cannot detect.

## Security and labels

The hosted security policy uses CodeQL default setup for Actions,
JavaScript/TypeScript and Rust, secret scanning with push protection, and
Dependabot alerts/security updates. Vulnerability reports use the private
channel in [SECURITY.md](../SECURITY.md). Actions are pinned to full commit SHAs.
Hosted rulesets and security settings are managed separately from these files.

Dependabot runs monthly for the Bun workspace, `docker/agents`, Cargo, Docker
and Actions. Actions, agent CLIs and Cargo share the `monthly` multi-ecosystem
group. Workspace minor/patch updates share another PR; majors are separate.

The labeler uses `.github/labeler.yml` for `core`, `ui`, `shell`, `server`, `ci`
and `documentation`. It runs on `pull_request_target` without checking out or
executing PR code, with write scope limited to pull-request labels. A newer
push cancels the pull request's labeler run still queued or running: on
2026-10-19, 43 labeler runs were queued at once.

## Releases and server images

A `v<version>` tag must match package, Cargo and Tauri versions. Manual `release`
uses those versions and creates its tag after checks; neither entry increments
them. Full CI produces the tested signed desktop/server artifacts, updater
manifest and checksums for a maintainer-reviewed draft. Nightlies publish a
prerelease automatically. [Releasing](releasing.md#signed-update-artifacts)
owns signing and the nine updater targets.

Stable release images build and smoke-test once per architecture in `server.yml`,
using release-intended telemetry flags with networking disabled for smoke.
Run-specific staging tags retain the tested digests. The draft stores
`server-images.json` with SHA, version, tag, run ID/attempt and both digests, and
includes it in checksums. This metadata survives the one-day workflow digest
artifact retention.

On publication, `publish-server.yml` validates that metadata against the exact
release, tag commit, workflow run/attempt and successful version, verification,
image and draft jobs. Skipped or unrelated runs cannot supply proof. Publication
promotes those digests without rebuilding to the version tag and the compatible
`sha-<full commit>` alias. The SHA alias is mutable: stable and nightly builds
of the same commit can have different channels and versions, and either can
replace it. Pin a version tag or digest when that distinction matters.

Version promotions remain independent across releases. A separate job serializes
Docker `latest` promotion across the repository, without cancelling an active
promotion. After acquiring that group, it checks GitHub's current stable release
before writing `latest`; an older release cannot finish its write after a newer
promotion. An API or validation failure leaves `latest` unchanged. Retry by
dispatching publication on the same published tag.

The registry is `ghcr.io/<owner>/<repository>/boite-server`. Anonymous pulls
require public GHCR package visibility. Publishing uses `GITHUB_TOKEN`, without
a registry-password secret. CI does not contact a production host or migrate
Boite Legacy's separate `ghcr.io/beboite/boite-server` package. Images published
before the move to `mtsu-dev` stay under `ghcr.io/beboite/boite/boite-server`.

## Automatic changelog

`release.yml` and `nightly.yml` generate a download table from the artifacts
they will attach, before the automatic changelog. It links each system and
architecture directly to its installer. The nightly includes its independently
versioned Android APKs and opens with an instability warning. Draft retries
refresh the notes along with the artifacts. [Release notes](releasing.md#release-notes)
cover the tables, commit ranges, grouping and announcements.

## Repository presentation

`.github/topics.json` holds the GitHub topics. Review it before applying:

```sh
gh api repos/mtsu-dev/boite/topics --method PUT --input .github/topics.json
```

This changes topics only; the About description is separate repository metadata.
