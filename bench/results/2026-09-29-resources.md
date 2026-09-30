# Concurrent-agent resource audit

Measured on 2026-09-29 with Bun 1.4.2 on Linux x86-64. The before build is
`606bc56d`; the after build is `359517ef`, including the review fixes and
merged main through `33b9d8ce`. Both builds use the same benchmark source and
compiler target `bun-linux-x64-baseline`, the same two logical CPU affinity
and nice level 10. Each sample starts a fresh process and uses a fresh temporary
journal. There are three samples per build and scenario. No provider login or
paid turn is used. [Raw sample output](2026-09-29-resources.json) includes CPU,
elapsed time, RSS, heap samples and work counts.

The targeted streaming workload exceeds the 30% to 50% CPU and RAM reduction
goal. Process sampling and team updates exceed the CPU goal. Idle does not
improve. These measurements do not establish that reduction for the whole
desktop application or the combined memory of real provider processes.

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

SQLite part updates fell from 4,096 to 128. Median elapsed time fell from
9,330 ms to 390 ms. Peak JS heap fell from 100.11 MiB to 31.48 MiB.

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

Median procfs reads fell from 65,643 to 22,700 with forced refresh, and from
55,359 to 19,299 with the wall clock. Per-task child reads fell to zero in both
regular sampling modes. The synthetic probe `bun bench/process-load.ts`
checks the same mechanism without native fixtures.

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

At `ced5379f`, the base's question-card Enter behavior adds 118 bytes to both
UI measurements: the entry is 519,144 bytes and the whole UI is 3,359,955.
The production build passed; QuestionCard and both settings-sync suites passed
all 20 targeted tests in 7.19 seconds. The additional `ui.test.ts` end-to-end
run passed 21 tests and 150 assertions in 24.97 seconds. Its question desktop
capture and Markdown desktop/phone captures were opened after regeneration.

After resolving the test conflicts with `c3b0333a`, a fresh production build
emits a 519,499-byte UI entry, 3,363,249 bytes of UI files and an 823,664-byte
core main bundle. All three retained upstream limits pass. `bun run check`
passes with zero Svelte errors or warnings. The affected accounts, Codex,
terminal, line and Windows-job scenarios pass all 99 core tests; six UI suites
pass 128 tests in 8.03 seconds. These integration checks do not replace the
dated paired resource measurements above.
The accounts/settings end-to-end set passes ten tests and 52 assertions in
35.48 seconds. Fresh provider-detail desktop/narrow and login desktop/phone
captures were opened; labels and account actions fit, and phone provider
administration remains hidden.

Resolving the documentation conflict with `ae3ecc5b` retains its themes and
588,000-byte entry, 3,796,000-byte UI and 904,000-byte core limits. The fresh
combined UI measures 528,499 bytes for its entry and 3,419,984 bytes in total;
the core remains 823,664 bytes. Types and architecture pass, four theme and
settings-sync suites pass 22 tests in 2.13 seconds, and the prebuilt theme and
delegation end-to-end set passes six tests and 42 assertions in 20.79 seconds.
Fresh theme, conversation and delegation desktop/phone captures were opened;
colour controls and composers remain usable without overlap.

On 2026-09-30, integrating `c17c4cb0` combines the audit with committed bus
notifications and bounded RPC dispatch. A real SQLite rollback after child
events exposed a phantom team notification. Delegation now reacts only after
commit; the regression also checks unchanged stopped admission and a later
committed update with the same summary. It fails before the listener fix and
passes afterward. All 1,303 core tests pass, with 22 skips across 131 fresh
processes in 79.97 seconds; all 1,030 UI tests pass in 145 files in 75.90 seconds.
Types and architecture pass. Five delegation/native-agent end-to-end tests
and 29 assertions pass in 9.40 seconds; regenerated desktop/phone captures were
opened. The current UI entry measures 528,941 bytes, UI files total 3,420,426
bytes and the core main bundle measures 829,407 bytes. Retained limits pass.

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
