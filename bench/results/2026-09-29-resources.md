# Concurrent-agent resource audit

Measured on 2026-09-29 with Bun 1.4.2 on Linux x86-64. The before build is
`606bc56d`; both builds use the same benchmark source and compiler target
`bun-linux-x64-baseline`. Each sample starts a fresh process and uses a fresh
temporary journal. There are three samples per build and scenario. No provider
login or paid turn is used.

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
| 128 streams, reading one thread | 12,770 ms | 558 ms | 95.6% | 285.15 MiB | 112.36 MiB | 60.6% |
| 64 process roots, 100 sampling ticks | 1,854 ms | 726 ms | 60.8% | 106.27 MiB | 98.57 MiB | 7.2% |
| 8 teams, 64 children, 16 load ticks | 510 ms | 166 ms | 67.4% | 95.43 MiB | 86.73 MiB | 9.1% |
| Idle core, 10 seconds | 73.28 ms | 73.96 ms | No improvement | 60.58 MiB | 60.56 MiB | No improvement |

Additional medians and exact work counts for the same runs:

| Workload | Metric | Before | After |
| --- | --- | ---: | ---: |
| 128 streams, reading one thread | Elapsed time | 13,595 ms | 564 ms |
| 128 streams, reading one thread | SQLite part updates | 4,096 | 128 |
| 64 process roots, 100 sampling ticks | Elapsed time | 1,703 ms | 636 ms |
| 64 process roots, 100 sampling ticks | Procfs reads | 80,336 | 21,800 |
| 8 teams, 64 children, 16 load ticks | Elapsed time | 268.94 ms | 99.82 ms |
| 8 teams, 64 children, 16 load ticks | Selected-team snapshots | 128 | 1 |
| 8 teams, 64 children, 16 load ticks | Serialized JSON characters | 738,560 | 5,770 |

The journal saves 12,212 ms of accumulated CPU and 172.79 MiB of sampled peak
RSS in this workload. The sampler saves 1,127 ms CPU and 7.70 MiB RSS. Team
refreshes save 344 ms CPU and 8.70 MiB RSS. These absolute differences use the
unrounded medians. They cover equal work; they are not per-second rates for a
running application.

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
13,595 ms to 564 ms. The stream-only control, without intermediate reads, kept
128 writes in both builds and roughly 100 MiB RSS. Its median CPU was 532 ms
before and 476 ms after; it does not support a general 30% streaming-only gain.

| Pair | Before CPU ms | After CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 12,656.126 | 558.069 | 257.578 | 112.363 |
| 2 | 12,770.053 | 581.230 | 293.156 | 111.578 |
| 3 | 12,823.664 | 555.952 | 285.148 | 113.172 |

Peak RSS is sampled after synchronous cycles, so it is a lower bound. This
scenario isolates the journal and excludes the browser and provider heaps.

A single Windows run of the same read-heavy scenario also fell from 46,375 ms
CPU and 285.94 MiB sampled RSS to 2,219 ms and 108.21 MiB. Its stream-only
control used more CPU after the change despite lower elapsed time. That
filesystem-heavy sample is noisy; the repeated Linux results are the primary
comparison.

### Process sampling

`bun bench/process-load.ts --live --roots 64` starts 64 sleeping Bun fixtures
and samples their real Linux procfs records for 100 ticks. The clock advances
one second per tick without a real one-second wait, forcing the global scan on
every tick. All 6,400 root observations are verified. Finally, the benchmark
kills and waits for only the process handles it captured at spawn.

The sampler reuses stat lines from the shared procfs scan. Ordinary sampling
avoids per-task child walks when the global parent scan is available. The
500 ms cache serves all sampled threads. Tree termination bypasses that cache
and still checks current task children. The Windows sampler now uses the job's
existing PID set instead of scanning all tracked processes for each thread.

Median procfs reads fell from 80,336 to 21,800 per 100 ticks. Per-task child
reads fell to zero in the regular Linux sampling path. Median elapsed time fell
from 1,703 ms to 636 ms. The separate synthetic probe
`bun bench/process-load.ts` checks the same mechanism on other platforms.

| Pair | Before CPU ms | After CPU ms | Before procfs reads | After procfs reads |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1,844.434 | 679.706 | 80,178 | 21,800 |
| 2 | 1,907.143 | 784.601 | 83,505 | 21,899 |
| 3 | 1,853.506 | 726.344 | 80,336 | 21,600 |

This measures the sampler's CPU and heap, not provider computation. The sum of
fixture RSS stayed around 1.6 GiB and includes shared pages. It is not unique
physical memory and does not establish a reduction in provider memory. No
fresh Windows sampling timing or macOS measurement supports a numeric claim.

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
characters to one snapshot and 5,770 characters. The remaining initial refresh
comes from metadata normalization on the first summary push. It does not recur
on later load ticks. These counts measure JSON before transport compression.

| Pair | Before CPU ms | After CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 439.400 | 159.267 | 95.332 | 88.008 |
| 2 | 510.252 | 166.150 | 95.434 | 86.730 |
| 3 | 537.532 | 186.475 | 96.418 | 86.105 |

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
4.5 seconds and then samples ten seconds without forced garbage collection.

| Pair | Before CPU ms | After CPU ms | Before median RSS MiB | After median RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 73.275 | 74.841 | 60.582 | 60.559 |
| 2 | 97.813 | 73.598 | 60.664 | 60.535 |
| 3 | 70.986 | 73.955 | 60.340 | 60.652 |

The median is about 0.7% of one CPU core in both builds. Ten-second windows
exclude long-period update checks and warm provider sessions. A 30% idle gain
is not demonstrated by this audit.

## Remaining candidates

These are code-supported mechanisms that still need representative runtime
measurements. Their expected gains are not included in the results above.

| Priority | Mechanism | Next measurement or change |
| --- | --- | --- |
| High for RAM | Provider processes can dominate aggregate memory. Warm sessions trade retained processes for startup latency. | Measure each provider's working set, running and warm process counts, and reuse latency under a realistic multi-agent task before changing release policy. |
| High for large queues | `scheduler.ts` scans running entries for each queued candidate; `delegation.ts` rereads running-thread metadata to count siblings. | Benchmark blocked queues across many teams. Compute account, thread and parent counts once per synchronous pump, preserving admission order. |
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

## Verification

- `bun run check`: architecture and TypeScript passed; Svelte reported zero
  errors and warnings.
- `bun run --cwd packages/core test`: 1,235 passed, 21 skipped, zero failed;
  all 124 files ran in fresh Bun processes, four at once, in 236.04 seconds.
- `bun run --cwd packages/ui test --maxWorkers=4`: 990 tests passed in 139 files.
- `NODE_ENV=production bun run build:ui`: production UI build passed.
- `BOITE_E2E_PREBUILT_UI=1 bun test tests/e2e/delegation.test.ts
  tests/e2e/collaboration-ui.test.ts tests/e2e/coordination-live-ui.test.ts
  tests/e2e/workflows.test.ts tests/e2e/model-switch.test.ts --parallel=1
  --timeout 60000`: eight tests passed in five files, covering real RPC,
  provider protocol fixtures, reload, delegation and phone interaction.
- Opened `tests/e2e/.artifacts/delegation-desktop.png` and
  `tests/e2e/.artifacts/delegation-phone.png`: selected child transcript,
  forwarded parent message and usable composer at both widths.

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
