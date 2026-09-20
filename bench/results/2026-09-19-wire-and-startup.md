# Wire and startup, 2026-09-19

Windows 11, Ryzen 7 9800X3D, Bun 1.4.2. "Before" is `main` at 21c1c06, built
and run from its own checkout; "after" is this branch. Same seed for the
conversation text in both runs.

## Bandwidth and latency behind a 150 ms round trip

```sh
bun run bench/bandwidth.ts --rtt 150 --sequence sequential --core <checkout of 21c1c06>/packages/core/src/main.ts
bun run bench/bandwidth.ts --rtt 150
```

Sixty threads in the sidebar, one 40 turn conversation of 250 words a turn, a
remote client. KB received by the client; static files fetched with
`accept-encoding: gzip, deflate, br, zstd` over plain http, so gzip.

| scenario | before KB | after KB | before ms | after ms |
| --- | ---: | ---: | ---: | ---: |
| page load, cold cache | 684.4 | 258.7 | 320 | 317 |
| every other script and stylesheet | 231.2 | 85.9 | 157 | 162 |
| connect, hello and the boot calls | 41.8 | 4.4 | 464 | 463 |
| open the 40 turn thread, whole sequence | 155.7 | 33.0 | 764 | 157 |
| open it, until the messages are in hand | | | 307 | 156 |
| one streamed turn of 250 words | 13.7 in 37 reads | 6.6 in 13 reads | 711 | 715 |
| a turn on a thread not subscribed | 5.1 | 3.2 | 561 | 560 |
| thirty seconds idle, connected | 0 | 0 | | |
| reconnect: hello, boot and the open thread again | 202.0 | 6.1 | 1222 | 614 |

"Reads" are receive callbacks of the relay, which TCP may split or join: they show the trend in frame count, not an exact one.

The page load row does not move in time because the relay delays but does not
cap throughput; on a link that does, the 426 KB less is the gain.

## Desktop startup

```sh
bun run bench/startup.ts --exe <boite-shell.exe> --runs 7
```

Release shell with its compiled core beside it, hidden, fresh data directory
and fresh WebView2 profile every run, medians of 7, ms after the spawn.

| spawn to | before | after |
| --- | ---: | ---: |
| core answering `/health` | 1304 | 1024 |
| first contentful paint | 594 | 621 |
| UI holding its data | 1411 | 1049 |

Of the 1024 ms left, 791 ms is the compiled core alone (spawned by hand, 7
runs), and about 650 ms of that passes before the process runs its first line:
see "Known cost" in [docs/performance.md](../../docs/performance.md).

## UI bundle

`bun run build:ui`, the entry chunk: 390.6 kB to 262.6 kB (gzip 121.3 to 81.2),
the entry stylesheet 117.7 kB to 91.3 kB.

## Idle core

`bun packages/core/src/main.ts` with no client, 30 s: 16 to 125 ms of CPU
across runs on both branches, under 0.5 % of one core. Nothing was changed
there.
