# Journal compaction on a real 4.2 GB journal, 2026-10-18

Command, on Windows 11 (Ryzen 7 9800X3D), Bun 1.4.2 with SQLite 3.53.2, at
BelowNormal priority on 8 SMT threads, with other agents and builds sharing
the machine:

```sh
bun bench/journal-compact.ts --journal <copy of a schema 35 journal.db> --runs 3 --gap 250 --tmp <dir>
```

The source is a copy of a schema 35 journal in daily use since 2026-09 (8,191
messages, 1.6 million trace rows). The bench copies it with `VACUUM INTO` and
starts on the copy the way the core does: the start VACUUM check, the real
`Journal` (migration to schema 36), then the statistics ticks. It runs every
step of `compactionSteps` and the event retention in ticks 250 ms apart, as
the core schedules them, and starts twice more: the first start runs
`vacuumAtStart`, the second must find nothing to do. Reads are the median of
three runs. This run predates the statistics fallback of `b3fc921d`, for
SQLite builds whose `PRAGMA optimize` ignores 0x10000.

## File size

| | MiB |
| --- | ---: |
| source, and its `VACUUM INTO` copy | 4,175.7 |
| after the passes, same file | 4,176.4 |
| free pages after the passes | 1,621.8 |
| live pages after the passes | 2,554.6 |
| after the one VACUUM at the next start (60.8 s) | 2,164.3 |

The file goes from 4,175.7 to 2,164.3 MiB (-48 %). The first start after the
passes finish finds the free pages past a quarter of the file and 256 MiB,
copies the journal with `VACUUM INTO`, checks the copy, renames it in and
turns on incremental auto-vacuum; the shell says the history is compacting
meanwhile. The start after it checks in 3 ms and does nothing: later free
pages go back in idle `PRAGMA incremental_vacuum` ticks.

## Size per table

dbstat pages, indexes included; "column" is the `octet_length` sum of the
large columns (`part_blobs.data` and `preview`, `messages.parts`,
`processes.command_line`, `command_lines.text`, `events.payload`).

| table | rows before | rows after | pages before MiB | pages after MiB | column before MiB | column after MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| part_blobs | 7,730 | 22,865 | 1,864.1 | 1,451.9 | 1,855.8 | 1,425.9 |
| processes | 1,596,694 | 762,434 | 1,149.0 | 518.9 | 717.2 | 0.0 |
| events | 522,276 | 188,939 | 747.7 | 188.0 | 624.6 | 136.4 |
| messages | 8,191 | 8,191 | 393.2 | 237.5 | 387.5 | 230.6 |
| command_lines | 0 | 228,667 | 0.0 | 136.5 | 0.0 | 99.0 |
| all tables | | | 4,175.7 | 2,554.6 | | |

- `part_blobs` gains 15,135 rows, the values moved out of `messages` (mostly
  tool outputs of 4 to 32 KiB), and still shrinks by 412 MiB (22 %).
  `messages` loses 156 MiB to the move.
- `processes` loses half its rows to the prune of every thread past 2,500
  rows, and its 717 MiB of command lines become 228,667 distinct rows of
  `command_lines`, 99 MiB.
- `events` loses the `message.part` and `artifact.published` trail older than
  3 days.

## Background passes

"block" is the longest stretch inside a tick during which the event loop did
not turn.

| step | ticks | total ms | block p50 ms | block p99 ms | block max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| values of 32 KiB and more | 192 | 915 | 1.78 | 18 | 36 |
| tool outputs of 4 to 32 KiB | 2,116 | 5,597 | 0.06 | 30 | 92 |
| `part_blobs` recode | 3,483 | 18,785 | 0.08 | 25 | 1,363 |
| trace prune | 5,826 | 38,400 | 4.91 | 35 | 123 |
| command lines | 1,545 | 8,714 | 5.42 | 23 | 63 |
| incremental vacuum | 1 | 0.26 | 0.26 | 0.26 | 0.26 |
| event retention | 48,771 | 12,743 | 0.13 | 3.56 | 92 |
| statistics after the prune | 1 | 497 | 497 | 497 | 497 |

86 s of work in all, spread over 56 minutes of wall time by the 250 ms gaps.
Compression runs off the main thread (`Bun.zstdCompress`), so the main
thread only reads and writes rows: the p99 block is 35 ms or less in every
row pass. The one 1,363 ms block is the recode tick that met the journal's
largest value. The statistics after the prune are one `ANALYZE` on the main
thread, 497 ms. 6,593 ticks waited on the
WAL checkpoints, and no checkpoint ran on the main thread.

The first start on the copy, migration to schema 36 included, opened the
journal in 44 ms, then spent 383 ms in 24 statistics ticks (the longest
324 ms). After the VACUUM, the journal opens in 8.6 ms with no statistics
tick. Peak RSS of the bench was 1,536 MiB, held by the full reads below.

## Reads of the five largest threads

Median of three runs, in ms. "previews" is `listMessagePage` with
`limit: MESSAGE_PAGE` (120) and `toolPreviews`, the page the app asks for;
"page" is the same without `toolPreviews`; "full" is `listMessages`, every
message hydrated. "after" is after the passes, "vacuumed" after the start
VACUUM. The messages read back are the same at each stage (one digest per
thread).

| thread | messages | MiB | previews before | previews after | previews vacuumed | page before | page after | page vacuumed | full before | full after | full vacuumed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 271 | 259.9 | 110 | 92 | 114 | 90 | 252 | 182 | 292 | 2,276 | 617 |
| 2 | 406 | 148.4 | 80 | 93 | 67 | 48 | 133 | 97 | 143 | 459 | 504 |
| 3 | 230 | 132.1 | 166 | 116 | 91 | 147 | 295 | 322 | 186 | 323 | 313 |
| 4 | 8 | 54.1 | 70 | 36 | 6 | 58 | 139 | 163 | 50 | 112 | 129 |
| 5 | 78 | 40.6 | 64 | 63 | 95 | 41 | 205 | 127 | 43 | 70 | 123 |

The app's page reads a compressed output's `preview` column and decompresses
nothing: it stays between 6 and 116 ms after the VACUUM, within the noise of
this loaded machine. The page without previews and the full read decompress
every value they return, and pay for it: 2 to 3 times slower on these
threads, up to 617 ms for the full read of a 260 MiB thread. Only a client
that asks for full tool parts (no `compactTools`) reads that way; the app's
thread view does not.
