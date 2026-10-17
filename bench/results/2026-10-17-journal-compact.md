# Journal compaction on a real 4.2 GB journal, 2026-10-17

Command, on Windows 11 (Ryzen 7 9800X3D), Bun 1.4.2 with SQLite 3.53.2, at
BelowNormal priority on 8 SMT threads, with other agents, OBS and webviews
holding the machine at about 73 % CPU:

```sh
bun bench/journal-compact.ts --journal <copy of a schema 35 journal.db> --runs 3 --tmp <dir>
```

The source is a copy of a schema 35 journal in daily use since 2026-09 (8,191
messages, 1.6 million trace rows). The bench copies it with `VACUUM INTO`,
opens the copy with the real `Journal` (migration to schema 36), runs every
step of `compactionSteps` and `pruneEventsOnce` to completion in a loop with
no pause between ticks, then copies the result with `VACUUM INTO` again. The
numbers below are from the second full run on the final code; the first run,
before the trace prune and the command line cleanup were split into bounded
ticks, gave the same sizes.

## File size

| | MiB |
| --- | ---: |
| source, and its `VACUUM INTO` copy | 4,175.7 |
| after the passes, same file (free pages stay) | 4,176.4 |
| live pages after the passes | 2,438.6 |
| `VACUUM INTO` after the passes (51.9 s) | 2,142.7 |

The core never runs `VACUUM`: SQLite reuses the 1.7 GiB of freed pages for
later writes, so the file stops growing until history adds that much again.

## Size per table

dbstat pages, indexes included; "column" is the `octet_length` sum of the
large columns (`part_blobs.data` and `preview`, `messages.parts`,
`processes.command_line`, `events.payload`).

| table | rows before | rows after | pages before MiB | pages after MiB | column before MiB | column after MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| part_blobs | 7,730 | 22,865 | 1,864.1 | 1,451.9 | 1,855.8 | 1,425.9 |
| processes | 1,596,694 | 762,434 | 1,149.0 | 422.6 | 717.2 | 0.0 |
| events | 522,276 | 212,243 | 747.7 | 208.2 | 624.6 | 151.5 |
| messages | 8,191 | 8,191 | 393.2 | 237.5 | 387.5 | 230.6 |

- `part_blobs` gains 15,135 rows, the values moved out of `messages` (mostly
  tool outputs of 4 to 32 KiB), and still shrinks by 412 MiB (22 %).
  `messages` loses 156 MiB to the move.
- `processes` loses half its rows to the prune of every thread past 2,500
  rows, and every command line moves to `command_lines`, whose rows and
  indexes are not in the four tables above. The partial
  `processes_by_command` index costs 12.4 MiB.
- `events` loses the `message.part` and `artifact.published` trail older than
  3 days.

## Background passes

| step | ticks | total ms | longest tick ms |
| --- | ---: | ---: | ---: |
| values of 32 KiB and more (schema 31 pass) | 192 | 1,446 | 95 |
| tool outputs of 4 to 32 KiB | 161 | 9,624 | 587 |
| `part_blobs` recode | 810 | 42,955 | 2,806 |
| command lines | 793 | 57,318 | 516 |
| trace prune | 1,284 | 80,614 | 1,122 |
| unused command lines | 131 | 14,803 | 283 |
| event retention | 70 | 14,780 | 840 |

207 s of work in all. In the core the 3,371 compaction ticks run 250 ms
apart, so about 17 minutes of wall time after the first start, and the event
retention runs beside them. A recode tick reads up to 2 MiB plus the value
that crosses it, at most 6.9 MB in this journal. Before the split, one trace prune
tick deleted a whole thread at once (5,487 ms) and the unused command line
cleanup ran as one statement (10,569 ms).

Opening the copy: the first `PRAGMA optimize=0x10002` took 664 ms and
1,617 ms in the two runs, the schema 36 migration with it 1,796 ms and
9,227 ms; it builds the partial index over 1.6 million trace rows. At a later start,
`PRAGMA optimize=0x10002` takes 6 to 13 ms; the daily `PRAGMA optimize` 7 to
16 ms.

## Reads of the five largest threads

Median of three runs, in ms. "page" is `listMessagePage` with
`limit: MESSAGE_PAGE` (120), with and without `toolPreviews`; "full" is
`listMessages`, every message hydrated. The messages read back are the same
before and after (one digest per thread).

| thread | messages | MiB | page before | page after | previews before | previews after | full before | full after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 271 | 259.9 | 507 | 565 | 414 | 316 | 1,970 | 1,590 |
| 2 | 406 | 148.4 | 480 | 246 | 182 | 270 | 882 | 807 |
| 3 | 230 | 132.1 | 1,060 | 702 | 563 | 498 | 692 | 1,018 |
| 4 | 8 | 54.1 | 420 | 532 | 153 | 136 | 126 | 257 |
| 5 | 78 | 40.6 | 184 | 282 | 132 | 212 | 79 | 260 |

The first run on the same data read 732 to 586 ms (page), 223 to 172 ms
(previews) and 1,201 to 1,626 ms (full) on thread 1: on this loaded machine
the page reads move by more than the change between before and after. The
full read of the two smaller threads is slower in both runs (79 and 85 ms to
260 and 148 ms on thread 5): their values are now decompressed on read. The
previews page reads a compressed output's `preview` column and decompresses
nothing.

Peak RSS of the bench was 1,433 MiB, held by the full reads.
