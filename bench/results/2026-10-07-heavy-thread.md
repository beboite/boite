# Scrolling a heavy thread, 2026-10-07

`bench/ui-frames.ts` on the fake client's `?fake=1&heavy=1` thread: forty
messages weighing 11.4 MiB, 4,109 tool calls, the last turn alone 1,307 of them
in one assistant message of 1,545 parts. Its shape is the one four real threads
of 15 to 23 MB showed that day: 4,000 to 6,200 calls each, runs of ten calls at
the median and 98 at most between two paragraphs, a call's output 365
characters at the median and 8.4 KB at the 90th percentile.

"Base" is `89556311` with the fixture and the bench of this branch added,
built with `--ui` from its own checkout; "after" is this branch. Headless
Chrome at 1280 x 890, in a 16-thread Linux container other jobs shared (load
average 6 to 7 during the software runs, 6 to 14 during the GPU ones). Each
figure is the median of five runs, base and after alternating. A scenario measures three seconds of
`requestAnimationFrame`. Main CPU is the main thread's own clock over that
window (`ThreadTime`), which holds on a busy machine; frame figures are
wall-clock.

```sh
bun bench/ui-frames.ts --build <base dir> --ui <base checkout>/packages/ui
bun bench/ui-frames.ts --build <after dir>
bun bench/ui-frames.ts --bundle <dir> --only "heavy thread scroll,heavy thread flick,heavy thread jumps,heavy scroll while streaming,phone heavy scroll,long thread scroll,scroll while streaming,phone long scroll"
bun bench/ui-frames.ts --bundle <dir> --gpu --only "heavy thread scroll,heavy thread flick,heavy thread jumps,heavy scroll while streaming,long thread scroll"
```

## Software compositing

| Scenario | Main CPU, ms in 3 s | Script, ms/s | Long tasks, ms | Worst frame, ms | Fps | Nodes under the scroller |
|---|---|---|---|---|---|---|
| Wheel up the long turn, 2,400 px/s | 1,895 to 784 | 377 to 55 | 0 to 0 | 33 to 33 | 57.3 to 58.7 | 3,271 to 849 |
| The same while an answer streams below | 1,845 to 906 | 309 to 64 | 0 to 0 | 33 to 33 | 50.4 to 59.0 | 3,382 to 935 |
| Six jumps across the thread, one every 450 ms | 1,100 to 552 | 190 to 70 | 825 to 56 | 133 to 50 | 46.0 to 57.0 | 343 to 331 |
| Flick, 20,000 px/s | 1,983 to 1,657 | 327 to 207 | 435 to 0 | 117 to 50 | 41.8 to 42.7 | 343 to 1,005 |
| Phone, 390 x 844 at 2, wheel up the long turn | 1,616 to 552 | 384 to 51 | 0 to 0 | 33 to 33 | 59.0 to 59.7 | 3,271 to 974 |
| Wheel up the 400-message thread | 878 to 870 | 73 to 66 | 0 to 0 | 50 to 50 | 59.0 to 59.0 | 238 to 238 |
| The same while an answer streams | 800 to 808 | 65 to 57 | 0 to 0 | 50 to 50 | 59.3 to 59.3 | 200 to 182 |
| Phone, wheel up the 400-message thread | 516 to 498 | 49 to 43 | 0 to 0 | 33 to 33 | 59.7 to 59.7 | 203 to 203 |

The node counts of the flick and the jumps are read where the gesture ended,
not where it cost the most: the base ends both on short messages.

The flick's window is three seconds of a gesture, not a distance. A second
series of five runs, under a load average of 7 to 17, read how far each build
got: 26,125 px for the base, held back by its long tasks, 47,326 px after,
for 2,142 and 2,005 ms of CPU. Per pixel covered the flick costs half.

## On the GPU

`--gpu`, ANGLE on the container's AMD Radeon, shared with other guests. Frame
rates there are bound by that sharing, not by the page: the 400-message thread
drew 14 to 20 fps before and after with the main thread two thirds idle. The
main thread's own figures still compare.

| Scenario | Main CPU, ms in 3 s | Script, ms/s | Long tasks, ms | Fps |
|---|---|---|---|---|
| Wheel up the long turn | 1,251 to 760 | 272 to 67 | 158 to 0 | 24.3 to 30.5 |
| The same while an answer streams below | 1,353 to 775 | 227 to 64 | 0 to 0 | 19.9 to 21.8 |
| Six jumps across the thread | 1,627 to 969 | 273 to 146 | 1,186 to 542 | 38.1 to 42.1 |
| Flick | 1,598 to 1,574 | 278 to 275 | 786 to 2,001 | 19.6 to 10.0 |
| Wheel up the 400-message thread | 648 to 649 | 82 to 89 | 246 to 176 | 13.9 to 19.6 |

The flick is the one row that reads worse, and it is not like for like: the
base covers about half the gesture in the window. Read with its distance in a
second series of five (load average 10 to 17), it went from 26,036 to
47,595 px for 1,637 and 1,653 ms of CPU, 834 and 669 ms of long tasks, 17.2
and 14.1 fps. After, a row mounts at nearly every frame of a flick, and each
of those frames waits for a commit on that GPU; the base mounts nothing
between two whole messages, then stalls on the next one.

## Beside t3code

The same conversation in pingdotgg/t3code at `e8545b293b`, mapped to its own
turn items (4,863, none dropped) and drawn by its `MessagesTimeline` in a
standalone production page: no server, sidebar, header or composer around the
timeline, which lowers its totals. Same Chrome flags, window size and
gestures, software compositing, medians of three runs under a load average of
8 to 14. t3code folds a settled turn behind one "Worked for" row by default,
so its folded thread is 8,293 px tall; "unfolded" has its last turn opened,
the state nearest to boite, which never folds a whole turn.

| Figure | t3code folded | t3code, last turn unfolded | boite base | boite after |
|---|---|---|---|---|
| Wheel up, main CPU ms in 3 s | 626 | 936 | 1,895 | 784 |
| Wheel up, script ms/s | 66 | 148 | 377 | 55 |
| Wheel up, nodes under the scroller | 1,226 | 499 | 3,271 | 849 |
| Six jumps, main CPU ms in 3 s | 619 | 770 | 1,100 | 552 |
| Six jumps, long tasks ms | 420 | 576 | 825 | 56 |
| Flick, main CPU ms in 3 s | 517 | 2,033 | 1,983 | 1,657 |
| Flick, long tasks ms | 256 | 1,276 | 435 | 0 |

t3code windows with `@legendapp/list` 3.3.5 and a row smaller than a message:
one call header, one paragraph, or one fold. boite's row is a message, or
forty parts of a long one.

## Where the time was

CPU profiles of `896208a7` (`--profile`, `BENCH_MINIFY=0`), three seconds of
wheel in a turn of 476 calls: 764 ms of script, 531 ms of it in the files card
(`visibleTurnFiles`), recomputed at every scroll event over every call of the
turns on screen because the window's slice was a new array each time. The
flick spent 432 ms mounting whole messages and 456 ms in the same files card.
After, the same wheel in the turn of 1,307 calls: 339 ms of script, 63 ms of
it parsing the paragraphs of the rows that enter and 74 ms reading the anchor.

## Checked in a browser

Headless Chrome on the GPU, this branch, 1280 x 890 and 390 x 844 at 2:

- 80 steps of 240 px up the long turn: what sits under the middle of the list
  moved by the step each time, 1.0 px off at worst (0.2 px on the base), and
  nothing on the page changed once the scroll rested.
- A turn written at the bottom, 420 parts one by one: the list stayed 0.0 px
  from its last line, with 4 rows of that message and 233 nodes on the page
  at the desktop size (680 on the base), 3 rows and 177 nodes at the phone's.
- Read from the middle of the long turn, another thread opened, then back: the
  same paragraph 286.4 px under the top of the list before and after, 294.0 px
  at the phone's size.
- The gap above a row that continues a message is 12.00 px, the gap a
  paragraph keeps inside a row. Captures of the base and of this branch
  aligned on one paragraph, at both sizes, differ by a device pixel or two on
  some lines and nothing else: 0.8 % of the pixels at the desktop size, 3 % at
  the phone's.

## Limits

- A real WebView2 on Windows was not measured. The GPU figures come from a
  shared GPU in a container, where the flick drew fewer frames after than
  before; whether a desktop GPU shows the same is open.
- The fixture's largest message has 1,545 parts; a real one had 3,106. The
  base's cost grows with the turn, since it mounted and read all of it; the
  rows drawn after do not.
- A flick still mounts every row it crosses: 1,657 ms of main-thread CPU in
  three seconds against 1,983, and in its profile 214 of 1,110 ms of script go
  to the layout the anchor read forces. No long task is left in software
  compositing; they remain on the shared GPU.
- A message with no paragraph in it is never cut: 3,000 calls in one run draw
  as one folded line, and opening that fold mounts every call.
- Opening the thread was not timed: on the fake client it measures the fake
  core's own byte counting of an 11 MiB page, 800 of 940 ms.
