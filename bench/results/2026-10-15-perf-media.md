# Static files, views and the service worker, 2026-10-15

Linux container, Bun 1.4.2. Before is `origin/main` at `3202e281` (an
archive with its own `bun run build:ui`), after is `boite/perf-media`. Both
ran the branch's `bench/bandwidth.ts`, back to back, three runs each, at
`nice -n 10`:

```sh
bun run build:ui
nice -n 10 bun run bench/bandwidth.ts --rtt 150 --core /tmp/perf-media-base/packages/core/src/main.ts --json before-N.json
nice -n 10 bun run bench/bandwidth.ts --rtt 150 --json after-N.json
```

## Static rows

Medians of three. Bytes were identical across the runs of each side.

| scenario | before KB down | after KB down | before ms | after ms |
| --- | ---: | ---: | ---: | ---: |
| page load, cold cache (html, js, css, fonts, manifest, worker) | 549.1 | 549.7 | 330 | 335 |
| page load again, warm HTTP cache, no service worker | 149.5 | 0.6 | 305 | 305 |
| every other script and stylesheet | 535.1 | 535.1 | 171 | 170 |

The second row is the next open of a phone on plain http, where no service
worker registers: a fresh file is not asked for, a file with a validator is
revalidated, a file with neither is fetched whole. Before, the shell, the
manifest, the worker and the two default fonts (Inter-latin 72,920 B,
GeistMono-Variable 71,368 B) came back whole. After, the shell, the manifest
and the worker are 304s and the fonts are fresh for a day. The time does not
move: a 304 is still one round trip.

The cold row gains 0.6 KB: the `ETag` and `Last-Modified` headers of the
files outside `/assets/`. Hashed assets carry no validator, since they are
immutable and never revalidated. A first try that tagged them too cost
4.8 KB on the cold row and 7 KB on the lazy row.

The bench changed with this branch. `staticLoad` now reads only `src` and
`href` attributes, as the worker precaches, and fetches the two default fonts,
which index.html names in a script. Before the change it counted the French
catalogue (`strings.fr-*.js`, 40,886 B br) that an English load never fetches,
and missed the fonts.

## Service worker precache

`tests/e2e/ui.test.ts`, "the service worker caches the shell", in headless
Chrome at `--lang=en-US`: on `origin/main` the worker's cache holds
`/assets/strings.fr-BDQqlfG0.js`; on the branch it does not. That is
40,886 B br (47,767 B gzip, 144,116 B raw) less per worker install on a device
that does not read French.

## Views

Snapshot size, raw against the `.gz` written at publication (`gzip -9`),
from `viewDocument` in packages/contracts/src/view.ts:

| page | raw B | gzip B |
| --- | ---: | ---: |
| a one-line page (the wrapper alone) | 16,615 | 4,778 |
| a 200-row table | 26,679 | 6,402 |

Every mount of a view sends the gzip to a client that accepts it. Not measured
over a real link.

## Display copy of a picture

`messages.attachment` with `display` on a picture whose WebP copy is already
kept: 50 calls of `readMessageAttachment` after 10 warm-up calls, in a test
core with a fresh data directory. The picture is a 1600x900 PNG of 3.2 MB
(4,332,108 base64 characters), its copy 30,916. Before is the handler of
`3202e281`, which reads the message part first; after is the branch's, which
reads the copy by message, part and thread first. Three runs each, back to
back, `nice -n 10 bun <script> before|after` from `packages/core`:

| | before | after |
| --- | ---: | ---: |
| median per call, ms (median of 3 runs) | 3.908 | 0.075 |
| 50 calls, ms (median of 3 runs) | 227.2 | 3.7 |

## Attaching a large opaque screenshot (not changed)

Encoding the PNG and the JPEG of an opaque picture at once instead of one
after the other was tried and dropped. In headless Chrome at a 4x CPU slowdown,
on a 1920x1080 canvas: PNG `toBlob` 170 ms, JPEG 122 ms, both started together
290 ms (medians of 5). Chrome runs the two encodes one after the other anyway,
and starting both holds two canvases in memory at once.

## Diagnostics live poll

`DiagnosticLogs.query({ since: now - 5000, limit: 200 })`, the query the
Diagnostics page sends every 3 s, over 8 full 2 MiB `core.N.ndjson` files whose
modification times are one hour apart. Ten calls after one warm-up, three
runs each, back to back, `nice -n 10 bun logs-poll.ts <logs.ts>` (a throwaway
script that writes the files in a fresh temporary directory). Before is
`logs.ts` of `3202e281`, after the branch's, which opens no file last written
more than 10 minutes before `since`.

| | before | after |
| --- | ---: | ---: |
| poll, ms (median of 10, median of 3 runs) | 481.9 | 57.1 |
| first 1 h page that fills its limit, ms | 65.3 | 59.7 |

## Log records kept in memory

Heap after 4,096 `logs.debug` calls (short `process.started` records, flushed
every 512), measured with `heapStats().heapSize` after `Bun.gc(true)` before
and after, three runs each, `nice -n 10 bun logs-heap.ts <logs.ts>`. Before,
memory kept the last 4,096 records; after, only those the files do not hold.

| | before | after |
| --- | ---: | ---: |
| heap growth, KiB (median of 3) | 2,125 | 169 |

## Core start: RSS at ready

The bundled core (`bun run --cwd packages/core build`), started with
`bun packages/core/dist/main.js --data-dir <fresh> --port 0` and
`BOITE_HOST_AGENTS=0` until it prints `boite-core ready`; RSS read from
`/proc/<pid>/status` at that line and 3 s later. Five starts per run, three
runs, `nice -n 10`. After keeps `node:util` and `node:dns` out of the startup
graph and parses the recommended plugin list on first use. Load average was
17 to 21 during both, so the ready time is noise.

| | before | after |
| --- | ---: | ---: |
| RSS at ready, MiB (median of 3 runs) | 59.1 | 57.6 |
| RSS 3 s after ready, MiB | 58.5 | 56.9 |
| ready, ms | 131.7 | 139.8 |

## Linux server binary cold start

`BOITE_ALLOW_BUN_MISMATCH=1 bun run build:core:linux` (this machine has Bun
1.4.2, the pin is 1.4.3; both builds used 1.4.2), then the same start-to-ready
script on `dist/boite-core-linux-x64`, seven starts per run, three runs,
`nice -n 10`. "Without bytecode" is the branch's sources compiled with the
old flags, to separate the two changes.

| | before (`3202e281`) | branch, without bytecode | branch, `--bytecode --format=esm` |
| --- | ---: | ---: | ---: |
| ready, ms (median of 3 runs) | 225.1 | 259.0 | 83.1 |
| RSS at ready, MiB | 70.0 | 69.1 | 71.5 |
| RSS 3 s after ready, MiB | 65.7 | 65.5 | 71.3 |
| binary, bytes | 85,485,024 | 85,485,024 | 99,345,888 |
