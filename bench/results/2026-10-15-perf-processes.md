# Process load tick, 2026-10-15

Linux LXC, Ryzen 7 5825U (16 threads), Bun 1.4.2, fresh temporary
`BOITE_DATA_DIR`, `nice -n 10`. Before is `origin/main` at 3e535df3 with the
same `bench/core-idle.ts`; after is `boite/perf-processes`. Three runs each,
back to back, medians. Other jobs ran on the machine, so the `/proc` scan
(240 to 310 processes) varied between runs.

## Idle core with one live scope

`bun bench/core-idle.ts 20 --scope`: one sleeping process registered under
`terminal:bench`, no thread, no turn, 20 s measured.

| | CPU ms (runs) | median | one core |
| --- | --- | ---: | ---: |
| before | 302, 287, 298 | 298 | 1.49 % |
| after | 154, 151, 146 | 151 | 0.76 % |

The tick runs every 4 s instead of every second while nothing works.

`bun bench/core-idle.ts 20`, no live process: 109 ms before, 88 ms after
(runs 109, 109, 97 and 88, 95, 84). A tick with nothing live and memory `ok`
no longer reads `/proc/meminfo`.

## Linux reads per tick

`bun bench/process-load.ts --live --roots N`, 100 forced ticks. The stat reads
are the machine-wide parent scan and follow the machine's process count; the
other reads are per root.

| roots | non-scan reads per tick, before | after |
| ---: | ---: | ---: |
| 1 | 3.0 | 2.0 |
| 64 | 129.0 | 65.6 |

`/proc/<pid>/comm` is read once per birth instead of every tick. CPU per 100
ticks stayed within the scan's noise: 1,092 vs 1,173 ms at one root, 2,011 vs
1,926 ms at 64 roots. The cgroup files are not read by this bench; on the
core, a root agent's tick reads 3 cgroup files instead of 6, and a spawn no
longer reads `/proc/stat`.

## Bytes per load sample

One load sample for an echo fixture thread, as a JSON-RPC frame
(`JSON.stringify`, deflate with `Bun.deflateSync`):

| frame | bytes | deflated |
| --- | ---: | ---: |
| `thread.updated` (whole row) | 843 | 480 |
| `thread.load` | 154 | 124 |

A client whose hello accepts `thread.load` gets the second frame; real rows
with pull requests, a model and activity are larger than the fixture's.

## Trace rows

`bun bench/process-rows.ts`: a temporary journal, a 2,241-character rustc
command line per row. The exit write of 5,000 started rows, then one thread
that starts and exits 10,000 processes and goes idle once. Before is
`3e535df3` through `--root` on a detached checkout of it; after is
`boite/perf-processes`. `nice -n 10`, three runs each, back to back, medians.

| | exit write per row (runs) | median | exit CPU ms (5,000) | rows kept | table and index bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| before | 194.4, 195.2, 556.5 µs | 195.2 µs | 650 | 10,000 | 41,684,992 |
| after | 71.8, 79.7, 82.5 µs | 79.7 µs | 338 | 2,000 | 8,339,456 |

The exit is an `UPDATE` of five columns instead of an `INSERT OR REPLACE` that
deletes and writes the row with its command line again. The after figures
include the prune that runs every 500 exits of a thread. A thread's rows stop
at its newest 2,000, plus its live rows and the rows its process agent cards
read.

## Spawn lookup

`bun bench/spawn-lookup.ts 300`, 2026-10-15, `nice -n 10`, three runs, an
8-entry PATH with git in `/usr/bin`. Before is the PATH walk Bun repeats on
every spawn of a bare name (`Bun.which('git', { PATH })`); after is the lookup
`procs` now makes (`resolveSpawnCommand`, a remembered hit and one `stat`).

| | runs | median |
| --- | --- | ---: |
| lookup before | 14.29, 11.99, 11.82 µs | 11.99 µs |
| lookup after | 5.27, 4.25, 4.04 µs | 4.25 µs |
| `git --version` spawned by name | 2.418, 2.090, 2.168 ms | 2.168 ms |
| `git --version` spawned by resolved path | 2.400, 2.341, 2.363 ms | 2.363 ms |

On Linux the saving, about 8 µs a spawn, sits inside the spawn's noise. The
lookup grows with PATH times PATHEXT on Windows, where it was not measured.
Running Git for Windows' real `git.exe` instead of its launcher removes one
process per git call there; no Windows host was available to measure it.

## Windows guard and jobs Workers

Unmeasured: these run only on Windows and no Windows host was available. The
counts below come from the fake-backed tests, not from timing.

- Audio-session walks for a burst of 50 new pids inside one 100 ms gap:
  50 before, 1 after plus one shared walk at the end of the gap
  (`bun test test/guard.test.ts -t burst`; the old `MuteLogic` fails it with
  50 walks).
- Guard pump wakeups while a traced process lives and nothing happens:
  10 a second before (100 ms wait), 1 a second after once the pump reported
  its thread (1,000 ms wait, ended early by a `WM_NULL` after each command).
- Jobs Worker messages per agent process start or exit: 2 before (thread job
  and global job), 1 after; `OpenProcess` calls per start: 2 before, 1 after.
