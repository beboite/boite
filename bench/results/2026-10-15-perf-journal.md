# Streaming writes beside the message row, 2026-10-15

Measured on the Linux container (Ryzen 7 5825U host, Bun 1.4.2), base
`origin/main` at `3e535df3` and the `boite/perf-journal` branch, run back to
back, three runs each, medians below. The same bench file ran on both sides.

```sh
nice -n 10 bun bench/streaming-load.ts 128 32
```

WAL autocheckpoint is off in the bench, so `walMiB` counts every byte a run
wrote to the WAL. `wide-row` streams 60 s of text (120 writes, one every
500 ms on a simulated clock, 100 characters each) into one message that already
holds 100 tool parts of 8 KB, an 803 KiB row.

| scenario | measure | base | branch |
| --- | --- | ---: | ---: |
| wide-row | WAL written | 95.69 MiB | 4.19 MiB |
| wide-row | write p50 | 4.48 ms | 0.18 ms |
| wide-row | write max | 50.4 ms | 7.8 ms |
| stream-only | WAL written | 32.37 MiB | 32.78 MiB |
| stream-only | final write | 755 ms | 641 ms |
| stream-and-read-one | WAL written | 32.37 MiB | 32.78 MiB |
| stream-and-read-one | final write | 1,054 ms | 588 ms |

On the branch, the wide row is written whole twice (at 30 s and 60 s); those
two writes are the maximum and most of the 4.19 MiB. The other 118 writes each
store only the growing text part in `streaming_parts`.

`stream-only` and `stream-and-read-one` grow a single 256 KiB text part per
stream, so the changed part is the whole message and the WAL volume stays the
same. Their final-write times vary by 2x between runs on both sides and show no
reliable difference. The branch's starting RSS is about 22 MiB higher in these
two scenarios because a message keeps its stored part JSON from `putMessage`
on, where the base keeps it from the first timed write, 500 ms later; both
hold the same strings while a message streams.

# WAL checkpoints in a Worker, 2026-10-15

Base `3e535df3`, part 1 `3e0aabab` (streaming parts, still SQLite's automatic
checkpoint) and the branch with the checkpoint Worker, run back to back, three
runs each, medians below. The same bench file ran on every side. This
container's disk is shared with other jobs: a 1 MiB write takes 25 to 90 ms
here, and the spread between runs is wide.

```sh
nice -n 10 bun bench/wal-checkpoints.ts 16 60 500
nice -n 10 bun bench/wal-checkpoints.ts 16 200 25
```

Sixteen streams each grow a 64 KiB text part by 1 KiB per round, and each round
flushes and writes them, timed on the event loop. 500 ms is the core's persist
cadence; 25 ms is a stress run, about 40 MiB/s of WAL.

| cadence | measure | base | part 1 | branch |
| --- | --- | ---: | ---: | ---: |
| 500 ms | write p50 | 36.7 ms | 33.5 ms | 28.1 ms |
| 500 ms | write max | 253 ms | 240 ms | 124 ms |
| 500 ms | WAL at the end | 5.9 MiB | 5.8 MiB | 4.0 MiB |
| 500 ms | checkpoints (Worker / main thread) | n/a | n/a | 16 / 0 |
| 25 ms | write max | 447 ms | 339 ms | 278 ms |
| 25 ms | WAL at the end | 7.9 MiB | 7.9 MiB | 24.9 MiB |
| 25 ms | checkpoints (Worker / main thread) | n/a | n/a | 18 / 17 |

At the 25 ms stress cadence, writes land during every Worker pass, so the WAL
never restarts by itself; once it passes 16 MiB the main thread copies what the
Worker left, and the WAL stays between 4 and 33 MiB over the three runs.
Without that catch-up the same run ended with a 527 MiB WAL.

# Statement cache and IN lists, 2026-10-15

`bench/rpc-actions.ts --runs 6` with a preload that wraps
`Database.prototype.query` and mirrors Bun's LRU (same eviction, same size) to
count misses, each of which prepares the SQL again. Three runs each.

| measure | base | branch |
| --- | ---: | ---: |
| `query` calls | 2,526 | 2,570 |
| distinct SQL strings | 103 | 107 |
| misses (prepares) | 284 | 107 |

On the branch every distinct statement is prepared once. The `json_each` lists
(`listTurnsFor`, agents `find` and `withStatus`) keep their index searches:
`EXPLAIN QUERY PLAN` shows the same `SEARCH ... USING INDEX` before and after,
plus a `LIST SUBQUERY` over `json_each`.

# Large bound values, 2026-10-15

A statement from `db.query` keeps the values of its last run alive. RSS after
GC, three runs each:

| probe | cached statement | prepared and finalized |
| --- | ---: | ---: |
| bind a 20 MB string three times, drop it (raw `bun:sqlite`) | +21.1 MiB | +1.2 MiB |
| `putMessage` of three 20 MB messages, drop them (part 1 vs branch) | +22.1 MiB | +1.8 MiB |

The branch runs a write that binds more than 64 KiB on a statement finalized
after use (`journal/statements.ts`).
