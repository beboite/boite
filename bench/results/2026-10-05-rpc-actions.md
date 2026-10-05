# RPC actions on a production-sized journal

Measured on 2026-10-05 with Bun 1.4.2 on Linux x86-64, at `7d762e4e`, with
`bench/rpc-actions.ts`. The machine was shared with other workloads (load
average 15 to 23 on 16 threads), so wall times are noisy; core CPU per call
and response size are the steadier columns. CPU comes from `/proc` at 10 ms
resolution and is averaged over the runs of a row. No provider login or paid
turn is used: turns run on the scripted echo driver.

```sh
bun bench/rpc-actions.ts --runs 8                               # empty core
bun bench/rpc-actions.ts --journal <journal.db> --runs 6        # copy of a real journal
```

The second run used a copy of a 1.7 GB journal from a working installation:
215 threads, 2,675 messages, 959 turns and 190,660 events. The three heaviest
unarchived threads hold 115, 41 and 21 MiB of message JSON.

## Where the journal's bytes are

| Table or part | Size | Rows | Note |
| --- | ---: | ---: | --- |
| `events` | 891 MiB | 190,660 | 577 MiB are `message.part` payloads, 237 MiB `artifact.published` |
| `messages` | 726 MiB | 2,675 | p50 1.9 KB, p90 632 KB, p99 5.2 MB, largest 33.5 MiB |
| `Read` tool outputs | 203 MiB | 1,222 parts | screenshots read back as base64 PNG inside `output` |
| `Bash` tool outputs | 202 MiB | 43,367 parts | |
| File parts (video, PNG, GIF, other) | 236 MiB | 292 parts | base64 inline in the message row |

The largest message is one assistant turn with 587 parts: 93 screenshot reads
make 32.9 of its 33.5 MiB.

## Actions that cost nothing worth fixing

Medians, real journal copy. On the empty core every one of them has a median
under 16 ms.

| Action | Median | Core CPU | Response |
| --- | ---: | ---: | ---: |
| Boot burst, 10 calls together | 5.6 ms | 10.0 ms | 27.0 KiB |
| `threads.list` | 2.3 ms | 1.7 ms | 19.0 KiB |
| `threads.deleted` | 6.9 ms | 6.7 ms | 138.6 KiB |
| `usage.get` (all threads) | 7.7 ms | 8.3 ms | 25.3 KiB |
| `usage.history`, 30 or 365 days | 14 ms | 13 to 17 ms | 10 to 15 KiB |
| `trace.get`, `todos.list`, `collaboration.get`, `files.list`, heavy thread | under 3 ms | under 7 ms | under 150 KiB |
| `threads.pin`, `threads.markRead`, `settings.set` | under 6 ms | under 4 ms | about 1 KiB |
| `threads.archive` and back, heavy thread | 21 to 76 ms | 20 to 50 ms | about 1 KiB |
| Echo turn, 1,200 characters, start to `turn.finished` | 638 ms | 75 ms | |

The echo turn's wall time is the driver's own 5 ms pacing per chunk.

The existing offline benches, run the same day, match the 2026-09-29 audit:
128 streams in 451 ms CPU, 8 teams in 155 ms CPU, 64 live roots in 1,339 ms CPU
over 100 forced ticks, idle core at 0.87% of one core and 53 MiB,
`threads.retitle` on 5,000 messages in 0.93 ms, `agents.snapshot` at 2,000
steps in 9.4 ms and 121 KB.

## Actions that grow with the thread

| Action | Thread | Median | Core CPU | Response | RSS after |
| --- | --- | ---: | ---: | ---: | ---: |
| `threads.get`, UI options, 40 messages | 115 MiB | 328 ms | 368 ms | 23.8 KiB | 486 MiB |
| `threads.get`, UI options, 40 messages | 41 MiB | 353 ms | 448 ms | 624 KiB | 173 MiB |
| `threads.get`, UI options, 40 messages | 21 MiB | 304 ms | 302 ms | 583 KiB | 381 MiB |
| `messages.list`, UI options | 115 MiB | fails | | | |
| `messages.list`, UI options | 41 MiB | 310 ms | 332 ms | 4.6 MiB | 169 MiB |
| `threads.get`, no options | 21 MiB | 460 ms | 455 ms | 9.5 MiB | 136 MiB |
| `delegation.get` | 115 MiB | 905 ms | 847 ms | 76 KiB | 180 MiB |
| `delegation.get` | 41 MiB | 313 ms | 320 ms | 0.3 KiB | 125 MiB |
| `threads.fork` from the middle | 115 MiB | 9,462 ms | 6,340 ms | 0.9 KiB | 931 MiB |
| `threads.fork` from the middle | 41 MiB | 2,681 ms | 2,190 ms | 0.9 KiB | 368 MiB |
| Core start to ready line | empty | 509 ms | 320 ms | | 51 MiB |
| Core start to ready line | 1.7 GB copy | 663 to 6,477 ms | 480 to 1,280 ms | | 74 MiB |

Peak RSS over the run reached 1,032 MiB, against 62 MiB on the empty core.
The core is one event loop, so each of these milliseconds also delays every
other client's stream and request.

## Causes, in order of impact

1. Pages are sized before compaction. `listMessagePage` and
   `listMessagesForward` parse each row, `JSON.stringify` the complete message
   to count its bytes, and refuse any message of 16 MiB or more, before
   `previewToolOutputs` and `compactAttachments` shrink it. The chat always
   asks for compacted pages, so on the 115 MiB thread it opens on one message
   and `messages.list` fails on the 33.5 MiB one: the history above it cannot
   be reached. On the other heavy threads most of the 300 to 450 ms per page is
   parsing and stringifying outputs that are then cut to a preview. Fixed on
   `main` by #335; this branch reads only a preview of large tool outputs.
2. `delegation.get` parses the whole thread. `nativeAgents` runs
   `json_each` over every part of every assistant message to find Agent and
   Task tool calls. `AgentDock` calls it on each thread open and on each
   `delegation.changed`. A table of native agent calls, or a column written
   with the part, would make it an index lookup.
3. Screenshots are stored as base64 text. A `Read` of an image keeps the
   whole PNG in the tool output, in the message row and again in the
   `message.part` event. Published artifacts are stored in both the message
   and the `artifact.published` event. Moving image outputs and file parts to
   the attachment store, with a reference in the part, would remove most of the
   726 MiB of messages and the 237 MiB of artifact events.
4. Events duplicate message content. Apart from `openAsyncQuestions` and
   `readMemoryEvents`, nothing reads them back, yet each tool update writes
   its full part. Recording the part's index and status, without its output,
   would shrink the 577 MiB of `message.part` payloads to a few MiB.
5. Startup scans all events. `openAsyncQuestions` filters on `type`, which
   no index covers, so every start reads the whole table: 457 ms with a warm
   cache, and seconds when the file is not cached. `readMemoryEvents` walks all
   15,867 events of the largest thread (163 MiB, archived) for each
   `threads.get` (31 ms). Partial
   indexes on `(thread_id, id)` for `question.asked`/`question.answered` and
   for `thread.memory` cover both.
6. `threads.fork` copies in JavaScript. It loads, clones and rewrites every
   message synchronously: 6.3 s of CPU and 931 MiB on the 115 MiB thread. An
   `INSERT INTO messages SELECT` with new ids would copy the JSON as text.

The rewrite of a large streaming message was measured afterwards, below.

## After the fixes

Same day, same command with `--journal`, on `main` at `493bf2d2` (which
already sizes pages after compaction, #335) and on this branch. "First start"
is a core opening the journal copy for the first time: its startup includes
the schema 31 migration. "Settled" adds `--settle`: the migration and the move
of every large inline value run before the core starts, the state a core
reaches a few minutes after its first start. Load average 13 to 18.

| Action | Thread | main | first start | settled |
| --- | --- | ---: | ---: | ---: |
| Core start to ready line | 1.7 GB copy | 1,939 ms | 7,881 ms | 380 ms |
| `delegation.get` | 115 MiB | 1,051 ms | 473 ms | 30 ms |
| `delegation.get` | 41 MiB | 296 ms | 62 ms | 22 ms |
| `delegation.get` | 21 MiB | 176 ms | 36 ms | 5 ms |
| `threads.get` reconnect tail (`after`) | 115 MiB | 20 ms | 4 ms | 3 ms |
| `threads.get` reconnect tail (`after`) | 41 MiB | 44 ms | 4 ms | 3 ms |
| `threads.get`, UI options, 40 messages | 115 MiB | 737 ms | 635 ms | 459 ms |
| `threads.get`, UI options, 40 messages | 41 MiB | 259 ms | 258 ms | 146 ms |
| `threads.get`, UI options, 40 messages | 21 MiB | 241 ms | 199 ms | 110 ms |
| `threads.fork` from the middle, core CPU | 115 MiB | 5,160 ms | 4,110 ms | 3,020 ms |
| `threads.fork` from the middle, RSS after | 115 MiB | 913 MiB | 111 MiB | 155 MiB |
| Peak core RSS over the run | | 1,023 MiB | 594 MiB | 370 MiB |

Medians of 6 calls, except fork (one call). The first start runs the
migration once: it fills `native_agent_messages` from every stored part and
builds the partial event indexes. On this journal it took 4.5 s when timed
alone. Moving the large inline values of 919 rows took 29.7 s in total. The
slowest row, the 33.5 MiB message, held the event loop for 2.1 s once; the
core moves one row per 250 ms tick and waits while any message streams.

The chat's 40-message page on the 115 MiB thread still answers 10.4 MiB in
459 ms: it carries assistant videos and pictures inline, which
`compactFiles` keeps on purpose. Fork wall time stays between 0.7 and 6.4 s:
copying 115 MiB of values on this shared disk dominates it.

A streaming message holding 93 finished screenshot reads (33 MiB) while text
streamed for 20 s, `Journal` alone, 2026-10-05:

| | before | after |
| --- | ---: | ---: |
| Message writes in 20 s | 5 | 30 |
| Time inside those writes | 3,838 ms | 396 ms |
| Process CPU | 2,509 ms | 853 ms |

Before, each write took about 770 ms of event loop and the adaptive delay grew
to its 5 s ceiling; after, the screenshots are written once and every later
write stores the text part alone. A small message took 476 to 510 ms of CPU
for the same 20 s.

Not measured: the browser's memory with these threads open, the native shell
and Windows.
