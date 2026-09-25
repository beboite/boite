# Performance

What boite does to stay cheap on a slow link and quick to start, how each part
is measured, and the numbers of the last run. A claim about speed or size needs
a fresh run of the bench that covers it, with the command and the date.

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
- The trace is read when the trace surface is on screen, not on every open.

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

## Benches

```sh
bun run build:ui
bun run bench/bandwidth.ts --rtt 150          # bytes and time per scenario behind a delayed relay
bun run bench/bandwidth.ts --core <other checkout>/packages/core/src/main.ts --sequence sequential
bun run bench/startup.ts --exe <boite-shell.exe> --runs 7
```

`bench/bandwidth.ts` puts a TCP relay between the client and the core, counts
the bytes each way and delays each direction by half the round trip. `--core`
measures another checkout's core and the UI build beside it, and
`--sequence sequential` plays the client that checkout shipped. The bench
client sends a non-loopback `Host`, otherwise the core would treat it as local.

`bench/startup.ts` starts the hidden shell on a fresh data directory and a fresh
WebView2 profile, and reads the page's own timings over the debugging port.

Results: [bench/results/2026-09-19-wire-and-startup.md](../bench/results/2026-09-19-wire-and-startup.md).

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
