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
Active work keeps its capacity until completion; when only active work fills
the shared byte limit, a new request is refused. Disconnect and shutdown
discard work that has not started.
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

The [dated stress report](../bench/results/2026-09-29-resources.md#stress-measurements-2026-09-29-and-2026-09-30)
preserves the Windows Bun 1.4.2 runs, tables and failed 1,000-start attempts from
2026-09-29 and 2026-09-30. These fixtures do not establish a supported real-agent
count, provider quota, native shell performance or physical-phone behavior.

## Naming a long conversation

`bun run bench/retitle.ts` creates 5,000 messages containing about 40 MB of text
on a temporary core and regenerates the title with the offline echo driver.
It warms up once, then reports six samples. On 2026-09-22, the median fell from
103.08 ms to 0.26 ms after replacing a full history load with a journal iterator
that stops after the first user message and nonempty assistant answer.
This measures local history lookup and title persistence, not provider latency.

## Persistent-agent history

`bun run bench/agents-snapshot.ts [steps]` records finished work, its run with
20 KB of frozen instructions, a message and a memory per step, plus a session
every ten steps, on a temporary core. It then reads `agents.snapshot` over RPC
and looks up one live session among the recorded ones, six samples each after a
warm-up. On 2026-09-24, at 2,000 steps:

| | main (11631eb) | bounded snapshot |
| --- | --- | --- |
| Snapshot JSON | 43.0 MB | 121 KB |
| Snapshot median | 351.78 ms | 3.66 ms |
| Session lookup median | 0.238 ms | 0.021 ms |

The snapshot carries the newest 50 messages, memories and finished work, all
unfinished work, and runs without their instructions. At 500 and 8,000 steps it
measured 86 KB and 260 KB; the difference is the session list, which grows with
contexts rather than with history. Main measured 10.8 MB at 500 steps.

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
16 MiB frame limit; oversized events close with 1009. A backed-up socket
closes with reconnectable 1013 after 10 seconds without draining, or before
a frame would exceed the byte budget. Further sends are ignored and timers
and pending parts are cleared. This closes only that client; the journal and
other connections continue. Reconnecting clients load a fresh thread snapshot.

When a socket backs up (Bun's `send` returns -1), subsequent frames stay queued
within these limits except `message.delta`, which is dropped. Catch-up tracks
at most 1,024 distinct parts and 16 MiB of UTF-8 keys before closing with 1013.
Pacing flushes at 1,024 parts or 16 MiB of serialized held frames, preserving
wire order without an additional transport queue. On `drain` the core resends the text
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
  16 MiB in total, with a 2,000-message bound per thread.
- Cores advertising `threadSnapshots` receive one `threads.get` for an open.
  Its receipt includes pending cards, subscribes this socket, replaces the
  previous subscription and acknowledges unread content after a successful read.
  Older cores keep the four-call burst for subscription, snapshot and cards.
- A first visit requests 40 messages, then pages backwards by 120. A cached
  visit allows up to 200 messages to catch up before falling back to a tail.
  These limits affect the displayed window; the journal retains the history.
- Completed tool outputs above 16,384 characters arrive as 1,024-character
  previews. Opening the tool retrieves its complete output with
  `messages.toolOutput`. Inputs, diffs, documents and running tools remain
  complete. Older cores that ignore the preview option still return full output;
  disclosures fall back to their existing history methods if needed.
  An expanded output refreshes after compact revalidation: matching preview
  prefixes cannot prove that the omitted text stayed unchanged.
- File links arrive with their name, MIME type and decoded byte count. Their
  base64 data loads through `messages.attachment` when opened or downloaded.
  Assistant media previews retain their bytes on first read.
  Older cores return full files, and a cached deferred file can fall back to
  their history methods after a downgrade.
- On a core advertising `readingPages`, pages ask for `compactImages`: a
  picture above 8 KiB of base64 arrives as its decoded size, holds a
  thumbnail-sized place, and loads through `messages.attachment` once within
  400 px of the viewport. Edit fetches a prompt's deferred files and pictures
  before it fills the composer.
- While a first page downloads, the chat shows a bar and "192 kB / 1.3 MB",
  the bytes received against the total the core put in each slice. A page
  under 64 KiB comes whole and the bar runs without numbers; it shows after
  150 ms, so a fast open does not flash it.
- A first visit with a saved reading position (an anchor message, not pinned
  to the bottom, no cached visit) asks `threads.get` for the page `around`
  that message on a `readingPages` core: 20 messages before it and 20 from
  it, when more than 40 follow it. `messagesAfter` is the cursor below that
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
  separators. The journal iterates its thread index and stops at the count or
  byte boundary, retaining complete messages and a gapless backwards cursor.
  Current buffered parts count toward the budget. One complete attachment-sized
  message can exceed 12 MiB so pagination advances; a message or complete RPC
  response above 16 MiB is refused explicitly rather than losing content.
  Turns, thread metadata and memory events also occupy that RPC response budget.
- On a reconnect, the open thread's `threads.get` leaves before the boot lists,
  so the missed text does not wait for the slowest of them. The fresh
  `threads.list` is laid over the rows already held: a row keeps its object and
  only the fields that changed are written, so the sidebar redraws the rows that
  moved and no others. A `thread.updated` load tick patches its row the same way.
- A streamed delta, part or turn looks up its message or turn from the end of
  the loaded timeline, where the item being written sits.
- The trace is read when the trace surface is on screen, not on every open.
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
baseline checkout. The [2026-10-02 measurements](../bench/results/2026-10-02-thread-switching.md)
record samples, reading-position drift and the subsequent t3code comparison.
`tests/e2e/thread-switch.test.ts` separately exercises the production UI with
a real temporary core, a 750 ms snapshot delay and a large folded tool output.

`bun run bench/thread-open.ts --runs 3` seeds a fresh data directory with a
200-message thread shaped like a real long one (1.1 MB attached files every
eighth prompt, a picture every 25th, 30 tool outputs per answer, 48.9 MB
of parts) and times `threads.get` on loopback and through a 150 ms relay, then
the click to the first message in headless Chrome, plain and throttled. `--base`
skips the parameters an older core does not take. The
[2026-10-05 report](../bench/results/2026-10-05-thread-open.md) has the numbers;
`tests/e2e/thread-open.test.ts` captures the bar at both widths and checks
its total against the page the core sends.

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

The command palette, the project picker, the import dialog and the right panel
are separate chunks. They load when first asked for, and all of them once the
app has booted and the page is idle, so a PWA that goes offline later still has
them in its cache. A link that asks to save data, or reads as 3G or slower,
skips that prefetch and fetches each one when it opens (`lib/prefetch.ts`). The
tour is prefetched only for a device that has not seen it.

The French catalogue and the quota window are chunks of their own too, so an
English page does not download or parse either (`docs/language.md`).

The service worker still asks the core for the app shell first, but waits
2.5 s at most before serving the cached one; the late answer is stored for the
next open.

## Core startup

The entry loads the CLI for commands and the Core/server graph for server
startup. Version metadata lives in `packages/core/src/version.ts`.
The compiled launcher awaits the main module before dispatch, including with
ESM bytecode. `packages/core/test/main-entry.test.ts` checks command imports,
port refusal, the compiled binary and graceful lock release.

Activity restoration selects threads with saved activities. Coordination
recovery selects active threads and threads with potentially pending letters.
Both validate visible thread JSON before recovery and retain the original
error order, archived-thread handling and recovery writes.

Claude and ACP join the other native drivers behind a lazy factory. Listing
providers, capabilities or cached models does not load their protocol runtime.
The first operation shares one import; a failed import can retry. Stop, thread
release and shutdown retire pending sessions before a late factory can start a
process. `packages/core/test/lazy-driver.test.ts` covers these boundaries.

`fflate`, the unzip library behind provider installs and the local speech
runtime, is imported where it unzips. Evaluating it builds its Huffman tables,
about 8 ms per core start measured on 2026-09-25, for code most starts never
run. `packages/core/test/startup-imports.test.ts` fails if a static import
brings it back.

The core lists its providers twice before it listens (the registry loads, then
the default accounts ask which ones are available), and again for every client
that boots. Each listing looks up every candidate program on the PATH, with
every PATHEXT extension on Windows. `packages/core/src/providers/which.ts`
keeps each answer for two seconds, so a burst of listings scans the PATH once,
and forgets them all on a providers reload, an install or an agent update.
`packages/core/test/providers-which.test.ts` counts the lookups.

## Shell startup

The shell spawns the core before it builds the WebView2 window, and polls for
`core.json` every 10 ms instead of every 120 ms.

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
  boxes named in `render-cost.test.ts`. Outer app containers avoid `:has()`.
- Entrance animations run for arriving messages, rather than history remounts.
- The outline rail updates once per frame and animates transforms. Message
  heights come from `ResizeObserver`; reading anchors are captured after the
  scroll render so immediate navigation restores the same message.
- Wheel listeners are passive: they release bottom following without
  cancelling browser scrolling. `MessageList.test.ts` guards the listener
  options.
- Icon shapes and locale date formatters are reused. Finished Markdown markup
  has a four-million-character cache bound.
- The composer uses `field-sizing: content` where supported; IndexedDB draft
  writes wait for a typing pause. Bottom following runs after layout and before
  paint through `ResizeObserver`.

`packages/ui/src/render-cost.test.ts` rejects unbounded blur, forbidden endless
animation properties, outer-container `:has()` and outline width transitions.
The [frame report](../bench/results/2026-09-30-ui-frames.md) and
[typing/scroll report](../bench/results/2026-09-30-typing-and-scroll.md) retain
2026-09-30 measurements and the streaming-fixture correction. They use software
compositing and mobile emulation, with uncontrolled background load.

## Browser tools and review bundle size

Measured on Windows with Bun 1.4.2 on 2026-10-02, using `bun run build:ui`
for both `83ae9b4` and the browser tools, recording, linked PR review and remote
preview changes. Totals exclude precompressed `.br` and `.gz` copies, as
`bun scripts/ci/budgets.ts` does.

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

## The desktop browser on a phone

A paired phone watching the desktop's browser tab
([phone](phone.md#the-desktop-browser-on-a-phone)) waited a fixed 300 ms after
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

## Benches

```sh
bun bench/remote-browser-frames.ts --rtt 0,80,200   # frames a second a phone gets from the desktop's browser tab
bun run build:ui
bun run bench/bandwidth.ts --rtt 150          # bytes and time per scenario behind a delayed relay
bun run bench/bandwidth.ts --core <other checkout>/packages/core/src/main.ts --sequence sequential
bun run bench/startup.ts --exe <boite-shell.exe> --runs 7
bun bench/ui-frames.ts --noblur                # fps and main thread per UI scenario, software compositing
bun bench/ui-frames.ts --ui <other checkout>/packages/ui --cpu 4 --size 1920x1080@1.5
bun bench/ui-frames.ts --trace --only "typing,long thread scroll"   # layouts per window, and how many a script forced
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
filters off, `--ui` measures another checkout. `--trace` counts the layouts of
each window and those a script forced, numbers that hold on a busy machine;
`--profile <dir>` writes a CPU profile per scenario.

`bench/remote-browser-frames.ts` starts a scratch core and headless Chrome, plays
a desktop host that captures and shrinks frames as the shell does, and a paired
phone client that polls on the viewer's schedule behind an added latency.

Results: [bench/results/2026-10-03-remote-browser-frames.md](../bench/results/2026-10-03-remote-browser-frames.md),
[bench/results/2026-09-19-wire-and-startup.md](../bench/results/2026-09-19-wire-and-startup.md),
[bench/results/2026-09-30-ui-frames.md](../bench/results/2026-09-30-ui-frames.md),
[bench/results/2026-09-30-typing-and-scroll.md](../bench/results/2026-09-30-typing-and-scroll.md).

## The Windows sidecar is the signed runtime

Windows ships Bun's signed baseline runtime as `boite-core.exe`, with the core
JavaScript beside it. The baseline supports x64 CPUs without AVX2. Compiled
Linux/macOS sidecars and x64 server builds keep their platform packaging.
[Releasing](releasing.md#what-each-step-produces) owns runtime download,
checksum/signature validation and bundle layout.

The [dated runtime measurements](../bench/results/2026-09-29-resources.md#runtime-and-bundle-measurements-2026-09-19-to-2026-09-29)
retain the Windows compiled-versus-signed startup results, baseline comparison
and account-change bundle sizes. No corresponding Linux/macOS startup gain
was measured. Current emitted-size limits live in
[CI](ci.md#build-cost) and `scripts/ci/budgets.json`.
