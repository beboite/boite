# Performance

This guide describes bandwidth, startup and rendering mechanisms and their
bench commands. Dated reports hold measured results. A claim about speed or size needs
a fresh run of the bench that covers it, with the command and the date.

## Concurrent-agent resource use

The [2026-09-29 audit](../bench/results/2026-09-29-resources.md) records paired
Linux measurements against `606bc56d`, workload limits and remaining candidates.
Its subsystem results exclude provider memory and do not establish a whole-app
CPU or RAM reduction.

Message reads overlay current buffered parts only for the selected rows. They
leave the adaptive persistence timer alone instead of rewriting every dirty
stream. Completion, explicit persistence and shutdown still write all pending
text. Load-only thread updates patch team rows without invalidating their
history. Semantic changes coalesce per team, and the client permits one active
refresh plus one pending refresh. Navigation and client identity isolate old
responses.

Linux sampling shares parent links across threads for 500 ms. Stat lines are
reused at their capture timestamp; later samples read fresh per-PID CPU ticks.
Ordinary samples avoid each process's task directories when the global procfs
scan is available. Killing a tree still takes a fresh scan and reads task
children. Windows samples the PIDs already assigned to each job rather than
filtering the global tracked-process map. Process history has an index on
`(thread_id, started_at DESC)`.

The offline benchmarks use fresh temporary journals and no provider login:

```sh
bun bench/streaming-load.ts 128 32
bun bench/delegation-load.ts 8 16
bun bench/process-load.ts
bun bench/process-load.ts --live --roots 64 # Linux procfs; forced scan each tick
bun bench/process-load.ts --live --roots 64 --wall-clock # real clock, no sleeps
bun bench/core-idle.ts 10
```

The audit records samples, workload limits and remaining candidates, including
queue admission, WebSocket fan-out and retained tool bodies in the browser.

### MCP servers per Claude session

On 2026-10-17 a Windows machine ran 20 Claude sessions with three stdio MCP
servers in the user's config. Each session started all three: 4 processes and
64 MB private for a Blender bridge, 2 and 22 MB for an SSH bridge, 4 and
138 MB for a code search. That is about 10 processes and 220 MB per session,
for tools most sessions never called. With
[MCP servers on demand](providers.md#claudes-mcp-servers-on-demand), a session
whose servers answered once before starts none of them; it lists the same 54
tools and starts one server on the first call to it. Measured with the real
CLI 2.1.302 and the real servers against a test core:

| Run | Server processes under the CLI | Started by the core | MCP tools at `init` |
| --- | --- | --- | --- |
| Servers as configured | 3 trees | 0 | 0 (all `pending`) |
| On demand, first session | 0 | 3 | 54 (all `connected`) |
| On demand, later session | 0 | 0 | 54 (all `connected`) |

The servers are also connected when the session's `init` arrives, so their
tools are there on the first turn.

## Long threads in the journal

Measured on 2026-10-05 with `bench/rpc-actions.ts --journal` on a copy of a
1.7 GB journal ([results](../bench/results/2026-10-05-rpc-actions.md)). A turn
that reads screenshots back keeps each PNG as base64 in its tool output; one
message held 33.5 MiB. Large values now live in `part_blobs`
([architecture](architecture.md)), so a streaming message rewrites only the
parts that changed: 20 s of text on top of 93 stored screenshots spent 396 ms
in writes instead of 3,838 ms. Between whole-row writes, a streaming message
writes only its changed parts to `streaming_parts`: 60 s of text on a row of
100 tool parts wrote 4.2 MiB of WAL instead of 95.7 MiB
([results](../bench/results/2026-10-15-perf-journal.md)). WAL checkpoints run
in a Worker instead of inside whichever commit crossed 1,000 pages, and the
statement cache holds 128 statements instead of Bun's 20. `delegation.get` reads the messages that
`native_agent_messages` names instead of every part of the thread: 30 ms
instead of 1,051 ms on a 115 MiB thread. Partial indexes on the events read
back took the core's start on that journal from 1.9 s to 0.38 s once settled,
and peak core RSS over the bench from 1,023 MiB to 370 MiB. The first start
after the upgrade migrates once (7.9 s there), and the move of older inline
values held the event loop for up to 2.1 s on its largest row.

Schema 36 compresses `part_blobs` values with zstd, moves tool outputs of
4 KiB and more out of the message row, stores each process command line once
in `command_lines`, cuts every thread past 2,500 trace rows back to what it
keeps, and stops writing `message.part` and `artifact.published` events
([architecture](architecture.md)). Measured on 2026-10-18 with
`bun bench/journal-compact.ts --journal <copy> --runs 3 --gap 250` on a copy of a
4,176 MiB schema 35 journal ([results](../bench/results/2026-10-17-journal-compact.md)):
`processes` went from 1,149 to 519 MiB, `events` from 748 to 188 MiB,
`part_blobs` from 1,864 to 1,452 MiB and `messages` from 393 to 238 MiB. The
passes did 86 s of work in ticks 250 ms apart, with a p99 event loop block of
35 ms or less in every row pass and one 1.4 s block on the largest value; the
statistics after the prune ran as one 497 ms tick. The next
start found 1,622 MiB of free pages and ran the one VACUUM: 60.8 s, the file
from 4,176 to 2,164 MiB, then incremental auto-vacuum; the start after it
checked in 3 ms. The page the app reads, with tool previews, reads a
compressed output's preview column and decompresses nothing (6 to 116 ms on
the five largest threads); a full read decompresses every value and was 2 to
3 times slower, up to 617 ms on a 260 MiB thread.

A fresh session (model switch, resume after an update) carries the opening
12,000 and the latest 64,000 characters of the thread. `continuationInput`
reads only the stored parts of the rest, without their `part_blobs` values,
to count them, then reads whole the messages it keeps and the images it
sends. Files keep their reference line per thread, so a later fresh session
checks each copy with one `lstat` instead of hashing and reading it again.
On 2026-10-15, `bench/continuation.ts` took 345 ms to 29 ms with 100 tool
outputs of 1 MiB and 25 files of 1.1 MB, and 83 ms to 4.6 ms with 200 of
200 KiB ([results](../bench/results/2026-10-15-perf-runtime.md)).

Held turns cost one pass over the queue each time a turn ends anywhere. The
scheduler keeps each queued turn's parent from enqueue and reads a team's
setting once per pass, so the pass reads no thread row: on 2026-10-15
`bench/queue-admission.ts` took one pass from 46 ms to 2.0 ms at 1,024 held
turns. A team event looks for held workflow summaries only in a conversation
the core knows has one, and the delegation tick neither parses result letters,
which never expire, nor tries to deliver mail of a paused or disabled team.

### What a Claude turn leaves behind

Measured on 2026-10-15 with `bench/claude-turn-heap.ts`, a scripted turn of 20
Write calls with 1 MiB results and a 5 MiB image on a warm session
([results](../bench/results/2026-10-15-perf-drivers.md)). Once the turn ended,
the core's heap stayed 33.7 MiB above its start: the session's query loop and
its context kept the first turn, its tool outputs and the image. It now keeps
1.8 MiB. A finished call's input and output live only in the stored part, and a
late `tool_use_summary` patches that part, so a follow-up that cuts a running
turn frees the cards it closed: 26.8 MiB held during the turn, now 1.6 MiB.

### A running Codex command

A running command's card is redrawn once a second with the last 4,000
characters of its output; the completed item still carries all of it. Each
redraw is a journal write and a `message.part` frame per client. For a 6 s
command printing a line every 5 ms, `bench/codex-live-output.ts` measured 25
redraws carrying 381,400 characters before, 7 carrying 28,000 now
([results](../bench/results/2026-10-15-perf-drivers.md)).

## Concurrent agent stress

```sh
bun run test:stress
bun run bench:stress --threads 1000 --concurrency 64 --clients 12 --output stress.json
bun run bench:stress --threads 1000 --concurrency 64 --clients 0 --output stress-solo.json
```

These are offline tests on fresh temporary data directories. The benchmark
checks every streamed answer and persisted turn, workload concurrency, mass
cancellation, a reader reconnect and recovery after killing the core. It runs
both six turns at a time and the requested concurrency, bounded by the load
generator rather than scheduler quotas. Cancellation and crash scenarios start
all 1,000 long-running turns together. Mass cancellation covers both cold and
already-used threads, and verifies their stopped history after recovery. Additional readers
alternate local connections with compressed, paced remote connections.
An independent process probes HTTP health, so parsing the load generator's
WebSocket frames cannot delay the observer. Mass start/stop phases record
accepted starts and health too, including diagnostics when an RPC expires.

`test:stress` checks 24 real child processes across the scripted ACP, Codex
and pi protocols, warm reuse, simultaneous stops and recovery after agent
exits. It also opens the production UI in a hidden browser with 1,000 sidebar
threads and a 256-turn burst, checks a foreground reply and writes desktop and
phone captures. `BOITE_STRESS_ARTIFACTS` selects the capture directory.
An HTTP 503 fixture verifies that failed health checks mark both the scenario
and the overall benchmark report failed even when every agent stops normally.
The benchmark's per-PID memory reads use Linux `VmRSS` or Windows working sets.
The separate snapshot-based process tree and continuous sampler still require
Windows.
The smaller six-process regression runs in the normal core suite and starts a
fresh core so earlier tests cannot hide a race in first-use imports.

Authenticated RPC requests rotate between connections in four-millisecond
slices. At most eight handlers per connection and 64 overall can wait on
asynchronous work. Authenticated agents can occupy at most 48 of those slots,
leaving capacity for owner actions, paired clients and authentication while
agents wait for replies. Each connection retains at most 1,024 frames or 32 MiB of
text; the total stays below 4,096 frames or 64 MiB, including active requests.
A sender exceeding its limit closes with a reconnect reason. At the shared
limit, the largest queued contributor closes to leave room for other readers.
Active work keeps its capacity until completion or until its connection
closes; when only active work fills the shared byte limit, a new request is
refused. Disconnect and shutdown discard work that has not started. A
disconnect also gives back at once the slots and the byte budget of its
started requests, and aborts the `signal` their handlers get in `RpcContext`:
a handler stuck on a gone client no longer holds one of the 48 agent slots,
and a wait that serves only that caller stops. Work the handler must finish
goes on as detached: it keeps its byte budget until it really ends, and its
late end frees nothing twice. A handler that ignores its signal could
otherwise pile up, eight more for each reconnection, so detached work has caps
of its own that mirror the active ones: 48 for agents and 64 in all
(`MAX_AGENT_DETACHED`, `MAX_DETACHED`). An agent starts a request only while
fewer than 48 of its kind run detached, which keeps active and detached agent
handlers under 96 together, and any request under 128. Past a cap a new
request is refused at once, never queued, with an `Unavailable` error that
says how many requests of closed connections still run and names their
methods with counts (`browser.command x40, threads.wait x8`); the first
refusal of each episode logs an `rpc.detached-refused` warning with the same
counts. Requests are admitted again as soon as the detached work drops under
the cap. A handler that honours its signal, such as `browser.command`, leaves
the detached count as soon as its client leaves
(`packages/core/src/server/frame-queue.ts`).
The prompt and its queued status commit together before its driver starts.
The running turn and thread status share a second transaction before driver
startup. The finished
turn and final thread state also commit together; awaited driver work and
pending moves stay outside these transactions. In-process listeners stay
synchronous; network notifications wait for commit and are discarded on rollback.
Pending wakes, completed activity dismissal and stopped-child admission change
in memory only after the queued prompt commits.

Scheduler notifications publish the newest snapshot in each 16-millisecond
window. Other events go out as soon as their storage writes commit.
`scheduler.get` always reads the current state.
The core constructs one snapshot per microtask batch. Enqueue checks the new
turn; settings changes and completions reconsider the held queue. Queued
diagnostics remain ordered before start, stop and drain.
Sidebar pull-request lookups share requests for the same thread and run four
at a time per client. A manual refresh goes ahead of background lookups, so
mounting or remounting thousands of rows cannot flood the RPC connection.

Desktop and phone navigation keep the full thread model but mount only the
visible rows once a list exceeds 80 entries. Measured heights, six rows of
overscan and machine-qualified keys preserve scroll anchors as rows change.
Keyboard navigation reaches unmounted entries; search still addresses the full
model. Parent move eligibility uses one reactive index instead of scanning the
thread list for every mounted card. Closing the command palette retains its
last results for the closing animation and stops ranking until it opens again.

The [task manager](trace.md#agent-task-manager) reads cached snapshots. Its
two-second refresh does not sample processes itself. Linux TCP collection uses
one lazy Worker, outside the core event loop, while any visible client holds a
lease. Transport failure preserves that demand and retries on existing sample
ticks with bounded backoff; a missing Worker response has a two-second deadline.
Worker transport recovery starts a new observation interval.
A failed native TCP dump displays unavailable. If the next valid dump has the
same socket and process identities, its actual counter delta spans the elapsed
interval since the last valid reading.
Linux load samples share the registered-root ownership index until a process
is added or removed. A missing sample discards its detailed resource baseline,
so a returning process starts a new interval.

Merged-PR archive maintenance inspects at most 128 thread rowids per pass and
admits at most eight proof lookups. Its cursor advances over blocked roots,
with a fixed end rowid per cycle so new rows and replacements cannot keep the
scan chasing the tail. Initial SQLite column checks avoid hydrating unrelated
history; selection yields every eight rows and shares a scheduler snapshot only
within that synchronous group. Family, input, result and checkout guards remain
fresh after asynchronous validation and immediately before the archive write.
Large retained families and unindexed branch-holder checks can still cost more.
Proofs share one `git remote -v` and one page of PRs per repository with the
sidebar badges, and a thread without a merged PR waits 5 minutes, then up to
an hour, before its next proof. Four unmerged worktree threads cost 2 processes
on the first pass and none on the next ones, against 12 and then 8 a minute
before ([bench/results/2026-10-15-perf-git.md](../bench/results/2026-10-15-perf-git.md)).
Those counts hold for a repository with fewer than 100 PRs, whose page is
complete. On a full page, a thread whose branch the page does not show also
walks its checkout's status and reads its branch alone before a proof.

Short git reads (30 seconds or less) share eight slots per core; a read waits
for a free one before its git starts, and the wait does not count against its
deadline. The Changes panel sends the rename origin its list gave, so
`git.diff` runs one `git cat-file --batch -z` instead of a status walk and
three gits: 24.2 to 5.9 ms on a 500-file repository. `worktrees.list`
describes four worktrees at once and resolves only the threads of the project
and of its folders: 50 worktrees list in 279 ms instead of 606 ms.

The [dated stress report](../bench/results/2026-09-29-resources.md#stress-measurements-2026-09-29-and-2026-09-30)
preserves the Windows Bun 1.4.2 runs, tables and failed 1,000-start attempts from
2026-09-29 and 2026-09-30. These fixtures do not establish a supported real-agent
count, provider quota, native shell performance or physical-phone behavior.

## Load on press

`bun test tests/e2e/press-preload.test.ts` opens sidebar threads in a hidden
browser on the fake core with a simulated 200 ms round trip
(`?fake=1&rtt=200`), the mouse button held 120 ms, and times the release to
the thread's messages in hand, each sample on a fresh page with nothing cached.
On 2026-10-12 in the Linux container, three runs of four samples each: a plain
click had medians of 222, 230 and 232 ms, and Load on press 95,
96 and 100 ms. The Windows CI job measured medians of 225 and 92 ms the same
day. The press saved about the 120 ms it was held, up to one round trip. The fake does not delay pushed events or model payload size, and a real
core adds its own handling time to both paths.

## Naming a long conversation

`bun run bench/retitle.ts` creates 5,000 messages containing about 40 MB of text
on a temporary core and regenerates the title with the offline echo driver.
It warms up once, then reports six samples. On 2026-09-22, the median fell from
103.08 ms to 0.26 ms after replacing a full history load with a journal iterator
that stops after the first user message and nonempty assistant answer.
This measures local history lookup and title persistence, not provider latency.

## Persistent-agent history

`bun run bench/agents-snapshot.ts [steps]` gives one agent's thread a finished
turn per step (prompt and answer, a third of them routine wakes, one in six
quiet, each with its cost) and leaves a 20 KB work row of the older agent model
per step in `agent_entities`, on a temporary core. It then reads
`agents.snapshot` over RPC and looks up the agent of its thread, six samples
each after a warm-up. On 2026-10-23, at 2,000 steps, on Linux:
snapshot 1,018 bytes, median 8.15 ms, and 2.39 ms once the last answer walks
the thread's own index (below); thread lookup median 0.010 ms. The
snapshot no longer carries history: the conversation is the thread's, paged
like any thread, and the status (today's turns and spend, the last answer)
reads the turns table with SQL instead of loading the thread.

The older model measured, on 2026-09-24 at 2,000 steps, 43.0 MB and 351.78 ms
on main `11631eb` and 121 KB and 3.66 ms with a bounded snapshot of messages,
memories and work.

### Ten agents at weeks of scale

`bun run bench/agents-load.ts [turns-per-agent]` gives 10 agents 5,000 turns
each, a desk of 100 watched threads (a third with a linked pull request), 10
routines each and 20,000 rows of the older agent model, then counts the SQL
statements each step runs by wrapping `db.query`. On 2026-10-23, on this Linux
LXC, before and after the desk and status reads were batched:

| Step | Before | After |
| --- | --- | --- |
| `agents.snapshot` over RPC | 407 ms, 4,106 statements | 29 ms, 96 statements |
| One agent's own snapshot | 71 ms, 415 statements | 3.0 ms, 14 statements |
| Context block, turn that sends nothing | 7.0 ms, 298 statements | 0.8 ms, 7 statements |
| Context block, fresh session (5.7 KB) | 7.8 ms, 296 statements | 2.0 ms, 9 statements |
| Stall check, every 10 s | 13.5 ms, 1,000 statements | 0.13 ms, 1 statement |
| `turn.finished` of a thread in an entrusted project | 3.4 ms, 35 statements | 1.1 ms, 15 statements |
| Idle core with 10 agents | 86 statements/s | 3.2 statements/s, as with none |

The snapshot stays 353 KB at this scale: every agent's desk rides in it. The
batching: a desk's threads are one `listThreadsIn`, their linked pull requests
one `settings` read, the stall check one read of the threads at work, the
context block reads the desk only when it goes out, the last answer walks
`turns_by_thread` (SQLite picked `turns_by_status` and read every done turn of
every thread, 31 ms per agent), today's sums go through `turns_by_thread_queue`
and are kept per thread until a turn or row of that thread changes.
`agents.changed` goes out once a second while an agent works (6 in 6.1 s of 20
parts a second). The 500 ms agents tick costs 5 µs and no statement when
nothing is due.

## Local and remote connections

The core decides per connection. A WebSocket whose `Host` header is
`127.0.0.1`, `localhost` or `::1` is the shell or a browser on the same
machine: frames are uncompressed and deltas leave immediately. Other `Host`
values enable compression and delta batching.

- Every frame is deflated. Bun runs permessage-deflate without context
  takeover, which takes a 30 KB JSON answer to 1.6 KB. The mode with a shared
  context was measured too and rejected: on Bun 1.4.2 it shrinks small frames
  ten times but only Huffman-codes a large one, 30 KB to 20.9 KB.
- `message.delta` events are held for 80 ms and joined per message part. A
  small deflated frame keeps about 84 % of its size, so fewer and larger frames
  are what saves bytes while text streams. Held deltas always leave before any
  other event and before any response, so the order on the wire stays the order
  of the turn.

The core checks each complete RPC response against 16 MiB of serialized UTF-8,
including its envelope, caller ID, turns, memory notices and other metadata.
An oversized result or error becomes a bounded `Refused` response with
`field: response`, the measured bytes and the limit, matched to the request.
The connection remains usable. A very large caller ID may require a smaller
matched refusal or a 1009 close when even that refusal cannot fit. A successful
response is serialized once; paced deltas still flush before it.

Each connection admits a frame only when Bun's `getBufferedAmount()` plus
that frame's serialized UTF-8 size fits within 32 MiB. Events also obey the
16 MiB frame limit; oversized events close with 1009. A socket whose last
`threads.get` with `open` asked for `compactTools` or `compactToolParts`
receives each finished tool call's `message.part` the way its pages carry it,
so a call that ends with a 30 MB output or Write reaches it as a preview
instead of closing it. With `compactFiles` or `compactImages`, the files and
large pictures of a live `message.started` (a prompt, an artifact) and of a
`message.part` are deferred the same way. A picture goes without its blur,
which is queued for the next page. A remote window opened this way received
4,273 bytes for a prompt with a 1 MiB picture, against 1,057,351 before
(`bun bench/fanout.ts`, 2026-10-15). A broadcast serializes each event once
per projection rather than once per socket: a 1 MiB tool output took 9.1 ms
to emit to four local sockets, against 19.0 ms before. A backed-up socket
closes with reconnectable 1013 after 10 seconds without draining, or before
a frame would exceed the byte budget. Further sends are ignored and timers
and pending parts are cleared. This closes only that client; the journal and
other connections continue. Reconnecting clients load a fresh thread snapshot.
The server's `backpressureLimit` is set to the same 32 MiB, so Bun never drops
a frame (its default is 16 MiB) below the budget the code enforces.

A relayed socket (`/group/relay/<core id>/rpc`) keeps the same budget: past
32 MiB unread, a dropped send or 10 seconds without a drain, it closes with
1013. It is deflated when its Host is not loopback, as a direct remote socket
is. `terminal.output` goes only to the connections that attached that shell
with `terminals.open` or `accounts.loginTerminal`; `terminal.exited` still
reaches every owner window.

When a socket backs up (Bun's `send` returns -1), subsequent frames stay queued
within these limits except `message.delta`, which is dropped. Catch-up tracks
at most 1,024 distinct parts and 16 MiB of UTF-8 keys before closing with 1013.
Pacing flushes at 1,024 parts or 16 MiB of serialized held frames, preserving
wire order without an additional transport queue. Text merged into a held
delta counts as 6 bytes per UTF-16 unit until that bound could cross 16 MiB;
only then is what is held serialized and counted exactly. On `drain` the core resends the text
parts those deltas belonged to, one `message.part` each, and nothing else: a
finished tool output in the same message never goes out twice. Deltas the bus
still holds are dispatched before that resend, so they fold into the part
instead of arriving after it as a second copy.

A request frame may carry `progress: true`. A response between 64 KiB and
16 MiB then leaves as chunk frames, each `\u001e{"id","bytes","total"}`, a
newline and a slice of the JSON, cut between UTF-16 surrogate pairs. The client
joins the slices and reports `bytes` against `total`, the core's own count of
the whole response. Slices go out as the socket drains, at most 1 MiB buffered
ahead, and every frame written meanwhile queues behind the last slice, counted
in the 32 MiB budget, so the order on the wire is unchanged. Bun's `send`
returned 0 (dropped) for a 31 MB frame with 29.8 MB already buffered on
2026-10-05; slicing keeps a long answer off that path. A slice resets the
call's 120 s timeout. The UI asks for progress on a first open's `threads.get`
when the core advertises `chunkedAnswers`.

## What the UI asks for

- Returning to a recent thread selects its cached history synchronously. The
  subscription, unread acknowledgement and fresh snapshot run in the background.
  Unchanged messages and turns keep their identities through revalidation.
  The cache retains up to 16 visits, at most 4 MiB of text per thread and
  16 MiB in total, with a 2,000-message bound per thread. A leave counts the
  thread it leaves and keeps that size beside the entry, so it never measures
  the other visits again (`ReadingCache` in `reading-cache.ts`). Once the page
  is idle, a plain copy replaces the deep `$state` proxy the timeline drew,
  which weighed several times its data.
- A summary written over the open thread (`thread.updated`, a load tick)
  writes only the fields that changed (`patchFields`), so a tick that moves
  `load` alone wakes only what reads `load`.
- Cores advertising `threadSnapshots` receive one `threads.get` for an open.
  Its receipt includes pending cards, subscribes this socket, replaces the
  previous subscription and acknowledges unread content after a successful read.
  Older cores keep the four-call burst for subscription, snapshot and cards.
- A first visit requests 40 messages within 128 KiB (`maxBytes`,
  `INITIAL_PAGE_BYTES`), about one desktop screen, then pages by 120 within
  256 KiB (`READING_PAGE_BYTES`) as the reader scrolls either way. A list too
  short to scroll asks for the page beside it at once, again after each one
  lands, until it reaches 400 px past the viewport or the thread is whole
  (`fillShort` in `lib/reading-window.ts`). A hidden list, with no height,
  waits until it is shown. Once a page above has landed and
  the window is drawn, the row that was first is put back where it stood on
  screen: counting the new rows at their estimates had moved the text being
  read by 850 px at 1280x900 (`pullOlder`). A cached visit allows up to 200
  messages to catch up before falling back to a page. These limits affect the
  displayed window; the journal retains the history.
- Every page a core with `messagePositions` sends says where its first message
  sits (`messageOffset`, `offset`), and the store keeps each held message's
  position (`lib/store/message-positions.svelte.ts`). The timeline then sizes
  every stretch it does not hold as one row worth 80 px per missing message,
  so the scrollbar spans the whole thread from the first 40 messages on and a
  drag to the top lands on the first one. A frame after the view moves, the
  stretch within a screen of it is read with `messages.list`, 120 messages and
  256 KiB at most: `from` 0 for a drag to the top, `before` the first message
  held for a scroll up, so a page its bytes cut short keeps the messages next
  to the reader, never the pages in between. Read with `from` instead, a page
  of long answers held the far end of its range and left the reader under a
  gap that took six more pages to close. A message cut in rows weighs more
  than the 80 px its gap counted, thousands of pixels for a page of long
  answers: as the page goes in, the window is put on the row at the top of
  the view, then that row is put back where it was on screen. Without the
  first step the row left the rows drawn and the view stayed where the rows
  above had pushed it: on 2026-10-18, a wheel up a 2,571-message thread moved
  the reader 20 messages up the thread in one frame, onto the skeleton. A
  glide to the latest page asks for nothing on its way down. A core without
  positions keeps the cursor paging above (`lib/history-gaps.ts`).
- A history page sends a successful call's output only up to 256 characters
  (`TOOL_OUTPUT_FOLDED_CHARS`): its folded card draws none of it. A longer one
  arrives empty with `outputDeferred`, and opening the card fetches it. A
  message is a whole turn, and a turn of 90 commands with a few kilobytes of
  output each made pages of megabytes that nobody had opened. A failed or
  refused call's output above 16,384 characters arrives as a 1,024-character
  preview, where the opened card reads its error line while the rest loads.
  Live `message.part` events keep the 16,384 threshold, so a card open on a
  running call keeps its output when the call ends. On a core advertising
  `deferredToolParts`, pages also ask for
  `compactToolParts`: an input above 16,384 serialized characters arrives cut to
  about 4,096, its first strings and entries, with `inputDeferred`, and
  documents above 65,536 characters together arrive as stubs that keep their
  kind, path, title or caption, with `documentsDeferred`. A Write of a large
  file carries that file in its input and again in its diff. The card's line
  reads from the preview; a card with deferred documents stays folded and shows
  its document chip. Opening it retrieves the whole call with
  `messages.toolPart`, `messages.toolOutput` on older cores. A proposed plan
  whose input was cut is completed as soon as it is drawn. Running tools remain
  complete. Older cores that ignore the preview options still return full
  content; disclosures fall back to their existing history methods if needed.
  An expanded output refreshes after compact revalidation: matching preview
  prefixes cannot prove that the omitted text stayed unchanged.
- File links arrive with their name, MIME type and decoded byte count. Their
  base64 data loads through `messages.attachment` when opened or downloaded.
  Video and audio players ask for a file ticket within 400 px of the screen;
  the browser fetches their metadata and streams their bytes over HTTP, outside
  the thread's JSON frames. Older cores and desktop relay connections fall back
  to a separate base64 read. An assistant's PDF keeps its bytes for signature
  checking before preview. An assistant's picture above 8 KiB is deferred like
  a prompt's, with its size and blur, and `ChatFile` loads it within 400 px of
  the screen in a box of its proportions. Nine screenshots an agent attached made a 40-message
  page of one thread weigh 12,020,008 bytes, 7,472,667 deflated (measured on
  2026-10-07). The same page projected this way weighs 50,961 bytes, 13,679
  deflated.
  Older cores return full files, and a cached deferred file can fall back to
  their history methods after a downgrade.
- On a core advertising `readingPages`, pages ask for `compactImages`: a
  picture above 8 KiB of base64 arrives as its decoded size, and loads through
  `messages.attachment` once within 400 px of what the timeline shows. The
  observer is rooted at the scrolling timeline, whose clipping would otherwise
  hide the margin. Edit fetches a prompt's deferred files and pictures before
  it fills the composer.
- A deferred picture also carries its `width` and `height`, read from its
  header (`packages/contracts/src/image-size.ts`): PNG, GIF, WebP and JPEG, with
  JPEG's EXIF orientation applied as a browser applies it. It also carries
  `preview`, a ThumbHash blur of at most 32 px that `Bun.Image.placeholder()`
  makes, about 1.2 KB. The core makes three at a time on Bun's image worker,
  refuses pictures above 8K UHD, and keeps them in `media_previews`
  (`packages/core/src/media.ts`).
- A deferred picture on screen is drawn from a light copy:
  `messages.attachment` with `display` answers a WebP at quality 80, at most
  1,280 px on its longer side, made once on Bun's image worker and kept in
  `media_displays`. Six 1,541 to 2,467 KB PNG screenshots measured 51 to
  130 KB this way on 2026-10-07, about 130 ms each to make. A kept copy is
  read by message, part and thread before anything else, so it answers without
  loading the original's base64. AVIF would be
  smaller, but Bun's Linux build cannot encode it. A GIF, a copy that would not
  be lighter and any other file come as they are. A click opens the original
  in the viewer, and a download or an edit also fetches the original
  (`store/display-images.ts`). The client keeps 120 copies and 24 M characters
  of them at most, since a GIF or an original can weigh several MB, and drops
  them when the Store switches to another machine.
- A prompt's thumbnail asks for `thumb`, a WebP at quality 75 and at most
  320 px, made once from the kept 1,280 px copy (or the original when there is
  none) and kept in `media_displays` beside it, so it leaves with its thread.
  `ChatImage.svelte` asks for it while the box's longer side times
  `devicePixelRatio` stays within 320 px: a 16:9 tile of 88 px is 313 device
  pixels on a 2x screen and takes it, a 3x phone or a panorama takes the
  1,280 px copy. Pictures in an answer and the viewer keep the larger copy and
  the original.
- The copies the timeline draws come as `ticket` addresses on the core's
  file route rather than base64 in a JSON frame: the `<img>` loads
  `/file/<ticket>` itself, with `immutable` caching, and the same part keeps
  the same ticket while it lives, so the browser cache answers a scroll back.
  Each load renews the ticket, so it dies ten minutes after its last use; one
  that no longer loads (an expired ticket, a restarted core) is asked again
  once. An incognito conversation's tickets answer `no-store` instead, so no
  disk cache outlives it, and a copy the journal could not keep comes as
  base64, since the route would have nothing to read. The desktop shell
  through another member's relay keeps base64: its policy admits `/file/`
  only at a machine's own address. The core also answers an original by
  ticket, but the viewer, a download and an edit still fetch it as base64:
  they hand its bytes to the part.
  `bun run bench/media-wire.ts --browser` on 2026-10-17, ten 1920 by 1080
  PNG screenshots of 1.77 MB, medians of 5:

  | link | answers | down KB | ms to pictures | Chromium decode ms |
  | --- | --- | ---: | ---: | ---: |
  | loopback | base64 large copies (before) | 1,762 | 110 | 93 |
  | loopback | ticket, thumbnail copies | 86 | 19 | 12 |
  | remote, 150 ms RTT, 8 Mbit/s (`--rtt 150 --rate 1000000 --remote`) | base64 large copies (before) | 1,327 | 1,611 | 93 |
  | remote, 150 ms RTT, 8 Mbit/s | ticket, thumbnail copies | 86 | 525 | 364 |

  The remote decode column counts the fetches, one more round trip than
  base64: at 150 ms with no rate cap, ticketed thumbnails took 488 ms against
  299 ms for base64 large copies, and ticketed large copies gain no bytes over
  deflated base64 (1,325 against 1,327 KB) while taking that round trip.
- A light read queues missing blurs while projecting its messages and answers
  without waiting for image conversion. It does not scan surrounding messages
  for previews before reading the page. Cached blurs accompany later reads;
  a picture without one still reserves its dimensions while its copy loads.
- `ChatImage.svelte` draws each picture in a box of its own proportions from
  the first frame: the blur, then the picture fading in over it. A picture that
  came with its bytes reads its size from their header. Nothing around the box
  moves when the bytes land: the 180 by 120 place it replaced grew to the
  thumbnail and pushed what followed. An unmeasured prompt counts its
  thumbnails on top of the 80 px estimate (`estimateSlot`), so the spacers
  are closer to what scrolling up mounts. `tests/e2e/thread-loading.test.ts` checks
  this on a real core with 24 screenshots: the fetches on opening, and the
  reader's text keeping its position to the pixel while the scrolled pictures
  land.

- While a first page downloads, the chat shows a bar and "192 kB / 1.3 MB",
  the bytes received against the total the core put in each slice. A page
  under 64 KiB comes whole and the bar runs without numbers; it shows after
  150 ms, so a fast open does not flash it.
- A first visit with a saved reading position (an anchor message, not pinned
  to the bottom, no cached visit) asks `threads.get` for the page `around`
  that message on a `readingPages` core: 20 messages before it and 20 from
  it, when more than 40 follow it. Both halves share the 12 MiB page budget;
  larger windows drop their farthest messages while retaining the anchor
  and cursors in both directions. Each cut cursor names the retained edge;
  a single complete anchor may exceed the byte budget. The requested message
  count also applies to the combined window, including a limit of one.
  `messagesAfter` is the cursor below that
  window; `messages.list` with `after` pages down as the reader nears the
  bottom, and "Jump to latest" replaces the window with the last page. Live
  messages wait for the pages below, except a prompt, which brings the last
  page with it. Positions are kept in memory for 32 threads.
- `threads.get` takes `after`, a message the client already holds. The answer
  then starts at that message and says so in `messagesFrom`; the UI keeps what
  it had before it. With snapshot support, a SHA-256 proof covers the complete
  resume tail and its representation options, including deferred bytes.
  A matching proof sends no message bodies; metadata and turns stay fresh.
  Without this feature, a quiet reconnect still sends the last message.
  An unknown message, or a tail above the requested count or 12 MiB of
  serialized UTF-8 message data, gets a normal page without `messagesFrom`.
  A reconnect tail is complete or replaced by a page; it is never truncated.
- History pages carry at most 120 messages by default, 200 for `messages.list`,
  and 12 MiB of serialized UTF-8 message data, including JSON escaping and array
  separators, or the lower `maxBytes` the client asks for. A resume tail is
  never cut to `maxBytes`. The journal iterates its thread index and stops at the count or
  byte boundary, retaining complete messages and a gapless backwards cursor.
  Current buffered parts count toward the budget. Both budgets measure each
  message as the client receives it: with `compactTools` a finished tool's
  output counts as its 1 KiB preview, so a turn whose stored image reads total
  18 MB still opens. One complete attachment-sized message can exceed 12 MiB
  so pagination advances. With `compactToolParts`, no message is refused for
  its size: one still above 8 MiB once compacted (`MESSAGE_SENT_MAX_BYTES`)
  has every finished call and image it holds deferred whatever their size, then
  its longest texts cut, each with the count of characters it lost in
  `omitted`, which the chat states under the text. Without that option, a
  message or complete RPC response above 16 MiB as sent is refused explicitly
  rather than losing content. Internal reads of the journal (a fork's boundary,
  a memory notice's anchor) send nothing and are neither measured nor refused.
  The size check walks a message and stops early; only a message holding more
  than about 1.3 MiB of content is serialized to be counted.
  Turns, thread metadata and memory events also occupy that RPC response budget.
- On a reconnect, the open thread's `threads.get` leaves before the boot lists,
  so the missed text does not wait for the slowest of them. The fresh
  `threads.list` is laid over the rows already held: a row keeps its object and
  only the fields that changed are written, so the sidebar redraws the rows that
  moved and no others. A `thread.load` sample patches the row's `load` alone,
  about 4x fewer bytes than the whole row an older client still gets.
- A reconnect to the same running core reads only the sidebar rows that changed
  while the socket was down (`threads.listChanges`, `features.listChanges`).
  The core counts every committed `thread.created`, `thread.updated` and
  `thread.removed` in a log of the last 4096 thread ids
  (`LIST_CHANGES_IDS`, `packages/contracts/src/list-changes.ts`), under a run id
  minted at each start. The client keeps the cursor of its last applied list and
  sends it back; the answer holds the unarchived threads changed since, every
  thread with live processes, with its load, and the ids deleted or archived
  since. A held row left out keeps its fields and loses its load. The first
  connection, a core restart (another run), a cursor older than the log, a new
  client and an older core without the method all read the whole list as
  before, an older core with no error shown. The delta is what a client that
  stayed connected heard: a summary the core changed without its event is not
  repaired by a reconnect. 2000 idle rows plus one pinned while away, UI test
  `store-reconnect-list.test.ts` (2026-10-28): 1,088,237 bytes of list before,
  1,320 bytes after. The core test `thread-list-changes.test.ts` measures the
  same over the real journal with 2001 threads: 1,627,666 bytes whole, 869
  after.
  The other boot reads stay whole: the projects list is about 15 rows and is
  recomputed from git and archived counts that no event announces, and the
  pending cards, secrets and settings are small.
- A streamed delta, part or turn looks up its message or turn from the end of
  the loaded timeline, where the item being written sits.
- The trace is read when the trace surface is on screen, not on every open.
  `process.started` and `process.exited`, about 180 a second under sixteen
  agents, are dropped until it is, and the list keeps the newest
  `TRACE_LIMIT` (200) rows, what `trace.get` returns. The old handler copied a
  list that only grew: 0.6 ms a start and exit after 10 minutes, 11 ms after
  an hour, past a core at that rate (plain arrays in Bun, 2026-10-17).
- Sidebar cards ask for their pull request when they mount or change branch,
  then on one timer per connection: every 15 seconds while the thread works,
  every 60 seconds at rest, above the core's 15-second cache of a repository's
  list, so a round of idle cards runs `gh` at most once per repository. A
  hidden page skips its rounds; back in view, it runs one if a round is due.
  The rounds skip a merged pull request; a mount, a reconnect, a status change
  and Refresh PR still ask, so a new PR on the same branch shows when the turn
  ends (`watchPullRequests` in `pull-request.ts`).
- An open Done or Archived fold reads the archive again only when a project's
  archive count, the listed projects or a connection change, not when a prompt
  re-sorts the list, and keeps its rows on screen while it reads.
- The sidebar sorts each project's rows once, for its section and for
  Alt+1 to Alt+9, and a change in one project sorts that project alone.
- A process exit updates five columns of its trace row instead of rewriting it,
  and a thread keeps its newest 2,000 rows (`bun bench/process-rows.ts`).
- A spawn of a bare name (`gh`, git when its lookup found no real binary)
  reuses the remembered PATH lookup (`bun bench/spawn-lookup.ts`).
- On Windows new processes inside 100 ms share one audio-session walk, and
  the jobs Worker drops the global job's copy of every start and exit. A new
  audio session is reported by Core Audio, so with no traced session the walk
  runs every 30 seconds instead of every second
  ([the audio mute](trace.md#the-audio-mute), `bun bench/guard-cpu.ts`).
- A project names its icon by version or stack id only. The image, up to
  256 KB, is a `projects.icon` call made once per project and version, when a
  tile first draws it; a list never carries it ([project icons](project-icons.md)).

The timeline renders a window above 24 messages, with four extra messages on
either side when reading history and two above the live end. It starts at
the saved message and offset, or the latest message,
using the previous viewport height and row measurements. Historical messages
skip entrance animations. File summaries are computed for visible turns only.
Phone navigation reveals the conversation immediately after selection.

`bun bench/thread-switch.ts --delay 300 --runs 7` measures an optimized fixture
bundle with 400 messages and delayed thread RPC replies. Use `--phone --cpu 4`
for a 390 px viewport and slower CPU, or `--ui <checkout>/packages/ui` for a
baseline checkout. `--cached 16` first reads 16 more threads of 400 messages
to the top, then reports the synchronous leave time of each click and the JS
heap after a forced collection. The [2026-10-02 measurements](../bench/results/2026-10-02-thread-switching.md)
record samples, reading-position drift and the subsequent t3code comparison.
`tests/e2e/thread-switch.test.ts` separately exercises the production UI with
a real temporary core, a 750 ms snapshot delay and a large folded tool output.

`bun run bench/thread-open.ts --runs 3` seeds a fresh data directory with a
200-message thread shaped like a real long one (1.1 MB attached files every
eighth prompt, a picture every 25th, 30 tool outputs per answer, 48.9 MB
of parts) and times `threads.get` on loopback and through a 150 ms relay, then
the click to the first message in headless Chrome, plain and throttled. `--base`
skips the parameters an older core does not take, `--rpc-only` the browser. The
[2026-10-05 report](../bench/results/2026-10-05-thread-open.md) has the numbers,
and the [2026-10-13 report](../bench/results/2026-10-13-thread-open.md) the
screen page against main: 1,305 KB to 129 KB, and 1,902 ms to 297 ms from click
to first message on a throttled link;
`tests/e2e/thread-open.test.ts` captures the bar at both widths and checks
its total against the page the core sends. `tests/e2e/thread-reopen.test.ts`
drives the rest at phone and desktop widths on a real core: a deferred picture
fetched while still above the screen, Edit of a prompt whose file stayed on
the core, and a return to a message read far up, its pages below and "Jump to
latest".

`bun bench/thread-traffic.ts --rtt 150 --mbps 2 --runs 7` compares both opening
protocols through a paced TCP relay on the same temporary core. It counts actual
compressed WebSocket bytes in each direction and cold and quiet-return RPC
latency. `--attachment-kib 0` measures text alone. The
[2026-10-03 report](../bench/results/2026-10-03-thread-traffic.md) records both
fixtures and limits. `tests/e2e/thread-loading.test.ts` checks compact first
reads, unchanged returns and byte-exact downloads in the production desktop
and paired-phone browser UI.

## Static files

The UI build writes a `.br` and a `.gz` beside every text file of 1 KB or more
(`packages/ui/vite.config.ts`). The core serves the one the browser accepts and
never compresses anything itself. A browser only offers `br` over https, so a
phone on the LAN gets the gzip.

Every static answer outside `/assets/` carries an `ETag` and a `Last-Modified` of the variant sent,
so revalidating the shell, `sw.js` or the manifest is a 304 without a body.
Fonts and icons are fresh for a day: a phone on plain http has no service
worker and would otherwise fetch the two default faces, 118 KB, on every load.
A view is gzipped once when it is published and sent compressed to a client
that reads gzip. The [2026-10-15 report](../bench/results/2026-10-15-perf-media.md)
has the bytes before and after.

The command palette, the project picker, the import dialog and the right panel
are separate chunks. They load when first asked for, and all of them once the
app has booted and the page is idle, so a PWA that goes offline later still has
them in its cache. A link that asks to save data, or reads as 3G or slower,
skips that prefetch and fetches each one when it opens (`lib/prefetch.ts`). The
tour is prefetched only for a device that has not seen it.

Settings, the Bots page with its first snapshot (behind its experiment) and,
for the owner, the terminal's xterm modules are fetched in the same idle pass.
The Bots view lives as long as its machine's store: a return visit draws the
last snapshot at once and refreshes it, and nothing follows `agents.changed`
while the page is away. `bun run bench/agents-page.ts` measures a click on
Bots until its first bot row, behind an emulated 40 ms, 4 Mbit/s
link, on a temporary core with twelve bots. On 2026-10-11 in this Linux
container, medians of five against `origin/main` at `4762402b`: first visit
164 ms before and 110 ms after, return visit 55 ms and 32 ms. The rest of a
first visit is rendering.

Day labels and clock times in an agent conversation reuse one
`Intl.DateTimeFormat` per language (`lib/format.ts`), as hover titles already
did: `toLocaleString` with a locale builds a new formatter per call.

Every catalogue and the quota window are chunks of their own too, so a page
downloads and parses only the language it speaks (`docs/language.md`). Nine
components the first frame does not draw load the same way
(`lib/deferred-parts.ts`, the terminal drawer and, outside the shell, the
phone's navigation, which the boot screen waits for): the image viewer, the
diff, the quota overview, the coordination panel, the updates notice, the
robot face and the dictation button, prefetched in the idle pass. The
dictation button draws a disabled microphone of the same size until its chunk
lands. `qrcode` loads when a code is drawn. The modules the boot shares with a
lazy chunk are one `boot` chunk (a Rolldown `codeSplitting` group in
`vite.config.ts`), because the core speaks HTTP/1.1 and a browser fetches six
files at a time. Geist Mono ships as latin, latin-ext and rest subsets with
its weight axis; its latin cut carries the arrows and box drawing a terminal
draws. The text faces (Inter, Atkinson Hyperlegible Next, Source Sans 3, IBM
Plex Sans) ship as latin and latin-ext.

A part whose chunk has not landed says it is loading, one whose chunk failed
offers a retry, and every failed part asks again when the browser is back
online (`components/Deferred.svelte`). Chromium keeps a failed `import()` for
the life of the page, so a retry that fails at once loads a fresh page when
the core answers (`lib/retry-load.ts`, `tests/e2e/chunk-retry.test.ts`). A change waiting for permission cannot
be allowed before its diff shows. When no catalogue loads at all, the page
draws a notice with a retry in place of the app (`lib/boot-failure.ts`), and
the service worker precaches the catalogue of the language the page last
spoke, so an installed phone still opens offline.

On 2026-10-18 on Windows, `bun run build:ui` of `b611c01f` and of this
change. The static rows count what `index.html` names plus the device's
catalogue, gzip at level 9 and brotli at 11:

| Measure | Before | After |
| --- | ---: | ---: |
| Entry chunk | 595,295 | 484,682 |
| UI files, excluding `.br` and `.gz` | 5,036,764 | 4,723,056 |
| Files `index.html` names, English device | 65 | 6 |
| Their raw bytes, English | 1,597,482 | 1,381,747 |
| Their gzip bytes, English | 482,282 | 405,875 |
| Their brotli bytes, English | 405,523 | 336,131 |
| Files `index.html` names, French device | 66 | 6 |
| Their raw bytes, French | 1,748,228 | 1,401,950 |
| Their gzip bytes, French | 532,196 | 411,337 |
| Their brotli bytes, French | 448,185 | 341,227 |

The page fetches more than that before it is usable. The cold boot to
`.app.ready` was measured on the same day with a real core (`tests/e2e/lib/core.ts`)
serving each build and a fresh headless Chromium profile per run, the request
graph read from the page's Resource Timing up to the frame where `.app.ready`
appears: five runs per row, medians, transferred bytes as the browser counts
them (headers included). The slow link is 150 ms of latency, 1.6 Mbit/s down
and 750 kbit/s up (`Network.emulateNetworkConditions`).

| Cold boot to ready, slow link | Before | After |
| --- | ---: | ---: |
| English: time | 3,963 ms | 3,006 ms |
| English: requests | 72 | 19 |
| English: bytes | 586,774 | 480,634 |
| French: time | 4,171 ms | 3,028 ms |
| French: requests | 73 | 19 |
| French: bytes | 629,736 | 485,730 |

Of the 19 requests after the change, 9 are scripts: the entry, the runtime,
the `boot` chunk, the catalogue, the phone navigation the boot screen waits
for outside the shell with a module it shares, the dictation button with its
recorder, and the pointer interactions; the rest are styles, the two
fonts, the manifest and the icons. The slow link's runs vary by under 260 ms.
Without throttling both builds reach ready in 148 to 547 ms on this machine,
a spread wider than any difference between them, and the idle prefetch starts
before the ready frame and adds four requests.

The service worker still asks the core for the app shell first, but waits
2.5 s at most before serving the cached one; the late answer is stored for the
next open.

## Picking a model

Claude and Codex list their models from a process of their own. Measured on
2026-10-11 in this Linux container with the real CLIs, no prompt sent: Claude
answered in 1.6 to 2.9 s and took another 0.8 to 1 s to exit, Codex 0.9 to
2.3 s and 0.1 to 0.3 s; a cached list answered in 3 to 15 ms. The picker used
to wait for that read whenever the list was more than five minutes old, so a
click on a model could hang for 2.6 to 3.7 s before it closed. A row from a
list the core already gave is now picked at once, the core keeps that list for
its checks while the fresh read runs, and the answer leaves before the process
exit ([providers](providers.md#the-models-probe)).

## Preparing the first prompt

Typing into a visible draft starts a prompt-free preparation of its final
workspace and native session. Send adopts only a completed, compatible
reservation and never waits for speculation. The new conversation subscribes
before its creation response, so its first turn can start while the UI reads
the snapshot. Model discovery coalesces requests and can reuse compatible
prepared Codex and ACP processes. Checkpoint capture overlaps native setup,
while prompt dispatch still waits for the checkpoint.

Selected attachments upload before Send. Completed references keep the first
turn request small; pending or expired uploads use the original bytes. This
moves transfer work earlier and does not reduce total network traffic.

Measured on 2026-10-13 with:

```sh
bun run bench/agent-startup.ts --offline --runs 7 --delay-ms 150 --output /tmp/agent-startup.json
```

Seven samples per group, real temporary core and RPC transport, scripted Codex
process with a 150 ms native-opening delay. Values are median / nearest-rank
p95 milliseconds; with seven samples, p95 is the observed maximum.

| Workspace and strategy | Send to acceptance | Send to first text | Send to finished |
| --- | ---: | ---: | ---: |
| Directory, cold | 11.42 / 33.54 | 201.78 / 227.72 | 205.68 / 238.17 |
| Directory, prepared | 9.48 / 12.42 | 19.46 / 23.59 | 22.77 / 26.59 |
| Sparse worktree, cold | 45.64 / 51.17 | 441.73 / 456.77 | 817.19 / 840.51 |
| Sparse worktree, prepared | 11.34 / 13.37 | 386.64 / 412.20 | 771.78 / 803.80 |

Preparation took a median 185.29 ms for directories and 221.37 ms for sparse
worktrees before Send. Each sample initialized one native process; cleanup left
zero live processes. Sparse worktree samples use disposable shared clones and
still include substantial checkpoint work. These controlled samples demonstrate
the overlap, not real-provider latency gains. Shared filesystem caches and
machine contention were not isolated; GUI, remote links and inference were not
measured.

Sending a 68-byte PNG and a 256 KiB text file reduced the serialized
`turns.start` request from 349,909 to 385 bytes. The earlier upload requests
totaled 349,916 bytes, bringing combined request bytes to 350,301. Both paths
preserved journal bytes, the native image URL and file contents. These counts
exclude compression, responses, release calls and other RPCs.

## Core startup

The entry loads the CLI for commands and the Core/server graph for server
startup. Version metadata lives in `packages/core/src/version.ts`.
The compiled launcher awaits the main module before dispatch, including with
ESM bytecode. `packages/core/test/main-entry.test.ts` checks command imports,
port refusal, the compiled binary and graceful lock release.

Activity restoration selects threads with saved activities. Coordination
recovery selects active threads and threads with potentially pending letters.
The core validates visible thread JSON once, where activity's own check ran,
so both keep the original error order, archived-thread handling and recovery
writes; each still validates when built on its own. Delegation reads child
threads and pending roots, turn recovery the queued, running and waiting
threads, and title recovery the threads with a title state, not every thread
(`bench/journal-reads.ts`).

Claude and ACP join the other native drivers behind a lazy factory. Listing
providers, capabilities or cached models does not load their protocol runtime.
The first operation shares one import; a failed import can retry. Stop, thread
release and shutdown retire pending sessions before a late factory can start a
process. `packages/core/test/lazy-driver.test.ts` covers these boundaries.

`fflate`, the unzip library behind provider installs and the local speech
runtime, is imported where it unzips. Evaluating it builds its Huffman tables,
about 8 ms per core start measured on 2026-09-25, for code most starts never
run. `packages/core/test/startup-imports.test.ts` fails if a static import
brings it back. The same test keeps `node:util` and `node:dns` out of the
static graph: terminal escapes are stripped by `packages/core/src/ansi.ts`, and
the MagicDNS lookup imports its resolver when it runs. The recommended plugin
list is parsed on the first plugins call. The compiled Linux server carries
ESM bytecode like the desktop sidecar. Measurements:
`bench/results/2026-10-15-perf-media.md`.

The core lists its providers twice before it listens (the registry loads, then
the default accounts ask which ones are available), and again for every client
that boots. Each listing looks up every candidate program on the PATH, with
every PATHEXT extension on Windows. `packages/core/src/providers/which.ts`
keeps each answer for 30 seconds, so a burst of listings scans the PATH once,
and forgets them all on a providers reload, an install or an agent update.
An `npm` candidate's script and a managed install's release record are kept
the same way: on 2026-10-15 a listing took 378 us instead of 486, and a
listing plus pi's and OpenCode's summaries 40 file syscalls instead of 95
(`bench/provider-list.ts`,
[results](../bench/results/2026-10-15-perf-drivers.md)). Focusing a thread
and preparing a draft resolve their one provider, not the list.
`packages/core/test/providers-which.test.ts` counts the lookups.

## Shell startup

The shell spawns the core before it builds the WebView2 window, and polls for
`core.json` every 10 ms instead of every 120 ms. `setup` starts the core as soon
as its state exists, before the WebView version query and the second-launch
listener; the `pre-setup` phase record times the process start to `setup`.

On Windows the main page drops to WebView2's low memory level while the window
waits in the tray, from a close or a login start, and returns to normal before
it shows. A minimized window keeps the normal level for the main page. A
hidden page the user browses drops to the low level and is suspended
([browser tabs nobody uses](#browser-tabs-nobody-uses)).

The window is built hidden. It appears once the page has painted and either the
core answered or two seconds passed, so a fast start shows no empty frame and a
slow one shows the page's "connecting" state. After ten seconds it appears
whatever the page said, so a broken bundle still gets a window to quit from.

## What a frame costs

Rendering regressions are measured with `bench/ui-frames.ts`. The current UI
limits expensive work while streaming, typing and scrolling:

- Window-wide scrims use `--color-scrim`; backdrop blur stays on bounded
  floating surfaces such as the composer, activity panel and notifications.
- Endless animations use opacity or transforms, apart from the small repainting
  boxes named in `render-cost.test.ts`; the running group's shimmer moves in 33
  steps a sweep, so it repaints 15 times a second instead of every frame. They
  pause with the window at rest, and those on screen while agents work step on
  a shared 60 Hz grid ("What the UI costs at rest"). Outer app containers avoid
  `:has()`.
- A closed fold's body skips its content once the close transition has run
  (`content-visibility: hidden`), so a group opened once no longer weighs on
  every layout of its row.
- Entrance animations run for arriving messages, rather than history remounts.
- The outline rail updates once per frame and animates transforms. Message
  heights come from `ResizeObserver`; reading anchors are captured after the
  scroll render so immediate navigation restores the same message.
- Wheel listeners are passive: they release bottom following without
  cancelling browser scrolling. `MessageList.test.ts` guards the listener
  options.
- Icon shapes and locale date formatters are reused. The Markdown regression
  suite checks malformed links on lines of 32,000 characters. Inline link
  lookahead skips unfinished labels when no closing bracket or destination
  parenthesis remains. Finished Markdown markup
  has a four-million-character cache bound, highlighted code a
  two-million-character one shared by every view of the same text. A diff
  document's rows are computed once per whitespace mode and kept with it.
- The composer uses `field-sizing: content` where supported; IndexedDB draft
  writes wait for a typing pause. Bottom following runs after layout and before
  paint through `ResizeObserver`.
- On a phone, the chat behind the thread or activity list gets
  `content-visibility: hidden` once the exits the cover started have ended
  (`--dur-whip`): a stream keeps writing to it without layout or paint, and it
  comes back at the same position. Skipped content advances no animation, so
  E2E captures wait through `settleAnimations()`, which ignores it. The "phone
  streaming behind list" scenario measures it.

### Composer synchronization

The core persists changed composer records independently of message history.
Typing coalesces over 400 ms; attachment bytes upload separately once, and
subsequent puts and broadcasts contain metadata only. Asset validation reads
stored kind, MIME type, name and byte count without loading the body. Queue
wakeups use an index of records with pending prompts, targeted by thread.

On 2026-10-27, `bun test tests/e2e/composer-persistence.test.ts
tests/e2e/chat-steering.test.ts` passed both production-UI scenarios. The first
used a real core, desktop browser and paired phone-width browser. Adding a
1 MiB file and making 100 text edits at 10 ms intervals sent one asset upload
and five composer puts containing 2,000 bytes total. None of those puts carried
attachment bytes. Scheduling can change the put count; this measures wire
payload, not network framing or a before/after latency comparison. The same
test verifies that queues drain with both browsers closed and that drafts and
consumed state survive a core restart.

### A long turn is many rows

Inline view placement keeps the same timeline array when streamed text leaves
the message order unchanged. Checking a new placement line still happens as
the answer grows, but downstream row and scroll effects do not rerun merely
because a view exists. A changed placement, turn status, or republished page
still reaches the timeline. The sidebar also uses its row index for full
thread updates, including provider progress heartbeats, as it does for load
samples.

`bun run --cwd packages/ui test src/components/MessageList.test.ts -t 'four hundred messages'`
covers 400 messages and 200 deltas both with and without an inline view. Before
the change on 2026-10-25, the view case made 400 height reads during the deltas
and failed the existing layout budget; the case without a view passed.
`src/lib/store-thread-index.test.ts` covers progress updates as well as load
samples, and `src/lib/inline-view.test.ts` checks placement changes and
replacement message objects. These checks do not measure native WebView2
frame times or establish an improvement in whole-machine CPU use.

A long agent session leaves a thread whose weight is tool calls: four real
ones of 15 to 23 MB read on 2026-10-07 held 4,000 to 6,200 calls, and one
assistant message carried a whole turn, up to 3,106 parts. The window counted
messages, so such a message was mounted whole whenever any of it was near the
viewport, and every scroll event read each call of the turns on screen again
for the files card. `?fake=1&heavy=1` seeds that shape: forty messages,
11.5 MiB, a last turn of 1,300 calls in runs of about ten.

- `lib/timeline-rows.ts` cuts a message of more than 64 parts into rows of at
  least 40, each starting on a paragraph the page draws. An activity run never
  spans a cut, so the rows draw what the whole message drew, and a continuing
  row keeps the 12 px a paragraph takes inside a message. The window measures,
  anchors and estimates rows; the first row keeps the message's id.
- A part arriving on a streaming message changes its last row only: the rows
  above stay the same objects and draw nothing again. Inside a row, a run over
  the same parts stays the same object, and the runs never read the streaming
  last text, so a text delta rebuilds no run and no group. A live thought's
  title resumes after its last complete line.
- The window hands back the same object while it covers the same rows, and
  the files card reads tool calls only for a turn whose last row is drawn: a
  scroll inside the rows on the page runs neither. Each turn end reads its own
  turn, so a part arriving on the running turn rereads no finished one. A
  finished turn compares its part objects, and fields only for a deferred
  call. The last 24 turns read stay cached, so a turn end that scrolls back
  reads nothing.
- A reading position saves the message and the row of it on top; a find hit
  names its part, and opens the row that draws it.
- An anchor is read from the rows by id instead of searching every node, a
  wheel notch away from the bottom reads no layout, a diff's width comes from
  its `ResizeObserver` entry, page visibility has one listener for every call
  clock, and a call's description is kept by its input object.

Medians of five runs on 2026-10-07, 1280 x 890, software compositing, the base
being `89556311`: a wheel up the long turn went from 1,895 to 784 ms of
main-thread CPU per three seconds, with 3,271 nodes under the scroller down to
849; six jumps across the thread from 825 to 56 ms of long tasks; a flick from
435 ms of long tasks to none, covering 47,000 px of its gesture instead of
26,000. The ordinary 400-message thread measured 878 then 870 ms.
[Heavy-thread report](../bench/results/2026-10-07-heavy-thread.md).

`packages/ui/src/render-cost.test.ts` rejects unbounded blur, forbidden endless
animation properties, outer-container `:has()` and outline width transitions.
The [frame report](../bench/results/2026-09-30-ui-frames.md) and
[typing/scroll report](../bench/results/2026-09-30-typing-and-scroll.md) retain
2026-09-30 measurements and the streaming-fixture correction. They use software
compositing and mobile emulation, with uncontrolled background load.

## What the UI costs at rest

A loop on screen, a spinner of a few pixels included, keeps the compositor
drawing on every refresh of the monitor. Sixteen working threads put one on
every row of the list: the GPU process near half a core with the window in
front, and as much with Boite left visible beside a game.

- `lib/at-rest.ts` marks `<html data-at-rest>` while the page is hidden,
  another application is in front of its window, or nobody has touched the PC
  for two minutes, and every endless animation reads its play state from
  `var(--loops)`, paused there. In the shell the answer comes from
  `user_presence` (the window in front and the system's last input, polled
  every 5 s) and the shell's `window://focus` event, since the webview's own
  focus moves to a browser surface of the same window. Any input on the page,
  or the window brought to front, plays them again at once. A tour picture is
  the exception: it plays while seen (`.agents/DESIGN.md`, 2026-10-16).
- The loops on screen while agents work turn in `steps()` or ease down a
  `--loop-*` staircase of `app.css`, one step a 60th of a second, and
  `lib/loop-phase.ts` starts each on the same 60 Hz grid of the document
  timeline, when it starts and when it resumes: together they make 60 frames a
  second, not one a refresh of a 144 Hz monitor or of headless Chrome.
- `render-cost.test.ts` rejects an endless animation that ignores
  `var(--loops)` and a working-state loop off the 60 Hz grid.

`bun bench/ui-at-rest.ts --runs 2`, 2026-10-17, headless Chrome on ANGLE
Direct3D 11 (RTX 5080), `?fake=1&working=16`, 6 s windows, CPU per wall
second of the renderer and GPU processes, the base being `7c7327ab` with this
change's fake client:

| Scenario | Renderer ms/s | GPU ms/s | Frames/s |
| --- | --- | --- | --- |
| Nothing working | 3 to 4, then 3 to 4 | 3 to 5, then 3 to 4 | 1.8, then 1.8 |
| 16 working, in front | 136, then 75 | 414 to 436, then 135 to 143 | 352 to 357, then 63 |
| 16 working, another application in front | 124 to 126, then 12 to 40 | 376 to 387, then 7 to 8 | 353 to 359, then 2.8 |
| 16 working, phone list | 108 to 110, then 60 to 84 | 88 to 374, then 110 to 122 | 345 to 360, then 61 |
| 16 working, one answer streaming | 439, then 435 to 457 | 458, then 440 to 454 | 357, then 331 to 345 |

Renderer and GPU together drop 62 % with the window in front and 93 % behind
another application. A streaming answer still draws on every frame: the fake
agent writes a token every 16 ms, about 2,000 characters a second, and its
layout, not the loops, sets the cost. Headless Chrome follows no monitor, so
its frame rate stands for a fast one; at 60 Hz the staircases save little in
front and the rest still saves the whole cost. Not measured in WebView2.
[Report](../bench/results/2026-10-17-ui-at-rest.md).

### What a page left running holds

Beyond the loops, a page left open kept a few costs that nothing on screen
needed:

- The model cache was rewritten in `localStorage` on every probe answer, and a
  restore serialized the provider and account lists three times to compare
  them. `saveModels` now writes at most once a second, the last state, and on
  `pagehide`; `restoreModels` compares the lists field by field (`sameJson`).
  A `thread.load` sample, one per working thread at each load report, found its
  row with `Array.find` through the store's proxy; `Threads.rowOf` reads the
  row's position from an id index and checks the id there, so a row replaced
  in place is still found, and builds the index again when the list is
  replaced, grows or moves.
- A composer tile drew its picture as a `data:` URL, the whole picture decoded
  for a 56 by 42 tile, with a multi-megabyte string in the DOM.
  `lib/attachment-previews.svelte.ts` makes one WebP thumbnail at twice the
  tile's size when the picture is attached, and the enlarged preview draws the
  bytes through an object URL; each URL is revoked when its picture leaves the
  prompt. What is sent does not change.
- A hidden terminal kept its xterm and its WebGL context. It now loses the
  context through `WEBGL_lose_context` as it leaves the page (xterm's addon
  only removes its canvas, which holds the context until a collection), and
  drops the whole xterm after five minutes hidden
  ([terminal](terminal.md#the-screen)).
- Every row of a windowed list had its own `ResizeObserver`, and every
  threshold an `IntersectionObserver` crossed read the list's place again. The
  rows of a list share one observer, and those notifications read the layout
  once a frame. Deferred pictures and files had one `IntersectionObserver`
  each, rooted at an ancestor found by reading `getComputedStyle` up the tree;
  `lib/on-view.ts` shares one observer per scrolling root and margin, and the
  timeline marks itself `data-scroll-root`.
- A text from 20,000 characters goes through its grammar in a worker
  ([panel](panel.md)).

The second clock (`lib/clock.svelte.ts`), which the working rows read for
their elapsed time, keeps ticking at rest and stops only while the page is
hidden: a window left visible beside another application is at rest and
still shows its times.

`bun bench/ui-at-rest.ts --only working --runs 3 --wait 120`, 2026-10-17,
headless Chrome on ANGLE Direct3D 11 (RTX 5080), `?fake=1&working=16` with
nobody at the PC, 6 s windows, the base being `1c168fd6` and the heap read
after 120 s. After is measured again on 2026-10-18, merged with `origin/main`
at `9ffdb977`, with the second clock ticking at rest:

| Measure | Base | After |
| --- | --- | --- |
| Frames/s | 2.7 to 3.0 | 2.8 to 3.0 |
| Renderer ms/s | 10 to 15 | 8 |
| GPU ms/s | 6 to 7 | 4 |
| Renderer main thread ms/s | 5 to 7 | 4 |
| Long tasks since load | 2 to 4 (191 to 740 ms) | 0 to 1 (0 to 51 ms) |
| JS heap, MiB | 9.9 to 14.5 | 11.2 to 13.8 |

The long tasks are the page's load, which this change does not touch and the
lean boot on main shortened, and the heap stays within run-to-run noise.

With five terminals opened then hidden, `bun bench/ui-at-rest.ts --only
"hidden terminals"` (2026-10-18, xterm on WebGL, the base being `origin/main`
at `b611c01f`) counts the contexts still live, neither lost nor collected,
before the window's two forced collections and after them:

| Run | Base | After |
| --- | --- | --- |
| `--runs 2`, window 1 s after hiding | 5 live, then 5; heap 12.5 and 16.4 MiB | 0 live, then 0; heap 10.2 and 10.1 MiB |
| `--wait 310`, window 310 s after hiding | 5 live, then 5; heap 12.9 MiB | 0 live, then 0; heap 12.5 MiB |

The base keeps every hidden screen's context; after, each is lost as its
screen leaves the page. Past five minutes the xterms are gone too, which
moves the heap by less than its run-to-run spread.

`bun bench/ui-frames.ts --only "<scenario>" --runs 3`, 2026-10-17, headless
Chrome at 1280 by 890:

| Scenario | Base | After |
| --- | --- | --- |
| Large file highlight, grammar on the main thread | 108 to 242 ms | 0 to 2 ms |
| Large file highlight, long tasks | 2 to 3 (2,706 to 5,423 ms) | 1 to 2 (204 to 616 ms) |
| Typing with a 1920 by 1080 PNG attached, key p95 | 16.7 to 17.6 ms | 16.0 to 17.5 ms |
| Typing with a 1920 by 1080 PNG attached, long tasks | 0 | 0 |
| The same picture, as the tile decodes it | 1920 by 1080 | 149 by 84 |
| Long thread scroll, long tasks | 2 (112 ms) | 0 |
| Heavy thread jumps, long tasks | 0 to 2 in 8 runs (0 to 147 ms) | 0 in the last 4 runs, 2 to 5 (117 to 436 ms) in 4 earlier ones |

The picture rows are from 2026-10-18 with the base at `15fdbb81`: the bench
draws a 1920 by 1080 PNG in the page from a fixed seed, 1,311,112 base64
characters, and waits for the tile to show it. Typing costs the same on both
sides; what the thumbnail changes is the picture the tile keeps decoded, about
7.9 MiB of pixels on the base against 49 KiB after. An earlier version of this
table compared bytes the decoder rejected, so neither side drew a picture.

The large file task left after the change is the browser building 23,000
highlighted nodes, not script. The heavy thread jumps scenario is noisy on both
sides; in its profiles the long tasks are rows mounting (`innerHTML` and the
scroll anchor's layout read in `remember`), none of it code this change
touched, and yielding from script would not split them, so nothing yields
there.

## What a long day holds

The desktop page of a machine with many agents at work stays open for days,
often minimized. `bench/ui-heap.ts` plays that stream on the fake client
(`?fake=1&load=<n>`, `lib/fake-client/load.ts`): each busy thread types two
deltas and starts one short-lived process per tick, sends its row and load
every ten ticks, a tool call with a 16 KiB output every thirty, a new turn
every three hundred. `&machines=1` gives the second machine the same load in
its own store. The bench samples the JS heap with garbage collected twice, the
DOM, the listeners and the renderer's private bytes, and `--core` plays echo
agents on a real core instead.

What the UI held without bound:

- The open thread's live end. Messages arriving on the subscribed thread were
  appended for as long as it stayed open, while a thread left keeps 4 MiB in
  the reading cache. Now, while the list follows the bottom,
  `store/live-end.ts` weighs the live end each time a message arrives (never
  on a delta) and, past twice the reading cache's per-thread bound (8 MiB or
  2,000 messages), keeps the newest 4 MiB or 1,000 messages with their turns
  and sets `messagesBefore` to the first one kept: scrolling up reads the rest
  again from the core. The heights and rises the list measured for the rows
  that left go with them.
- The trace panel's process rows, about 850 bytes of heap each, at one row per
  process the open thread starts. The client now keeps at most `TRACE_LIMIT`
  (200) of them, and none while the trace view is closed.

Not growing: thread rows, delegation refreshes, Tauri IPC callbacks and the
module caches (Markdown, highlighting, measured heights, media sizes) stay
flat, as does the DOM of a visible list. A hidden page runs no frame callback
and no `ResizeObserver`, so a long answer streamed while minimized mounts its
rows until the window comes back.

`bun bench/ui-heap.ts --bundle <dir> --machines --load 4 --tick 25 --switch 0 --minutes 9 --sample 60`,
2026-10-17, Windows 11, headless Chrome on the GPU, same bundle with the bound
turned off for the first column:

| minute | heap before, MiB | messages held | heap after, MiB | messages held | trace rows |
|---:|---:|---:|---:|---:|---:|
| 0 | 51.3 | 22 | 51.3 | 22 | 5 |
| 3 | 53.6 | 68 | 54.6 | 68 | 7,165 |
| 4 | 58.2 | 84 | 56.4 | 38 | 9,553 |
| 6 | 64.1 | 114 | 59.4 | 44 | 14,250 |
| 9 | 72.4 | 150 | 64.9 | 30 | 20,092 |

The heap still rises 1.5 MiB a minute in the after column: the trace rows,
about 16 MiB at minute 9. Without them the heap after the change stays between
48 and 49 MiB from minute 3 on, while before it rises from 48 to 57 MiB. With
the trace bound beside it, so no trace row while the trace view is closed, the
same command on a prebuilt `--bundle` measures 51.3 MiB at minute 0, then 45.3
to 47.2 MiB from minute 1 to 9 (46.8 at minute 9), 28 to 68 messages held and
140 to 146 MiB private in the renderer.

## Browser tools and review bundle size

Measured on Windows with Bun 1.4.2 on 2026-10-02, using `bun run build:ui`
for both `83ae9b4` and the browser tools, recording, linked PR review and remote
preview changes. Totals exclude precompressed `.br` and `.gz` copies, as
`scripts/ci/budgets.ts` does.

| Build | UI entry | Complete UI |
| --- | ---: | ---: |
| `83ae9b4` | 407,290 bytes | 3,751,358 bytes |
| Browser tools and remote review | 478,371 bytes | 3,835,773 bytes |

The added dialogs, browser controls, recording encoder support and translations
add 84,415 bytes (2.25%) to the complete UI. The WebM duration parser, removed
since recordings became MP4 only, loaded only when finalizing a recording. The total UI budget increases by 84,000 bytes to
3,880,000, leaving about 44 KB of headroom; entry and core budgets are unchanged.

### Phone navigation and remote viewport controls

After integrating `main` (`1bc9d2d`), `bun run build:ui` on Windows with
Bun 1.4.2 on 2026-10-02 measured 3,883,595 bytes for the complete UI.
The desktop CI build at `2cd9f84` measured the same total. Main's desktop CI
reported 3,761.8 KiB; this mobile follow-up reports 3,792.6 KiB, about 30.8 KiB
more for the top navigation, pairing recovery, viewport controls and their
translations. These totals exclude precompressed copies.

The total UI budget increases from 3,880,000 to 3,920,000 bytes, leaving
36,405 bytes of headroom. The entry and core limits stay unchanged. This
records the feature cost; it does not claim a size or startup improvement.

### Chat reply activity

On 2026-10-03, `bun run build:ui` with Bun 1.4.2 on Linux measured
4,010,822 bytes for the complete UI and 537,206 bytes for its entry chunk,
after integrating `main` at `2ba18d9b`. Main's 4,020,000-byte UI limit covers
this build with 9,178 bytes of headroom; entry and core limits stay unchanged.
Totals exclude precompressed copies, as `bun scripts/ci/budgets.ts` does.

Before that integration, the same command measured 3,984,925 bytes after
integrating `main` at `1c6d8319`, matching desktop CI. The steering-activity
fix adds 126 bytes to the 3,979,995-byte build at `46388ac4`; the intervening
usage changes add another 4,804 bytes. The earlier UI limit adjustment is
superseded by main's text-alignment budget.

### Agent discussions

On 2026-10-11, `bun run build:ui` with Bun 1.4.2 on Linux measured 4,483,627
bytes for the complete UI and 585,725 bytes for its entry chunk. Main's desktop
CI at `4762402b` reported 4,366.7 KiB complete and 567.8 KiB entry; the
discussion rows, the Discussions tab with its conversation view, the avatar and
their translations add about 12.1 KB, net of the removed message bubble. The
total UI budget increases from 4,475,000 to 4,500,000 bytes, leaving 16,373
bytes of headroom; entry and core limits stay unchanged. Totals exclude
precompressed copies, as `bun scripts/ci/budgets.ts` does.

### Update everything

On 2026-10-13, after integrating `main` at `8ac1d98f`, `bun run build:ui` with
Bun 1.4.2 on Linux measured 4,888,826 bytes for the complete UI and 522,879
bytes for its entry chunk. Main measured 4,864,454 and 523,647 at that commit
([CI](ci.md#build-cost)). The sidebar's update card, its plan, its rows that
land one at a time, its two buttons and Restart, and the Update all button in
Machines add 24,372 bytes: the card's chunk, its styles, the icon chunks split
out now that it draws machine icons, and the translations. The entry chunk is
768 bytes smaller. The total UI budget
increases from 4,872,000 to 4,898,000 bytes, leaving 9,174 bytes of headroom;
entry and core limits stay unchanged. Totals exclude precompressed copies, as
`scripts/ci/budgets.ts` does.

### Process load pacing and trace rows

On 2026-10-16, after integrating `main` at `0f480824`, `bun run build:core`
with Bun 1.4.2 on Linux measured 4,246,842 bytes of core JavaScript. Main
measured 4,237,867 at that commit. The load pacer, the bare-name spawn
resolver, the trace row pruning, the jobs packet filter and the batched audio
walk add 8,975 bytes. The core JavaScript budget increases from 4,240,000 to
4,249,000 bytes, leaving 2,158 bytes of headroom; UI and core entry limits stay
unchanged.

## The desktop browser on a phone

A paired phone watching the desktop's browser tab, before the agent's browser
moved to the conversation's machine ([the agent's browser](browser.md)), waited a fixed 300 ms after
each frame, on top of the trip itself: two frames a second on a quick link. It
now asks again as soon as a frame arrives, never closer than 250 ms to the last
request, with one request in flight. The desktop captures the tab at q75
instead of q90 before shrinking it to the phone's width: the frame sent is the
same size, and the capture to shrink is a third smaller. Through a scratch core
on 2026-10-03, a moving page went from 2.0 to 4.0 frames a second with 80 ms
of added latency, and from 1.6 to 3.3 with 200 ms
([results](../bench/results/2026-10-03-remote-browser-frames.md)). The
desktop's capture and shrink take 100 to 140 ms a frame. The phone decodes each
frame before showing it, so a frame never appears half loaded; that decoding
was not measured on an iPhone.

Since 2026-10-05 the frames come from the agent's browser on the machine of the
conversation ([the agent's browser](browser.md)). Through a scratch core on the
Linux container `boite`, a moving page gave 4.0 frames a second with no added
latency, 3.4 with 80 ms and 2.5 with 200 ms; the capture in the core's browser
takes about 200 ms a frame for that page
([results](../bench/results/2026-10-05-remote-browser-frames.md)).

Since 2026-10-15 the frames come from a screencast of the tab on its own
DevTools session ([the agent's browser](browser.md#watching-it)). Chrome sends a picture
only when the page draws, and a viewer naming the frame it shows gets
`unchanged` on a still page. On a still page a viewer went from 163 to 15 KiB/s
of base64 and the core's Chrome from 8 % to 0 % of a core; on a moving page the
trip lost about 72 ms at the same four frames a second and the same Chrome CPU
([results](../bench/results/2026-10-15-perf-browser.md)).

## Browser tabs nobody uses

The agent browser runs every tab as shown, focused and unthrottled, so a page
left open runs at full speed with nobody on it. On 2026-10-17 one renderer of
M2's agent browser had run 16 hours at 38 % of a core, and on the Windows
desktop two renderers of the shell used 0.4 and 0.25 of a core with nobody
looking; a hidden native tab of another conversation ran 30 minutes at 1.5
cores and grew to 14 GB. A tab of the agent browser now sleeps 30 seconds
after its last use once no viewer or recording holds it and no running turn
used it in the last 5 minutes, and a
hidden native page of the desktop is suspended with its memory level low
([the agent's browser](browser.md#a-tab-nobody-uses-sleeps)).

`bun bench/browser-sleep.ts` opens a page that draws a canvas every animation
frame and runs a timer every 10 ms in a scratch core's browser, as an agent
would, and reads the CPU of that browser's processes for 20 s while the tab is
still within its wait, then 20 s after it. On Windows 11 (headless Edge,
Bun 1.4.2) on 2026-10-17:

| Tab             | Renderer | GPU process | Other browser processes | Next command |
| --------------- | -------- | ----------- | ----------------------- | ------------ |
| Awake (before)  | 19.1 %   | 22.7 %      | 4.1 %                   | 3 ms         |
| Asleep (after)  | 0.2 %    | 0.1 %       | 2.7 %                   | 59 ms        |

Percentages are of one core. The first command on a sleeping tab pays the
wake, two DevTools round trips and the page's first frames. The same freeze
through `Page.setWebLifecycleState` alone, with focus emulation left on,
changed nothing: the page drew 1,095 animation frames in the 10 s it was
frozen (`Emulation.setFocusEmulationEnabled` keeps it shown). The desktop's `TrySuspend` was not measured in the app; it is
covered by a unit test of which pages it applies to.

## Browser recordings

A recording used to ask the tab for a screenshot every 125 ms and wait for
it: 6.5 frames a second, at three minutes and 50 MiB at most. The shell now
subscribes to the page's screencast and acknowledges each frame on a worker
thread at the chosen rate, so Chromium never sends faster than 30 or 60 frames
a second and never more than two at once. The JPEG reaches the UI as raw bytes
over a Tauri channel, without base64 or the core. The UI decodes only the
newest frame, draws it on a canvas and asks the MediaRecorder for exactly that
frame. WebView2's H.264 encoder took about 0.7 s to start once per process
and dropped what it received meanwhile; its software AV1 encoder froze the first
1.1 to 2.6 s of a take. Opening a page therefore starts the encoder of the
desktop's codec on a 64 × 64 canvas, once per process, and so does picking a
codec in the menu. A take never waits for that warm-up: it records at once and
warms its own codec for the next takes. Its first frame is one capture of the
page, or a streamed frame if one arrives meanwhile; a start no longer waits
1.5 s for a still page to stream.

Time from `recording-start` to its answer, first take of a fresh shell, the
page open for 6 s before, on 2026-10-04 (Windows 11, Edge WebView2 154). The
desktop's codec is H.264, so only that one was warmed at page open; AV1 started
cold. Before is the release shell before this change, whose start waited for
the warm-up and for a streamed frame:

| Page | Codec | Before | After | After: frames, longest gap |
|---|---|---|---|---|
| 358 × 748, animated | H.264 | 550 ms | 34 ms | 93 in 3 s, 43 ms |
| 358 × 748, animated | AV1 | 547 ms | 37 ms | 93 in 3 s, 40 ms |
| 358 × 748, still | H.264 | 480 ms | 25 ms | 5 in 3 s, 1023 ms |
| 358 × 748, still | AV1 | 482 ms | 29 ms | 5 in 3 s, 1023 ms |
| 1920 × 1080, animated | H.264 | 584 ms | 51 ms | 150 in 5 s, 133 ms |
| 1920 × 1080, animated | AV1 | 552 ms | 60 ms | 152 in 5 s, 45 ms |

The cold AV1 takes kept their frame rate from the first second. A still page
repeats its frame once a second by design. Command, per row:
`BOITE_E2E_SHELL_EXE=<release shell> BOITE_RECORDING_CODEC=h264|av1
BOITE_RECORDING_SECONDS=3|5 [BOITE_RECORDING_STILL=1]
[BOITE_RECORDING_PRESET=desktop-1920x1080] bun test tests/e2e/browser-recording.test.ts`.

A still page streams nothing, so its last frame is repeated and the page is
captured once a second. A capture that differs from the previous one means the
page moves while the stream is silent: it is then captured at the frame rate,
one request at a time, until a streamed frame arrives or two captures match.
The CLI downloads a recording in 4 MiB chunks; a core from before this change
reads 512 KiB at a time, which is what the desktop sends unless asked for more.

`tests/e2e/browser-recording.test.ts` records an animated page through the
shell's CLI and counts the frames with ffprobe. With `BOITE_E2E_SHELL_EXE` set
to a release shell on 2026-10-04 (Windows 11, other agents' builds running):

| Requested | Length | Measured | Frame gap median / p95 / max | Size | Shell tree CPU, page alone |
|---|---|---|---|---|---|
| 30 fps | 10 s | 30.0 fps | 31 / 40 / 43 ms | 8.2 MiB/min | 68 %, 33 % of one core |
| 60 fps | 10 s | 60.0 fps | 19 / 21 / 25 ms | 14.8 MiB/min | 106 %, 33 % |
| 30 fps | 120 s | 30.0 fps | 31 / 42 / 50 ms | 8.1 MiB/min | 79 %, 35 % |
| 60 fps | 240 s | 58.2 fps | 18 / 25 / 1033 ms | 14.4 MiB/min | 100 %, 38 % |

The 240 s take's 58 MiB stopped and downloaded in 12.2 s. Its slow frames
came between 145 and 190 s, while the machine was loaded at 60 to 100 %.

The same test per codec, 30 s takes of the 358 × 748 page on 2026-10-04
(Windows 11, Edge WebView2 154, Radeon RX 6750 XT):

| Codec | Requested | Measured | Frame gap median / p95 / max | Size | Shell tree CPU, page alone |
|---|---|---|---|---|---|
| H.264 | 30 fps | 30.0 fps | 32 / 39 / 78 ms | 8.1 MiB/min | 67 %, 36 % of one core |
| H.264 | 60 fps | 59.9 fps | 19 / 23 / 55 ms | 14.8 MiB/min | 99 %, 82 % |
| AV1 | 30 fps | 30.0 fps | 32 / 41 / 52 ms | 4.4 MiB/min | 70 %, 35 % |
| AV1 | 60 fps | 58.7 fps | 18 / 24 / 108 ms | 7.5 MiB/min | 112 %, 34 % |
| HEVC | 30 or 60 | refused | | | |

AV1 is half the size of H.264 for about 15 points more CPU at 60 fps; WebView2
encodes it in software. Every file decoded whole with ffmpeg and played in the
review dialog and in chat. WebView2 154 reports no HEVC for MediaRecorder in
MP4, `hvc1` or `hev1`, even with its `PlatformHEVCEncoderSupport` feature on,
so HEVC is greyed out in the menu and refused by the CLI. An HEVC MP4 made by
ffmpeg's `hevc_amf` encoder played in chat on this PC; an MPEG-4 Part 2 MP4
showed the chat's download fallback. Encoding HEVC would need WebCodecs, which
reports it only behind that feature, and an MP4 muxer in the UI.

A noise page at 1920 × 1080 and 60 fps grows 88 MiB a minute: H.264 stopped
by itself after 62.8 s at 92.3 MiB, below the 100 MB cap that leaves room for
the container. The file decoded whole, the dialog played it and gave the
reason, and the CLI result's `note` named the limit. Stopping and downloading
took 8.4 s.

`BOITE_RECORDING_SECONDS`, `BOITE_RECORDING_FPS`, `BOITE_RECORDING_CODEC` and
`BOITE_RECORDING_KEEP` set the length, the rate, the codec and a folder that
keeps the video. `BOITE_RECORDING_PRESET` sizes the page,
`BOITE_RECORDING_NOISE=1` records noise to reach the cap, and
`BOITE_RECORDING_PLAY` lists other videos (`;`-separated) to play in chat.

The core's own recorder (`browser/recorder.ts`, a tab of the agent's browser)
paces frames to the take's rate and acknowledges each when it leaves, so
Chrome encodes about one picture per slot of the take. Its helper page decodes each frame's base64 with
`Uint8Array.fromBase64`: 0.2 ms instead of 18 ms for a 1920 × 1080 frame. On
2026-10-15, a 10 s 30 fps take of a moving 1920 × 1080 page went from 19.7 to
29.4 frames a second by ffprobe, and the core's Chrome from 453 % to 339 % of
a core ([results](../bench/results/2026-10-15-perf-browser.md)), with a
version that asked every second frame; the late acknowledgement that replaced
it has not been measured.

## Checkpoints and the agent browser on disk

File checkpoints took 2,830 MiB of the user's data directory on 2026-10-17:
80,430 blobs written before the shared store stayed private copies in their
thread folders, every blob and manifest was raw, and every turn of every
thread kept its checkpoint. A blob is now a zstd frame when that saves a
tenth, a manifest always one, a background pass links or moves the old copies
into the shared store, and each thread keeps the newest 50 turns, none once
archived or done for 7 days ([context](context.md)). A snapshot no longer
reads a shared frame whole before linking it: its size and its first four
bytes, then the hash check of the rewind.

`bun run bench/checkpoint-store.ts --source <checkpoints>` on a copy of that
folder, 2026-10-17, Windows 11
([results](../bench/results/2026-10-17-checkpoint-store.md)):

| | Files (inodes) | Bytes | Manifest bytes |
|---|---:|---:|---:|
| Before | 100,096 | 3,034 MiB | 200 MiB |
| After adoption and compression | 25,685 | 353 MiB | 41 MiB |
| After 50-turn retention | 14,532 | 183 MiB | 37 MiB |

20 rewinds sampled across the folders restored 243 files byte for byte
afterwards. The one-time pass read 856 MiB and ran 1,062 s without pauses.

The agent browser's `browser/default` held 664 MiB the same day, 394 MiB of
Edge components and 198 MiB of caches. It now starts with
`--disable-component-update` and `--disk-cache-size=67108864`, and a profile
loses those folders once before its next start
([browser](browser.md#processes-and-profiles)); the size of a profile after
that was not measured.

## Where an agent's tokens go

Each model call re-reads its whole context, from the cache while it is warm,
so a block costs its size times the calls it stays for.
`scripts/token-audit.ts` reads Claude Code transcripts and splits that sum by
what the context holds; its header explains the attribution.

```sh
bun scripts/token-audit.ts --days 7 --chars-per-token 2.5
```

The original audit on one owner's machine selected transcript files modified
in the 7 days to 2026-10-27, including older calls inside those files:
86,238 calls in 1,561 stretches
between compactions, a mean context of 104k tokens, compaction at 166k (the
`autoCompactWindow: 200000` of that user's settings) down to 44k at the median. At API rates relative
to input, cache reads made 52% of the cost, 1 hour cache writes 28% and output
20%.

| What the context held | Share of the sum of context |
|---|---|
| System prompt and tool definitions | 17.7% |
| Claude Code attachments: instructions files 5.4%, files attached again after a compaction 5.0%, skill listing 3.5% | 17.5% |
| Read results | 16.6% |
| Earlier thinking | 13.2% |
| Shell results | 10.7% |
| Compaction summaries, 20k characters at the median | 6.8% |
| Grep results | 6.7% |
| Text Boite adds: guide, notices, delegation and coordination messages | 1.3% |
| Tool calls the agent wrote: shell 3.5%, Write 1.9%, Edit 1.4% | 7.8% |
| The rest: the agent's and the user's text, other tool results, images | 1.7% |

The original audit replayed the same calls under other policies. These are
pre-hook estimates using the measured 44k base and a fixed 8.3k summary output;
they do not measure a configured summary prompt:

| Policy | Sum of context | Cost |
|---|---|---|
| Compact at 120k | −26.1% | −6.6% |
| Compact at 150k | −11.7% | +0.8% |
| Clear tool results older than 10 calls, cache rewrites not counted | −22.2% | not modelled |
| Cap each tool result at 5k tokens | −2.2% | not modelled |
| 5 minute cache instead of 1 hour | unchanged | +9.2% of input cache cost |

The cache row uses input cache cost as its denominator in this historical
measurement. The script now reports that difference against full cost, like
the compaction rows. The original transcripts were not re-audited.

A lower threshold costs a summary and a rewritten cache at each extra
compaction, which is why the cost falls far less than the context. Automatic
compaction is the owner's setting ([context](context.md#automatic-compaction)).

## Benches

```sh
bun bench/remote-browser-frames.ts --rtt 0,80,200   # frames a second a viewer gets from the agent's browser
bun run build:ui
bun run bench/bandwidth.ts --rtt 150          # bytes and time per scenario behind a delayed relay
bun run bench/bandwidth.ts --core <other checkout>/packages/core/src/main.ts --sequence sequential
bun run bench/startup.ts --exe <boite-shell.exe> --runs 7
bun bench/ui-frames.ts --noblur                # fps and main thread per UI scenario, software compositing
bun bench/ui-frames.ts --ui <other checkout>/packages/ui --cpu 4 --size 1920x1080@1.5
bun bench/ui-frames.ts --trace --only "typing,long thread scroll"   # layouts per window, and how many a script forced
bun bench/ui-frames.ts --runs 5 --only "heavy thread scroll,heavy thread flick,heavy thread jumps,heavy scroll while streaming"
bun bench/ui-frames.ts --gpu --only "heavy thread scroll"          # composited on the machine's GPU, never a software renderer
bun bench/ui-at-rest.ts --runs 2                                   # renderer and GPU CPU, frames, with 16 threads at work, in front or behind
bun bench/rpc-actions.ts --journal <journal.db> --runs 6   # latency, core CPU, bytes and RSS per RPC (Linux)
bun bench/claude-turn-heap.ts                  # heap a scripted Claude turn leaves; STEER=1 IMAGE_MIB=0 for a follow-up cut
bun bench/codex-live-output.ts                 # redraws and characters of one running Codex command's live output
bun bench/provider-list.ts                     # time per providers list() and summary(); ONLY=1 under strace -c
bun run bench/continuation.ts 100 1024 25 1100            # history a fresh session carries: messages, tool KiB, files, file KiB
bun run bench/queue-admission.ts 1024 16                  # one scheduler pass over held child turns: turns, teams
bun bench/ui-heap.ts --machines --load 4 --tick 25 --switch 0 --minutes 9   # heap, DOM and private bytes of a page left open on busy agents
bun bench/process-log-replay.ts <logs directory>          # process records a log directory holds, and what this store writes of them
bun run bench/checkpoint-store.ts --source <checkpoints>  # store passes and retention on a copy: bytes, inodes, 20 rewinds
```

`bench/bandwidth.ts` puts a TCP relay between the client and the core, counts
the bytes each way and delays each direction by half the round trip. `--core`
measures another checkout's core and the UI build beside it, and
`--sequence sequential` plays the client that checkout shipped. The bench
client sends a non-loopback `Host`, otherwise the core would treat it as local.

`bench/startup.ts` starts the hidden shell on a fresh data directory and a fresh
WebView2 profile, and reads the page's own timings over the debugging port.

`bench/ui-frames.ts` builds the fake-client UI in a child process, serves it,
and plays each scenario in headless Chrome without a GPU: frames drawn, long
tasks and main-thread time, per 1,000 px for the scroll scenarios, and each
key's latency for the typing ones. `--noblur` repeats each one with backdrop
filters off, `--css "<rules>"` with the rules it is given, `--ui` measures
another checkout. `--trace` counts the layouts of each window, those a script
forced and the paints, and the last two columns give the main thread's own
CPU time and the nodes under the scroller: numbers that hold on a busy
machine. `--profile <dir>` writes a CPU profile per scenario. `--gpu`
composites on the machine's GPU, as an accelerated WebView2 does, and stops
when Chrome only finds a software renderer. The heavy scenarios play the
11.5 MiB thread of `?fake=1&heavy=1`.

`bench/rpc-actions.ts` starts a core as a child process and times the boot
calls, the reads of a thread and the common writes, with the core's CPU and
RSS read from `/proc`. `--journal` runs it on a copy of a real journal taken
with `VACUUM INTO`; the copy's projects, accounts, sessions and network
settings are pointed at the temporary directory first.

`bench/remote-browser-frames.ts` starts a scratch core, opens a moving page in
the core's own browser and has a paired phone client poll it on the viewer's
schedule behind an added latency.

Results: [bench/results/2026-10-15-perf-runtime.md](../bench/results/2026-10-15-perf-runtime.md),
[bench/results/2026-10-15-perf-drivers.md](../bench/results/2026-10-15-perf-drivers.md),
[bench/results/2026-10-05-rpc-actions.md](../bench/results/2026-10-05-rpc-actions.md),
[bench/results/2026-10-05-remote-browser-frames.md](../bench/results/2026-10-05-remote-browser-frames.md),
[bench/results/2026-10-03-remote-browser-frames.md](../bench/results/2026-10-03-remote-browser-frames.md),
[bench/results/2026-09-19-wire-and-startup.md](../bench/results/2026-09-19-wire-and-startup.md),
[bench/results/2026-09-30-ui-frames.md](../bench/results/2026-09-30-ui-frames.md),
[bench/results/2026-09-30-typing-and-scroll.md](../bench/results/2026-09-30-typing-and-scroll.md),
[bench/results/2026-10-07-heavy-thread.md](../bench/results/2026-10-07-heavy-thread.md).

## The Windows sidecar is the signed runtime

Windows ships Bun's signed baseline runtime as `boite-core.exe`, with the core
JavaScript beside it. The baseline supports x64 CPUs without AVX2. Compiled
Linux/macOS sidecars and x64 server builds keep their platform packaging.
[Releasing](releasing.md#what-each-step-produces) owns runtime download,
checksum/signature validation and bundle layout.

The [dated runtime measurements](../bench/results/2026-09-29-resources.md#runtime-and-bundle-measurements-2026-09-19-to-2026-09-29)
retain the Windows compiled-versus-signed startup results, baseline comparison
and account-change bundle sizes. No corresponding Linux/macOS startup gain
was measured. Current emitted-size checks live in
[CI](ci.md#bundle-growth).
