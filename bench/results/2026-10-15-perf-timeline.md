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
