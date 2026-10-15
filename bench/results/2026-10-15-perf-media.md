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
