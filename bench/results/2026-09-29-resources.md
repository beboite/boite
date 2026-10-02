# Concurrent-agent resource audit

Measured on 2026-09-29 with Bun 1.4.2 on Linux x86-64. The before build is
`606bc56d`; the after build is `359517ef`, including the review fixes and
merged main through `33b9d8ce`. Both builds use the same benchmark source and
compiler target `bun-linux-x64-baseline`, the same two logical CPU affinity
and nice level 10. Each sample starts a fresh process and uses a fresh temporary
journal. There are three samples per build and scenario. No provider login or
paid turn is used. [Raw sample output](2026-09-29-resources.json) includes CPU,
elapsed time, RSS, heap samples and work counts.

Streaming met the scoped 30% to 50% CPU/RAM goal; process sampling and team
updates met the CPU goal. Idle did not improve. These results exclude the whole
desktop application and combined memory of real providers. Later sections
preserve separate integration, CI and runtime measurements with their dates.

## Results

Medians of three samples. CPU is accumulated process CPU time, not elapsed time
or a percentage. RSS is the sampled peak, except idle, which uses each run's
median RSS. MiB means 1,048,576 bytes.

| Workload | CPU before | CPU after | CPU reduction | RSS before | RSS after | RSS reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 streams, reading one thread | 8,863 ms | 379 ms | 95.7% | 253.24 MiB | 109.21 MiB | 56.9% |
| 64 roots, 100 forced-refresh ticks | 1,079 ms | 591 ms | 45.2% | 95.42 MiB | 92.74 MiB | 2.8% |
| 64 roots, 100 wall-clock ticks | 964 ms | 458 ms | 52.5% | 94.97 MiB | 82.13 MiB | 13.5% |
| 8 teams, 64 children, 16 load ticks | 348 ms | 116 ms | 66.7% | 92.86 MiB | 85.90 MiB | 7.5% |
| Idle core, 10 seconds | 37.40 ms | 38.80 ms | No improvement | 60.39 MiB | 60.32 MiB | No improvement |
| 128 streams, no reads, control | 347.66 ms | 377.28 ms | 8.5% increase | 95.84 MiB | 97.71 MiB | 1.9% increase |

Additional medians and exact work counts for the same runs:

| Workload | Metric | Before | After |
| --- | --- | ---: | ---: |
| 128 streams, reading one thread | Elapsed time | 9,330 ms | 390 ms |
| 128 streams, reading one thread | SQLite part updates | 4,096 | 128 |
| 128 streams, reading one thread | Sampled peak JS heap | 100.11 MiB | 31.48 MiB |
| 64 roots, forced refresh | Elapsed time | 1,008 ms | 531 ms |
| 64 roots, forced refresh | Procfs reads | 65,643 | 22,700 |
| 64 roots, forced refresh | Per-task child reads | 29,860 | 0 |
| 64 roots, wall clock | Elapsed time | 883 ms | 405 ms |
| 64 roots, wall clock | Procfs reads | 55,359 | 19,299 |
| 64 roots, wall clock | Per-task child reads | 29,561 | 0 |
| 8 teams, 64 children, 16 load ticks | Elapsed time | 201.55 ms | 70.76 ms |
| 8 teams, 64 children, 16 load ticks | Selected-team snapshots | 128 | 1 |
| 8 teams, 64 children, 16 load ticks | Serialized JSON characters | 738,560 | 5,708 |
| Stream-only control | Elapsed time | 364.08 ms | 395.77 ms |
| Stream-only control | SQLite part updates | 128 | 128 |

The journal saves 8,484 ms of accumulated CPU and 144.03 MiB of sampled peak
RSS in this workload. Wall-clock sampling saves 506 ms CPU and 12.84 MiB RSS.
Team refreshes save 232 ms CPU and 6.96 MiB RSS. These absolute differences use
the unrounded medians. They cover equal work; they are not per-second rates
for a running application.

### Streaming journal

`bun bench/streaming-load.ts 128 32` seeds 256 KiB per stream, appends text to
all 128 streams for 32 cycles and reads a two-message page from one thread after
each cycle. It verifies every snapshot and all 128 final persisted rows. The
timed section includes final persistence.

Before, each read persisted every dirty stream, cancelling the adaptive timer
and allocating full serialized parts for unrelated conversations. Reads now
flush deltas into the stream buffer and overlay only selected rows. They do not
mark dirty text clean. Explicit persistence, completion, release and shutdown
retain their durability behavior.

| Pair | Before CPU ms | After CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 8955.929 | 370.604 | 253.242 | 110.227 |
| 2 | 8863.470 | 381.914 | 255.684 | 108.914 |
| 3 | 8819.324 | 379.196 | 252.672 | 109.215 |

The stream-only control keeps 128 writes in both builds. It used 29.62 ms more
CPU and 1.87 MiB more peak RSS after the changes. It does not support a general
streaming-only gain. Its JS heap stayed at 23.25 MiB in both builds.

| Pair | Before control CPU ms | After control CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 335.775 | 354.822 | 91.496 | 98.152 |
| 2 | 347.662 | 384.214 | 97.953 | 97.711 |
| 3 | 361.739 | 377.283 | 95.844 | 96.625 |

Peak RSS and heap are sampled after synchronous cycles, so they are lower
bounds. This scenario isolates the journal and excludes browser and provider
heaps. Its temporary data directory is set before journal construction and
restored even if construction or close fails.

### Process sampling

`bun bench/process-load.ts --live --roots 64` starts 64 sleeping Bun fixtures
and samples their real Linux procfs records for 100 ticks. By default, the clock
advances one second per tick without waiting, forcing a global scan every tick.
All 6,400 root observations are verified. Cleanup kills and waits for only
process handles captured at spawn, retaining primary and cleanup errors.

Parent links are shared for 500 ms. A stat line from that scan is reused only
at its capture timestamp; later samples read a fresh per-PID stat. This keeps
CPU accounting current between topology refreshes. Ordinary sampling avoids
per-task child walks when the global parent scan is available. Tree termination
bypasses the cache and still checks current task children. Windows sampling uses
the job's existing PID set instead of scanning all tracked processes per thread.

Forced-refresh results:

| Pair | Before CPU ms | After CPU ms | Before peak sampler RSS MiB | After peak sampler RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1079.005 | 632.725 | 95.355 | 91.848 |
| 2 | 1028.997 | 563.987 | 100.230 | 93.891 |
| 3 | 1115.273 | 590.908 | 95.418 | 92.738 |

`bun bench/process-load.ts --live --roots 64 --wall-clock` uses the real clock
for the same 100 ticks and 6,400 observations. There is no sleep between ticks.
It exercises ordinary high-frequency sampling, including fresh CPU accounting
while the parent-link cache is still valid. It is not a production one-second
sampling schedule or a long-running profile.

| Pair | Before CPU ms | After CPU ms | Before peak sampler RSS MiB | After peak sampler RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 876.618 | 457.939 | 94.973 | 81.953 |
| 2 | 973.944 | 453.342 | 94.832 | 82.391 |
| 3 | 963.667 | 459.777 | 95.926 | 82.129 |

The work-count table records fewer procfs reads and zero per-task child walks
in ordinary sampling. `bun bench/process-load.ts` probes the same mechanism
without native fixtures.

This measures the sampler's CPU and heap, not provider computation. The sum of
fixture RSS stayed around 1.5 to 1.6 GiB and includes shared pages. It is not
unique physical memory and does not establish a reduction in provider memory.
No fresh Windows sampling timing or macOS measurement supports a numeric claim.

### Team refreshes

`bun bench/delegation-load.ts 8 16` creates eight paused teams with eight
children each on a real temporary core. One client subscribes to a root and
reads the team's view after each invalidation. It pushes load updates to all
64 children for 16 ticks. An RPC barrier after each tick drains its events on
the same socket before measuring the next tick.

Load-only updates now patch summaries without invalidating team history.
Semantic changes coalesce per root while still notifying subscribed children.
Result lookup uses the existing `(thread_id, turn_id)` index. Process history
also gains `(thread_id, started_at DESC)` for its newest-first bounded reads.

The selected team went from 128 snapshots and 738,560 serialized JSON
characters to one snapshot and 5,708 characters. The remaining initial refresh
comes from metadata normalization on the first summary push. It does not recur
on later load ticks. These counts measure JSON before transport compression.
Upstream main removed launch-limit fields before the after build.

| Pair | Before CPU ms | After CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 354.615 | 116.790 | 93.008 | 86.910 |
| 2 | 348.458 | 116.122 | 92.863 | 85.898 |
| 3 | 344.212 | 111.967 | 92.859 | 85.164 |

The browser store separately permits one active read and one trailing read per
client, thread and navigation generation. A held-response regression produces
two reads for an event burst. Load pushes update team rows with zero reads and
overlay older in-flight snapshots. Save results unlock controls immediately;
old requests cannot overwrite a newer configuration. These tests establish
request counts and correctness, not browser CPU or retained heap savings.

The core retains one metadata fingerprint per child until that thread is
removed. A large archived-team history needs a separate retained-memory
measurement; the empty-core idle result does not cover that population.

### Idle

`bun bench/core-idle.ts 10` starts a full offline core, lets startup settle for
4.5 seconds and samples ten seconds without forced garbage collection.

| Pair | Before CPU ms | After CPU ms | Before median RSS MiB | After median RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 35.538 | 44.049 | 60.395 | 60.324 |
| 2 | 37.404 | 38.804 | 60.328 | 60.148 |
| 3 | 41.839 | 38.139 | 60.789 | 60.344 |

Median CPU rose by 1.40 ms per ten-second window, from 0.373% to 0.387% of one
CPU core. Median RSS fell by 0.07 MiB. These windows exclude long-period update
checks and warm provider sessions. A 30% idle gain is not demonstrated.

### Reproduce the comparison

Run the commands above for a source-level probe. The recorded comparison uses
each benchmark compiled separately in each checkout, with Bun 1.4.2:

```sh
bun build --compile --target=bun-linux-x64-baseline bench/streaming-load.ts --outfile=/tmp/streaming-bench
taskset -c 2,3 nice -n 10 /tmp/streaming-bench 128 32
```

Compile `process-load.ts`, `delegation-load.ts` and `core-idle.ts` the same
way, then pass their documented arguments. Use the same available two-CPU mask
for both builds. Copy the latest benchmark source to the before checkout so
work counts, clock modes and cleanup match. Alternate before and after three
times per scenario. Every invocation creates its own temporary state.

## Remaining candidates

These are code-supported mechanisms that still need representative runtime
measurements. Their expected gains are not included in the results above.

| Priority | Mechanism | Next measurement or change |
| --- | --- | --- |
| High for RAM | Provider processes can dominate aggregate memory. Warm sessions trade retained processes for startup latency. | Measure each provider's working set, running and warm process counts, and reuse latency under a realistic multi-agent task before changing release policy. |
| High for large queues | `scheduler.ts` allocates and scans running entries for each queued candidate; team pause checks still read thread metadata. | Benchmark blocked queues across many teams. Build active-thread membership once per synchronous pump, preserving admission order and pause/login behavior. |
| High for many clients | `server.ts` routes each event through all connections; `server/connection.ts` serializes identical frames per accepted socket. | Measure event-loop delay, bytes and allocations with multiple subscribed and unrelated clients. Index subscribers and share serialization while preserving permissions, ordering and backpressure. |
| Medium for browser RAM | Expanded `ToolGroup.svelte` and `ToolCard.svelte` retain their built bodies after collapse. `DiffDocument.svelte` and `DiffView.svelte` can compute the same large diff twice. | Capture DOM count and heap before expansion, after collapse and after reopening. Bound mounted bodies and share document-scoped diff work. |
| Medium during recovery | `continuation.ts` formats and scans old history before clipping its final excerpt. | Measure simultaneous session recovery with long tool output. Bound formatting and history access without losing move markers or image capability checks. |
| Medium for Windows bursts | Audio muting walks endpoints when adding each PID; the Jobs Worker forwards duplicate global-job process notifications that the main thread discards. | Measure a process-start burst. Batch mute setup without allowing audible startup, and discard duplicate global packets before opening handles while preserving memory-limit notifications. |
| Low until measured | Unfinished answer lines rescan growing text; trace clocks can tick while hidden. | Profile long lines and visibility changes. Preserve append/replacement semantics and existing process-history limits. |

The existing lazy SDK/worker startup, bounded reading cache, message
virtualization and visibility-aware resource polling should remain. Real
provider load, Tauri/WebView memory, browser heap and a long idle soak remain
unmeasured. The subsystem percentages cannot be added together: total savings
depend on how much each subsystem contributes to the actual workload.

Warm retention already defaults to zero minutes. A pressure-based warm-session
pool would help only when retention is enabled, and must preserve active turns
and background work. The memory governor protects registered agent roots; a
root-only workload can exceed its budget without an eligible child to kill.
Reducing an active provider's heap needs provider-specific measurements rather
than a tighter limit that merely changes which work can run.

## Post-merge delegation check

On 2026-09-29, one fresh Windows run at code commit `6dfdc477` checked the
integration of native-agent reads and quiet-stream write recovery. Bun 1.4.2,
eight teams, 64 children and 16 load ticks; no provider process starts.

```sh
bun bench/delegation-load.ts 8 16
```

CPU time was 31 ms, elapsed time 34.07 ms and sampled peak RSS 90.19 MiB
(80.69 MiB before the measured loop). The selected team received one
notification and one snapshot, totaling 5,998 JSON characters. This after-only
Windows check does not replace the paired Linux measurements above.

```json
{"teams":8,"children":64,"ticks":16,"cpuMs":31,"wallMs":34.072900000000004,"notifications":1,"snapshots":1,"wireBytes":5998,"rssBeforeMiB":80.69140625,"sampledPeakRssMiB":90.1875,"bun":"1.4.2","platform":"win32"}
```

## Post-integration bundle check

On 2026-09-30, the CI preview combined this branch with `c26a03a6`, including
settings synchronization and update shutdown. A fresh local build of that
combination reproduced the UI sizes reported by the failed desktop job.
Shortening only the scope-class prefix keeps Svelte's full hash. Loading the
settings synchronization implementation on first use removes it from startup.

```sh
NODE_ENV=production bun run build:ui
bun run build:core
bun scripts/ci/budgets.ts
```

| Uncompressed artifact | Before | After | Difference |
| --- | ---: | ---: | ---: |
| UI entry | 526,386 bytes | 519,026 bytes | -7,360 bytes |
| Whole UI, excluding compressed copies | 3,395,116 bytes | 3,359,837 bytes | -35,279 bytes |
| Core main bundle | 818,586 bytes | 818,586 bytes | 0 bytes |

These measurements pass the former 520,000-byte entry and 3,382,700-byte
UI limits. The local core exceeded its former limit by 987 bytes; CI measured
818,547 bytes, or 947 above that limit. A subsequent base integration retains
the 578,000-byte entry, 3,737,000-byte UI and 904,000-byte core limits already
set by `db13ed65`; this audit does not increase those limits. Core function
names remain readable in errors.
These are emitted-file measurements, not CPU or resident-memory savings.
The deferred-import cancellation extension failed without its post-import
stop check, then passed after restoration; the original slow-read protection
and stage-error recovery assertions remain.

Subsequent 2026-09-30 integration measurements:

| Integration | UI entry bytes | UI total bytes | Core main bytes | Checks and captures |
| --- | ---: | ---: | ---: | --- |
| `ced5379f` | 519,144 | 3,359,955 | Not remeasured | Question-card Enter added 118 bytes to both UI measures. Production build passed; QuestionCard/settings-sync: 20 tests, 7.19 s. Additional UI E2E: 21 tests, 150 assertions, 24.97 s. Question desktop and Markdown desktop/phone-width captures opened. |
| `c3b0333a` | 519,499 | 3,363,249 | 823,664 | Retained limits and `bun run check` passed with zero Svelte errors/warnings. Accounts, Codex, terminal, line and Windows-job scenarios: 99 core tests. Six UI suites: 128 tests, 8.03 s. Accounts/settings E2E: ten tests, 52 assertions, 35.48 s. Provider-detail desktop/narrow and login desktop/phone-width captures opened; account actions fit and phone administration stayed hidden. |
| `ae3ecc5b` themes | 528,499 | 3,419,984 | 823,664 | Retained limits: 588,000 entry, 3,796,000 UI, 904,000 core bytes. Types/architecture passed; four theme/settings-sync suites: 22 tests, 2.13 s. Prebuilt theme/delegation E2E: six tests, 42 assertions, 20.79 s. Theme, conversation and delegation desktop/phone-width captures opened with usable controls/composers. |
| `c17c4cb0` bus/dispatch | 528,941 | 3,420,426 | 829,407 | Retained limits passed. Core: 1,303 tests, 22 skips, 131 fresh processes, 79.97 s. UI: 1,030 tests, 145 files, 75.90 s. Types/architecture passed. Delegation/native-agent E2E: five tests, 29 assertions, 9.40 s; desktop/phone-width captures regenerated and opened. |

The `c17c4cb0` integration exposed a phantom team notification after real SQLite
rollback. Moving delegation reactions after commit made the regression pass;
it also retained stopped-admission and later committed-update assertions.
These after-only checks do not replace the paired Linux resource measurements.

## Verification

- `bun run check`: architecture and TypeScript passed; Svelte reported zero
  errors and warnings.
- `bun run --cwd packages/core test`: 1,283 passed, 22 skipped, zero failed;
  all 129 files ran in fresh Bun processes, four at once, in 153.65 seconds.
- `bun run --cwd packages/ui test --maxWorkers=4` at `4f458c4c`: 1,018 tests passed
  in 144 files in 119.83 seconds with four workers; the subsequent base
  integration's affected paths were checked separately as recorded above.
- `NODE_ENV=production bun run build:ui`: production UI build passed.
- `BOITE_E2E_PREBUILT_UI=1 bun test tests/e2e/settings.test.ts
  tests/e2e/machines.test.ts tests/e2e/app-updates.test.ts
  tests/e2e/core-update.test.ts tests/e2e/delegation.test.ts
  tests/e2e/native-agents.test.ts --parallel=1 --timeout 60000`:
  25 tests passed at `4f458c4c` in six files in 126.75 seconds, covering real RPC, reload,
  settings cancellation, update shutdown, delegation and phone interaction.
- Opened `tests/e2e/.artifacts/delegation-desktop.png` and
  `tests/e2e/.artifacts/delegation-phone.png`, plus both native-agent captures:
  selected child transcript, separate native rows and usable composer at both widths.
- `bun run test:shell --release`: 75 passed, zero failed, in 5.08 seconds.
- Transient streaming-write failure recovered automatically with no new
  mutation or explicit persistence; the extended scenario failed before the fix.
- Live native-agent reads leave both current and unrelated SQL rows unchanged;
  stale persisted tools cannot override live updates. Pagination and restart pass.
- The earlier 32 MiB CPU guard rejected the quadratic control at 516 ms with
  its original 300 ms floor and 20x yardstick. Integrating `c3b0333a` retains
  the base's deterministic scanned-input bound: the quadratic control submits
  8,640,266,252 characters to newline searches against a 33,554,444-character
  limit and fails while its full-record assertions pass. The real file passes
  all 13 tests.
- `bun test packages/core/test/linux-load.test.ts
  bench/process-load.test.ts bench/streaming-load.test.ts --timeout 60000`:
  23 tests passed. New cases verify fresh CPU ticks between topology refreshes,
  preservation of primary and cleanup errors, and temporary-directory cleanup
  when journal construction or close fails.

A Windows forgotten-job check timed out once after the main merge. Its five
isolated first-case runs, complete three-case file and full-suite rerun passed.
Named timeout diagnostics now distinguish live processes from retained jobs;
the 20-ID, five-second and kernel-handle assertions remain unchanged. No native
ownership fix is claimed from that unreproduced timeout.
Integrating `c3b0333a` also retains the base's pipe draining and garbage
collection before the kernel-handle comparison. The combined check preserves
the named diagnostics, 20 IDs, five-second windows and leak threshold.

The suite exposed short-lived fixture races in queue admission, install leases
and an extension dialog. Tests now hold the queue slot/process until release
and raise the late dialog only after turn completion. Orphan grace uses
captured birth times. Assertions and real launcher paths remain.
The trace scenario checks retained PIDs against captured start events, including
native descendants, rather than assuming one OS process per launch.

Earlier full runs with Bun 1.4.2's reused parallel workers reached a native
segmentation fault or late-file timeouts. The same cases passed in fresh
processes. The default core test command now bounds concurrency and starts each
file in a fresh process, preserving all tests and full output. This repairs the
verification path; it does not establish or fix the cause of the Bun crash.

## Historical CI measurements

These observations were recorded before the 2026-10-01 CI coverage changes.
They describe their dated builds and runners, rather than the current checkout.

### Cache and worker observations

On 2026-09-22, PR cache copies occupied 13.5 GB and eviction removed main's
Windows Cargo cache and both Linux caches. GitHub's repository cache allowance
was 10 GB. Bun's download store used 200 to 350 MB per platform, about a quarter
of that cache. On macOS ARM64 that day, workspace setup took 8 s on a miss and
10 s on a hit. These observations motivated main-only saves and uncached Bun
installs.

The reused-worker core runner measured 189 s serially, 35 s with 16 workers
and 53 s with four workers on 2026-09-25. Those timings do not describe the
fresh-process runner introduced after Windows Bun 1.4.2 crashes and late-file
timeouts observed on 2026-09-29.

### Hosted jobs before E2E partitioning

Where the time goes, from `gh run view` on the 23 finished `ci` runs before
2026-09-25 14:20 UTC: a run took 13.8 minutes at the median. The Windows
desktop job sets that length (12.8 minutes): 5.8 for the end-to-end suite, 3.5
for the installer build and 1.1 for the Rust tests. Every other job a pull
request waits on finishes in under 6 minutes; the Windows core job took 4.9, of
which 4.1 were the serial core tests that parallel workers now shorten. The
Intel macOS portable leg (16.2 minutes) runs only after a merge and on
releases. Four of those runs failed: three in the Windows end-to-end suite and
one in the Ubuntu core tests. Rerun the same query before quoting new numbers.

### Bundle budget history

The initial limits sat about 10% above the sizes measured on 2026-09-26 (337 KB, 2221 KB and
649 KB; `main` built a 681 KB core that day). The core's limit moved on
2026-09-27 to 10% above the 726 KB core of the agent hooks change, whose
descriptor checks, profile sharing and hook ledger all run at startup. The
whole UI's limit moved on 2026-09-28 to 10% above 3003 KB, once Settings,
Appearance, Reading bundled seven more faces (about 600 KB of woff2 and their
licences): a browser fetches a face's file only after it is picked, so the
entry chunk and the first screen do not carry them. The entry chunk's limit
moved the same day to 448 KB with the buttons chosen from Appearance. Folded
tool rows, their diffs, the question dock and the zoom applied at boot also
draw a thread's first screen: they added 13 KB to the 362 KB `main` of that
morning, and the merge of both built 424 KB, under that limit. It moved again
to 520 KB, 10% above the 462 KB that `bun run build:ui` then
`bun scripts/ci/budgets.ts` measured on 2026-09-28 for the change that edits, forks, rewinds and
moves a thread from its messages and menus, folds changed files and archives
projects: all of it draws on the first screen. The project stack marks (28 KB)
and the find bar stay out of the entry chunk and load when first needed. Raise
one in the change that explains the growth. On 2026-09-29 the compact theme
picker, colour math, persistence and prepaint handling added 9,000 bytes to
the entry chunk and 57,141 bytes to the complete UI, including palette CSS,
French strings and community license notices. The Windows desktop jobs measured
524,773 / 3,393,503 bytes on `main` at `c26a03a` and 533,773 / 3,450,644 bytes
with the themes at `bedd795`. The UI limits moved to 588,000 and 3,796,000 bytes,
about 10% above the combined build; the core limit stayed at 817,600 bytes.
The later account connection changes raised the core limit to 904,000 bytes
([measurements](#runtime-and-bundle-measurements-2026-09-19-to-2026-09-29)).
The resource audit retains those limits, shortens scope-class prefixes and
loads settings synchronization on first use to reduce emitted bytes while
keeping readable core function names in errors. On 2026-10-01 automatic
compaction (its timers, checks and settings validation), on top of the handover
of running turns, built a 904,139-byte core on the Windows desktop job, 139
bytes over; the core limit moved to 995,000 bytes, about 10% above it. Shared-runner timings were not gated.
### E2E partition measurements, 2026-09-28

`bench/e2e.ts` runs every test in both modes and records per-group logs, elapsed
time and JUnit reports. Case identities and counts come from JUnit, even when
Bun suppresses passing console lines. Its comparison requires the serial report
first and refuses failures, skipped tests or a different list of test cases.
The parallel measurement uses four local
processes, including the native shell; CI used separate runners for those
groups. Build and stage the shell once, then run from the checkout root:

```powershell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
$env:BOITE_E2E_PREBUILT_UI = '1'
$env:BOITE_E2E_FAKE_UI = 'tests/e2e/.artifacts/fake-ui'
bun tests/e2e/lib/warm.ts $env:BOITE_E2E_FAKE_UI
bun bench/e2e.ts serial
bun bench/e2e.ts sharded
bun bench/e2e.ts compare tests/e2e/.artifacts/timings/serial/result.json tests/e2e/.artifacts/timings/sharded/result.json
```

Run serial and sharded measurements on the same machine and checkout. Report
local test latency separately from hosted CI latency and bot review latency.
More concurrent runners can reduce elapsed time while increasing total runner
minutes; the comparison does not claim a reduction in compute cost.

On 2026-09-28, the commands above on Windows with Bun 1.4.2 produced:

| Local measurement | Serial | Sharded |
| --- | ---: | ---: |
| Elapsed E2E time | 252.66 s | 103.74 s |
| Passing cases | 185 | 185 |
| Assertions | 1,184 | 1,184 |
| Failures or skipped tests | 0 | 0 |

The comparison reported `Same test cases; elapsed time reduced by 58.9%`.
Two earlier sharded runs took 123.48 s and 119.56 s against a 272.31 s serial
reference, with the same 185 cases. These are local measurements with prepared
builds, not hosted workflow or review-cycle measurements.

The first hosted run of [PR #108](https://github.com/beboite/boite/actions/runs/36480733289)
passed all checks on its first attempt. Against the medians of successful runs
from the September 28 PR audit:

| Hosted measurement | Previous median | PR #108 |
| --- | ---: | ---: |
| Complete CI workflow | 15 min 41 s | 6 min 57 s |
| Windows desktop job | 14 min 43 s | 6 min 31 s |
| Full E2E window | 8 min 28 s | 5 min 35 s |

The E2E window starts with the first preparation step and ends when every E2E
group, including the native shell, has finished. It includes the native suite's
wait for the installer build. The hosted logs contain the same 185 cases as the
local reference. These reductions, 55.7%, 55.7% and 34.1%, compare historical
medians with one new run; repeated hosted runs are needed to establish a median.
The desktop job still spent 3 min 32 s building the installer, 1 min 12 s
compiling and running Rust tests, and 35 s in the native shell E2E suite.

### Nightly image scheduling, 2026-09-29

On 2026-09-29, `gh run view 36531647917 --json jobs` showed verification's last
build finishing at 06:44:34 UTC and the server build starting at 06:44:48. The
slowest server build took 4 min 27 s. Overlapping it with verification removes
that serial build phase; the resulting total duration still needs a GitHub run
to measure runner availability and cache effects.

## Stress measurements, 2026-09-29 and 2026-09-30

Recorded commands:

```sh
bun run test:stress
bun run bench:stress --threads 1000 --concurrency 64 --clients 12 --output stress.json
bun run bench:stress --threads 1000 --concurrency 64 --clients 0 --output stress-solo.json
```

Initial measurements on Windows with Bun 1.4.2, 2026-09-29, before scheduler
launch limits were retired:

| Scenario | Observed result |
| --- | --- |
| 24 scripted agents, cold then warm turns | Initially 38 processes instead of 24; sharing the pending driver load kept all 24 warm processes |
| 1,000 echo threads, one observer, initial baseline | Both streaming bursts completed with exact answers; all 1,000 turns cancelled and recovered after a crash |
| Same baseline, core memory at 64 concurrent turns | 115.8 MiB; this excludes real agent processes |
| Same baseline, scheduler payloads | 163.3 MiB of decoded scheduler JSON on one connection during the 64-turn burst |
| 1,000 threads and 12 additional readers before request pacing | Three HTTP requests timed out after ten seconds each; turn-start requests exceeded thirty seconds |
| Same load after bounded dispatch and snapshot coalescing | Both bursts passed with exact streams; six concurrent turns took 60.0 s and 64 took 59.4 s |
| Same run, independent health | No timeouts; p95 217/660 ms and maximum 1.81/3.51 s at six/64 concurrent turns |
| Same run, scheduler payloads at 64 concurrent turns | 7.0 MiB of decoded JSON on the owner connection |
| Same run, mass cancellation and crash recovery | All 1,000 turns cancelled in 19.5 s; 64 running and 936 queued turns recovered after an 8.1 s restart |
| Production UI, 1,000 threads and a 256-turn burst | Foreground reply in 0.99 s, typing in 3.7 ms and maximum timer lag 36 ms; desktop and phone-width browser captures checked |

After launch limits were retired, the same command with 12 additional readers
passed on 2026-09-30 after grouping synchronous startup and completion writes:

| Scenario | Observed result |
| --- | --- |
| 1,000 threads, workloads bounded by the generator | Exact streams at six/64 concurrent turns in 40.8/18.3 s |
| Independent HTTP health during streaming | Zero errors; p95 58/131 ms and maximum 1.84/0.16 s at six/64 concurrent turns |
| Scheduler payloads at 64 concurrent turns | 1.09 MiB of decoded JSON on the owner connection; no scheduler queue in this workload |
| All 1,000 turns running together, cold then already used | Starts accepted in 10.2/10.6 s and cancelled in 9.7/6.1 s with the 30-second RPC deadline unchanged |
| Independent HTTP health during mass start/stop | Zero errors; p95 117/109 ms and maximum 3.27/0.15 s for cold/warm phases |
| Crash with 1,000 running turns | All recovered, earlier answers and both cancellations preserved, and a new turn completed after a 3.0 s restart |
| Production UI, 2026-09-30, 1,000 threads and a 256-turn burst | Foreground reply in 0.68 s, typing in 3.3 ms and maximum timer lag 26 ms; desktop and phone-width browser captures checked |

Two additional runs exceeded the 30-second deadline during 1,000 simultaneous
starts. The instrumented failure accepted 505 starts before expiry, with no
HTTP errors and maximum health latency 1.00 s. The full run above then passed
with the same deadline. Background machine load was not controlled. These runs establish
failures and reproducible checks. They do not
establish a supported agent count or measure real provider quotas, agent RAM,
the native shell, Linux or macOS under this load.
The recorded UI test gave background RPCs the benchmark's 30-second deadline, while
the application used 120 seconds. Visible replies kept a 30-second deadline;
typing and individual browser tasks had to stay below five seconds. Foreground
timing excludes the separate wait for the background batch to be accepted.

## Runtime and bundle measurements, 2026-09-19 to 2026-09-29

In the recorded Windows build, `bun build --compile` wrote an 86 MB executable with no signature, and Windows
11 inspected it at every start: about 650 ms pass between the spawn and the
first line of script, 5 ms of it inside the process, and a compiled hello-world
costs the same. The Bun runtime carries its publisher's signature and skips
that. So the Windows installer ships the runtime as `boite-core.exe` with the
bundled core in `core/` beside it ([release layout](../../docs/releasing.md)). Renaming the
runtime changes nothing: the signature is in the file.

Core alone, spawn to `/health`, medians of 7, 2026-09-19. The parent is a
second copy of the runtime, because a child whose image the parent already has
mapped starts in 105 ms and would flatter the result:

| core started as | ms |
| --- | ---: |
| compiled `boite-core.exe` | 902 |
| runtime copied as `boite-core.exe`, running `dist/main.js` | 260 |

`bun run bench/startup.ts --runs 7`, medians, on a release shell with the
compiled core beside it, then on one staged with the runtime and the bundle:

| spawn to | compiled | runtime and bundle |
| --- | ---: | ---: |
| core answering `/health` | 1215 | 559 |
| first contentful paint | 749 | 604 |
| UI holding its data | 1245 | 716 |

Linux and macOS keep the compiled core: nothing was measured there.

## The x64 runtime is Bun's baseline build

Bun publishes two x64 builds. The default one needs AVX2, so it stops with an
illegal instruction on a pre-Haswell CPU and on many Celeron, Pentium and Atom
laptops. The Windows sidecar, the compiled core on x64 Linux and Windows, and
the server core are the baseline build, and the Docker image's `oven/bun` base
already ships the baseline build for x64. On this core the choice costs nothing
measurable. Bundle under each runtime, both runtimes copied away from the
parent's own image, a fresh data directory, `BOITE_HOST_AGENTS=0`, 2026-09-25 on
a Ryzen 7 9800X3D:

| runtime | spawn to `/health`, median of 6 | echo turn round trip, median of 7 |
| --- | ---: | ---: |
| `bun-windows-x64` 1.4.2 | 245 ms | 162 ms |
| `bun-windows-x64-baseline` 1.4.2 | 244 ms | 162 ms |

The echo turn is `docker/smoke.ts create` run against that core with
`BOITE_SMOKE_PROVIDERS=echo`: project, account, thread, one turn and its
completion. Local dictation's whisper.cpp runtime needs no AVX2 either: its
`whisper-bin-x64.zip` ships `ggml-cpu-*.dll` backends from plain x64 to Alder
Lake, and ggml loads the one the CPU supports.

The bundle and the compiled core minify whitespace and syntax and keep
identifiers, so a logged stack still names its functions. On the Windows
sidecar that moved spawn to `/health` from a median of 249 ms to 244 ms over 7
runs on the same day. The compiled core also carries bytecode, which saves
parsing where no signature check dominates the start; on Windows the compiled
core stayed at about 790 ms either way.

The account connection changes measured on Windows CI on 2026-09-29 use
525,128 bytes for the UI entry chunk, 3,396,864 bytes for the UI distribution
and 821,226 bytes for the core bundle. Account editing and device-login UI
add client code; native authentication checks add core code. The size budgets then retained about 10% headroom above those measurements.
