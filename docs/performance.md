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
page is idle, so a PWA that goes offline later still has them in its cache.

The service worker still asks the core for the app shell first, but waits
2.5 s at most before serving the cached one; the late answer is stored for the
next open.

## Core startup

`fflate`, the unzip library behind provider installs and the local speech
runtime, is imported where it unzips. Evaluating it builds its Huffman tables,
about 8 ms per core start measured on 2026-09-25, for code most starts never
run. `packages/core/test/startup-imports.test.ts` fails if a static import
brings it back.

## Shell startup

The shell spawns the core before it builds the WebView2 window, and polls for
`core.json` every 10 ms instead of every 120 ms.

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
