# Performance

What boite does to stay cheap on a slow link and quick to start, how each part
is measured, and the numbers of the last run. A claim about speed or size needs
a fresh run of the bench that covers it, with the command and the date.

## Concurrent-agent resource use

The [2026-09-29 audit](../bench/results/2026-09-29-resources.md) compares the
streaming journal, team refreshes, process sampling and idle core against
`606bc56d`. On the tested Linux workloads, journal CPU fell from 8,863 to 379 ms and
sampled peak RSS from 253.24 to 109.21 MiB. Sampling 64 processes with the real
clock used 964 to 458 ms CPU and 94.97 to 82.13 MiB peak RSS. Team updates used
348 to 116 ms CPU, with 128 snapshots reduced to one. The idle core stayed at
about 60 MiB and 0.4% of one CPU core. These are scoped measurements,
not a 30% to 50% reduction in the whole application or its provider processes.

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
The smaller six-process regression runs in the normal core suite and starts a
fresh core so earlier tests cannot hide a race in first-use imports.

Authenticated RPC requests rotate between connections in four-millisecond
slices. At most eight handlers per connection and 64 overall can wait on
asynchronous work. Each connection retains at most 1,024 frames or 32 MiB of
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
Sidebar pull-request lookups share requests for the same thread and run four
at a time per client. A manual refresh goes ahead of background lookups, so
mounting or remounting thousands of rows cannot flood the RPC connection.

Initial measurements on Windows with Bun 1.4.2, 2026-09-29, before scheduler
launch limits were retired:

| Scenario | Observed result |
| --- | --- |
| 24 scripted agents, cold then warm turns | Initially 38 processes instead of 24; sharing the pending driver load kept all 24 warm processes |
| 1,000 echo threads, one observer, initial baseline | Both streaming bursts completed with exact answers; all 1,000 turns cancelled and recovered after a crash |
| Same baseline, core memory at 64 concurrent turns | 115.8 MiB; this excludes real agent processes |
| Same baseline, scheduler payloads | 163.3 MiB of decoded scheduler JSON on one connection during the 64-turn burst |
| 1,000 threads and 12 additional readers before request pacing | Three HTTP requests timed out after ten seconds each; turn-start requests exceeded thirty seconds |
| Same load after bounded dispatch and snapshot coalescing | Both bursts passed with exact streams; six concurrent turns took 60.0 s and 64 took 59.4 s |
| Same run, independent health | No timeouts; p95 217/660 ms and maximum 1.81/3.51 s at six/64 concurrent turns |
| Same run, scheduler payloads at 64 concurrent turns | 7.0 MiB of decoded JSON on the owner connection |
| Same run, mass cancellation and crash recovery | All 1,000 turns cancelled in 19.5 s; 64 running and 936 queued turns recovered after an 8.1 s restart |
| Production UI, 1,000 threads and a 256-turn burst | Foreground reply in 0.99 s, typing in 3.7 ms and maximum timer lag 36 ms; desktop and phone checked |

After launch limits were retired, the same command with 12 additional readers
passed on 2026-09-30 after grouping synchronous startup and completion writes:

| Scenario | Observed result |
| --- | --- |
| 1,000 threads, workloads bounded by the generator | Exact streams at six/64 concurrent turns in 40.8/18.3 s |
| Independent HTTP health during streaming | Zero errors; p95 58/131 ms and maximum 1.84/0.16 s at six/64 concurrent turns |
| Scheduler payloads at 64 concurrent turns | 1.09 MiB of decoded JSON on the owner connection; no scheduler queue in this workload |
| All 1,000 turns running together, cold then already used | Starts accepted in 10.2/10.6 s and cancelled in 9.7/6.1 s with the 30-second RPC deadline unchanged |
| Independent HTTP health during mass start/stop | Zero errors; p95 117/109 ms and maximum 3.27/0.15 s for cold/warm phases |
| Crash with 1,000 running turns | All recovered, earlier answers and both cancellations preserved, and a new turn completed after a 3.0 s restart |
| Production UI, 2026-09-30, 1,000 threads and a 256-turn burst | Foreground reply in 0.68 s, typing in 3.3 ms and maximum timer lag 26 ms; desktop and phone checked |

Two additional runs exceeded the 30-second deadline during 1,000 simultaneous
starts. The instrumented failure accepted 505 starts before expiry, with no
HTTP errors and maximum health latency 1.00 s. The full run above then passed
with the same deadline. Background machine load was not controlled. These runs establish
failures and reproducible checks. They do not
establish a supported agent count or measure real provider quotas, agent RAM,
the native shell, Linux or macOS under this load.
The UI test gives background RPCs the benchmark's 30-second deadline, while
the application uses 120 seconds. Visible replies keep a 30-second deadline;
typing and individual browser tasks must stay below five seconds. Foreground
timing excludes the separate wait for the background batch to be accepted.

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

## A remote client and a local one are not served alike

The core decides per connection. A WebSocket whose `Host` header is
`127.0.0.1`, `localhost` or `::1` is the shell or a browser on the same
machine: its bytes are free and its CPU is not, so nothing is compressed and
every delta leaves at once. Any other `Host` is a phone or a laptop somewhere
else, and gets two things.

- Every frame is deflated. Bun runs permessage-deflate without context
  takeover, which takes a 30 KB JSON answer to 1.6 KB. The mode with a shared
  context was measured too and rejected: on Bun 1.4.2 it shrinks small frames
  ten times but only Huffman-codes a large one, 30 KB to 20.9 KB.
- `message.delta` events are held for 80 ms and joined per message part. A
  small deflated frame keeps about 84 % of its size, so fewer and larger frames
  are what saves bytes while text streams. Held deltas always leave before any
  other event and before any response, so the order on the wire stays the order
  of the turn.

When a socket backs up (Bun's `send` returns -1), every frame is still queued
except `message.delta`, which is dropped. On `drain` the core resends the text
parts those deltas belonged to, one `message.part` each, and nothing else: a
finished tool output in the same message never goes out twice. Deltas the bus
still holds are dispatched before that resend, so they fold into the part
instead of arriving after it as a second copy.

## What the UI asks for

- `Store.open` writes subscribe, `threads.get`, `permissions.list` and
  `questions.list` in one burst instead of one round trip each.
- `threads.get` takes `after`, a message the client already holds. The answer
  then starts at that message and says so in `messagesFrom`; the UI keeps what
  it had before it. A reconnect to a quiet thread costs one message instead of
  the last 120. An unknown message, or a tail longer than a page, gets the whole
  page as before.
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

A frame has to be drawn again wherever something moved, and some styles make
that redraw expensive for as long as they are on screen. Measured on
2026-09-30 with `bench/ui-frames.ts`, in headless Chrome with software
compositing, the case a WebView2 without acceleration meets:

- A backdrop blur is redrawn whenever anything under it moves. A window-wide
  one under the command palette or the tour, over a streaming answer or an
  animated scene, drew 6 to 12 fps instead of 60. Scrims are a flat
  `--color-scrim` tint; a blur stays on the bounded floating surfaces (the
  composer, the activity panel, toasts, notification and update cards), where
  it measured no cost even with a 401 px activity panel over a scrolled thread.
- An endless animation moves only opacity or a transform, which the
  compositor plays without painting. The two exceptions repaint a box a few
  pixels high and are named in the test.
- A `:has()` never takes the app's outer containers for its subject: it is
  checked again whenever that subtree changes, which is every node a streaming
  answer or a scroll mounts. A class set from the state does the same job.
- An entrance animation belongs to what arrives live. A paragraph eases in
  only while its answer streams, and a message rises only when it lands at the
  bottom being watched, not when a scroll up the history mounts it again.
- Scrolling reads layout as little as it can: the outline rail follows once
  per frame, and a message's height comes from its `ResizeObserver` entry. A
  wheel up a 400-message thread went from 340 to 310 ms of main thread per
  1,000 px. The reading anchor is still read right after each scroll event,
  once the window has rendered: read before that render, or a frame or a timer
  later, a navigation that left the thread right after a scroll brought it
  back on the wrong message.
- The conversation watches the wheel with a passive listener. It only reads
  the wheel to leave the bottom and never cancels it; a cancellable listener
  made the browser ask the main thread before the first notch of each gesture
  scrolled, which a streaming answer keeps busy. `MessageList.test.ts` fails
  on a wheel listener that can cancel.
- What a scroll changes eases only a transform or opacity. The outline rail's
  active bar eased its width, and the active prompt changes every few lines:
  that dirtied layout before every scroll event, and a wheel up the
  400-message thread ran 333 layouts in about 180 frames. Easing a transform
  took it to 153. The rail keys its two groups by side, so the prompts a
  scroll passes rewrite them instead of rebuilding them.
- A message mounts cheaply, because a scroll mounts one every few lines.
  Lucide icons draw through `LucideGlyph.svelte`, which clones shapes built
  once per icon instead of spreading attributes on each one; date formatters
  are built once per language; a finished paragraph's markup is kept, up to
  four million characters. In a CPU profile of the same wheel, mounting the
  user messages took 71 ms instead of 139.
- A keystroke lays the page out once. The composer sizes itself with
  `field-sizing: content` where the engine has it; measuring its own height
  inside the input event made three layouts per key. The IndexedDB draft
  journal waits for a pause in typing: writing it on every key cloned a draft
  picture each time, and at CPU x4 a key with a 1.5 MB picture took 40 ms to
  reach the screen instead of 19.
- A conversation at its bottom follows its answer from its `ResizeObserver`,
  after layout and before paint, so a paragraph lands already in view. Caught
  up ten times a second, it was painted up to 36 px below the fold first.

`packages/ui/src/render-cost.test.ts` fails on a blur outside the named
surfaces or on any `inset: 0` rule, on an endless animation of anything else,
on a `:has()` on `html`, `body`, `#app`, `.app` or `.body`, and on an outline
bar that eases its width.

## Browser tools and review bundle size

Measured on Windows with Bun 1.4.2 on 2026-10-02, using `bun run build:ui`
for both `83ae9b4` and the browser tools, recording, linked PR review and remote
preview changes. Totals exclude precompressed `.br` and `.gz` copies, as
`bun scripts/ci/budgets.ts` does.

| Build | UI entry | Complete UI |
| --- | ---: | ---: |
| `83ae9b4` | 407,290 bytes | 3,751,358 bytes |
| Browser tools and remote review | 477,796 bytes | 3,835,198 bytes |

The added dialogs, browser controls, recording encoder support and translations
add 83,840 bytes (2.23%) to the complete UI. The WebM duration parser loads only
when finalizing a recording. The total UI budget increases by 84,000 bytes to
3,880,000, retaining the previous headroom; entry and core budgets are unchanged.

## Benches

```sh
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

Results: [bench/results/2026-09-19-wire-and-startup.md](../bench/results/2026-09-19-wire-and-startup.md),
[bench/results/2026-09-30-ui-frames.md](../bench/results/2026-09-30-ui-frames.md),
[bench/results/2026-09-30-typing-and-scroll.md](../bench/results/2026-09-30-typing-and-scroll.md).

## The Windows sidecar is the signed runtime

`bun build --compile` writes an 86 MB executable with no signature, and Windows
11 inspects it at every start: about 650 ms pass between the spawn and the
first line of script, 5 ms of it inside the process, and a compiled hello-world
costs the same. The Bun runtime carries its publisher's signature and skips
that. So the Windows installer ships the runtime as `boite-core.exe` with the
bundled core in `core/` beside it ([releasing.md](releasing.md)). Renaming the
runtime changes nothing: the signature is in the file.

Core alone, spawn to `/health`, medians of 7, 2026-09-19. The parent is a
second copy of the runtime, because a child whose image the parent already has
mapped starts in 105 ms and would flatter the result:

| core started as | ms |
| --- | ---: |
| compiled `boite-core.exe` | 902 |
| runtime copied as `boite-core.exe`, running `dist/main.js` | 260 |

`bun run bench/startup.ts --runs 7`, medians, on a release shell with the
compiled core beside it, then on one staged with the runtime and the bundle:

| spawn to | compiled | runtime and bundle |
| --- | ---: | ---: |
| core answering `/health` | 1215 | 559 |
| first contentful paint | 749 | 604 |
| UI holding its data | 1245 | 716 |

Linux and macOS keep the compiled core: nothing was measured there.

## The x64 runtime is Bun's baseline build

Bun publishes two x64 builds. The default one needs AVX2, so it stops with an
illegal instruction on a pre-Haswell CPU and on many Celeron, Pentium and Atom
laptops. The Windows sidecar, the compiled core on x64 Linux and Windows, and
the server core are the baseline build, and the Docker image's `oven/bun` base
already ships the baseline build for x64. On this core the choice costs nothing
measurable. Bundle under each runtime, both runtimes copied away from the
parent's own image, a fresh data directory, `BOITE_HOST_AGENTS=0`, 2026-09-25 on
a Ryzen 7 9800X3D:

| runtime | spawn to `/health`, median of 6 | echo turn round trip, median of 7 |
| --- | ---: | ---: |
| `bun-windows-x64` 1.4.2 | 245 ms | 162 ms |
| `bun-windows-x64-baseline` 1.4.2 | 244 ms | 162 ms |

The echo turn is `docker/smoke.ts create` run against that core with
`BOITE_SMOKE_PROVIDERS=echo`: project, account, thread, one turn and its
completion. Local dictation's whisper.cpp runtime needs no AVX2 either: its
`whisper-bin-x64.zip` ships `ggml-cpu-*.dll` backends from plain x64 to Alder
Lake, and ggml loads the one the CPU supports.

The bundle and the compiled core minify whitespace and syntax and keep
identifiers, so a logged stack still names its functions. On the Windows
sidecar that moved spawn to `/health` from a median of 249 ms to 244 ms over 7
runs on the same day. The compiled core also carries bytecode, which saves
parsing where no signature check dominates the start; on Windows the compiled
core stayed at about 790 ms either way.

The account connection changes measured on Windows CI on 2026-09-29 use
525,128 bytes for the UI entry chunk, 3,396,864 bytes for the UI distribution
and 821,226 bytes for the core bundle. Account editing and device-login UI
add client code; native authentication checks add core code. The size budgets
in `scripts/ci/budgets.json` retain about 10% headroom above those measurements.
