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
