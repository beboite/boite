# Timeline rendering, 2026-10-15

Base `3e535df3`. Container with 16 shared threads, load average about 6 during
the runs. Headless Chrome composited on the AMD GPU through ANGLE (`--gpu`
checks the renderer is not a software one).

## Files card while a turn streams

Each closing row now reads its own turn, a finished turn compares part
identities before any field, and the last 24 turns read stay cached.

```sh
BENCH_MINIFY=0 nice -n 10 bun bench/ui-frames.ts --build <dir>
nice -n 10 bun bench/ui-frames.ts --gpu --bundle <dir> --profile <out> --only "heavy scroll while streaming"
```

Three runs each, before and after interleaved. Inclusive CPU time of the files
derivation in the 3 s window: `visibleTurnFiles` before, `filesOf` after (both
include `TurnFileCache.read`).

| | runs (ms) | median (ms) |
|---|---|---|
| before | 42.9, 73.7, 34.8 | 42.9 |
| after | 30.4, 32.4, 74.7 | 32.4 |

Main-thread CPU of the window, from the same runs: 823, 1,039, 887 ms before
(median 887), 994, 918, 791 ms after (median 918): within the noise of the
machine. Every remaining `turnFiles` sample after the change sits under the
first creation of a turn end's block (a turn end scrolled into view for the
first time); none comes from a part arriving on the running turn.

## Highlighting a diff

`highlightCode` on the first 800 lines (39,420 characters) of
`MessageList.svelte`, grammar already loaded, two calls on the same text.
Five runs each with `nice -n 10 bun <script> <module>`.

| | first call median (ms) | second call median (ms) |
|---|---|---|
| before | 111.4 | 84.4 |
| after | 127.5 | 0.09 |

The first call is unchanged within noise. A diff that also has no removed line
now skips the old side entirely, and a mount waits for an idle moment (300 ms
at most) before it highlights.

## Line diffs

`diffRowsOf` and `diffCountsOf` keep rows and counts per document object. A
tool card's counts, its opened diff and the turn's files card now read one
diff per document instead of up to three per mount. Unmeasured end to end:
work removed.

## Streaming deltas: part runs and thought titles

The runs of a message no longer read the streaming last text, a run over the
same parts stays the same object, and a live thought's title resumes after its
last complete line instead of rereading the whole thought.

```sh
BENCH_MINIFY=0 nice -n 10 bun bench/ui-frames.ts --build <dir>
nice -n 10 bun bench/ui-frames.ts --gpu --bundle <dir> --profile <out> --only "streaming answer"
```

Three runs each, before and after interleaved, inclusive CPU time in the 3 s
window from the profile.

| | `memoryPartRuns` (ms) | `thoughtTitle` (ms) | main ms/s | script ms/s |
|---|---|---|---|---|
| before | 5.8, 3.6, 8.1 (median 5.8) | 7.4, 11.0, 8.4 (median 8.4) | 333, 329, 303 (329) | 61, 48, 53 (53) |
| after | 0, 0, 0 | 0, 0, 0 | 282, 302, 287 (287) | 34, 52, 33 (34) |

After the change neither function has a single sample in the window: the runs
are rebuilt only when a part arrives.

In bun, a 20,000-character thought of headed sections grown by 40-character
deltas, one title per delta (`nice -n 10 bun <script> <module>`, three runs
each): 28.4, 23.8, 43.2 ms in total before (median 28.4), 4.3, 8.0, 3.6 ms
after (median 4.3). A test compares the scan with the whole-text rule on every
prefix of each case, one character at a time.

## Markdown links

`renderMarkdown` on one line, plain and rich, three runs each with
`nice -n 10 bun <script> <module>`, medians in ms:

| line | before plain | before rich | after plain | after rich |
|---|---|---|---|---|
| 32,000 `[` | 1,460.8 | 2,914.0 | 1.8 | 1.4 |
| `[a` x 16,000 | 760.5 | 1,509.0 | 0.15 | 0.60 |
| `[a](<` x 6,000 | 0.49 | 278.3 | 1.0 | 4.9 |
| `[a](http://` x 3,000 | 143.9 | 0.20 | 1.9 | 1.4 |
| `[a](b) ` x 4,000 | 0.11 | 11.0 | 0.62 | 13.0 |
| 300 lines of prose with links | 3.1 | 7.4 | 3.1 | 11.2 |

Ordinary text pays a little more, about 1 to 3 microseconds a line, close to
the noise of the machine (load average about 30): 3,000 renders of one prose
line with two links took 84.0 and 84.8 ms before, 88.1 and 95.6 ms after. A
text without `](` never builds the scanner. 100,000 random lines over brackets, parentheses,
schemes and spaces render the same markup before and after.

## Tool group shimmer

The running group's label moves its gradient in `steps(30)` instead of
`linear`. Measured on a page holding that one label with the same rules,
Chrome 153 on ANGLE AMD, a 2.2 s trace of `devtools.timeline`, three runs each:
Paint events 258, 254, 252 before (median 254), 60, 60, 62 after (median 60);
paint time 34.7 ms before, 6.8 ms after (medians). Style recalculations stay
at about 130 a sweep.

## Closed folds

`content-visibility: hidden` on a closed fold's body, applied when the close
transition ends. Frame by frame in Chrome 153, the open and close heights of a
fold match the old ones to the pixel (one frame rounds 46 instead of 47 px),
and a `ResizeObserver` inside the body reports no size change on close or
reopen. Unmeasured end to end: the body's style and layout are skipped, work
removed.
