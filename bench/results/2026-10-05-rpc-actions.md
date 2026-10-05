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
   parsing and stringifying outputs that are then cut to a preview.
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

Not measured here: the rewrite of a large streaming message every 0.5 to 5 s
by `StreamBuffer.persistMessages`, which writes the whole parts array of a
33 MiB message each time; the browser's memory with these threads open; the
native shell; Windows.
