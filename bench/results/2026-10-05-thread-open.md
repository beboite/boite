# Opening a long thread, 2026-10-05

Measured with Bun 1.4.2 on Linux, a temporary real core and the echo provider,
headless Chrome at 1280x900. No provider login or existing conversation was
used. Each figure is the median of three runs.

```sh
bun run build:ui
bun run bench/thread-open.ts --runs 3
```

The fixture is one thread of 200 messages and 48.9 MB of parts, shaped like a
long thread from a working journal: a 1.1 MB PDF every eighth prompt, a
220x220 picture every 25th, 30 tool outputs per answer with one in ten at
60,000 characters. A second, short thread is opened first, then the long one.
"Relay" is a TCP relay that holds each direction for 75 ms and a client that
reached the core by name, so frames are deflated; its KB are bytes on the
wire. "Throttled" is Chrome's network emulation at 150 ms and 10 Mbit/s.

## Main at 1fe90f9f

| Measure | ms | KB |
| --- | ---: | ---: |
| `threads.get`, whole last page, loopback | 248 | 12,045 |
| `threads.get`, whole last page, relay | 837 | 6,576 |
| First page (40 messages, compact tools and files), loopback | 100 | 1,494 |
| First page, relay | 347 | 508 |
| Click to first message, loopback, 3 of 3 opened | 249 | |
| Click to first message, throttled, 3 of 3 opened | 2,568 | |

## This branch

| Measure | ms | KB |
| --- | ---: | ---: |
| First page, loopback | 138 | 1,494 |
| First page, relay | 351 | 508 |
| First page with `compactImages`, loopback | 126 | 1,305 |
| First page with `compactImages`, relay | 318 | 361 |
| Same page `around` the 101st of 200 messages, loopback | 115 | 1,305 |
| Same page `around` the 101st of 200 messages, relay | 333 | 362 |
| Click to first message, loopback, 3 of 3 opened | 331 | |
| Click to first message, throttled, 3 of 3 opened | 2,140 | |

The whole-page loopback call took 285 ms on this run against 248 ms on main
with unchanged code for that path: the machine was shared with other builds,
and loopback differences under 100 ms are within that noise. The throttled
click, where bytes dominate, went from 2,568 to 2,140 ms with the 147 KB the
deferred picture no longer sends.

## Before main's compact snapshots (7af3ce17)

The same fixture on the core before compact pages: each `threads.get` carried
30,397 KB of JSON, 16,906 KB through the relay in 1,622 to 2,394 ms. In the
last run no click opened the thread, 0 of 8 on loopback and throttled alike.
The instrumented page showed the long thread's `threads.get` sent and never
answered: Bun's `send` returns 0, a dropped frame, for a 31 MB frame with
29.8 MB already buffered, the core closed the socket, and the reconnect
reopened the thread still on screen. Chunked answers keep a long page off that
path: its slices wait for the socket to drain, at most 1 MiB ahead.
