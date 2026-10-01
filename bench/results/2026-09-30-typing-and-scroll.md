# Typing and scrolling, 2026-09-30

`bench/ui-frames.ts` on the fake client, headless Chrome with software
compositing, in a 16-thread Linux container that other jobs shared (load
average 6 to 21 during the runs). "Main" is `525be8f`, built with `--ui` from a
checkout of it; "branch" is this branch at `abe858d`. Two runs of each,
alternated. The typing scenarios press a key every 40 ms; a key's latency runs
from its keydown to the task after the next frame.

```sh
bun bench/ui-frames.ts --build <main dir> --ui <main checkout>/packages/ui
bun bench/ui-frames.ts --build <branch dir>
bun bench/ui-frames.ts --bundle <dir> --trace --only "<scenarios>"
bun bench/ui-frames.ts --bundle <dir> --cpu 4 --only "<scenarios>"
```

## Layouts in a 3 s window, CPU x1

Counted from the trace, so they hold whatever else the machine ran. In
brackets, the layouts a script forced.

| Scenario | Main, run 1 / run 2 | Branch, run 1 / run 2 |
|---|---|---|
| Typing, 64 to 67 keys | 192 (128) / 195 (130) | 66 (0) / 66 (0) |
| Typing at the end of a 9,000-character draft | 186 (124) / 186 (124) | 66 (0) / 65 (0) |
| Typing with a 1.5 MB picture in the draft | 228 (114) / 232 (116) | 130 (0) / 132 (0) |
| Typing while an answer streams | 235 (137) / 244 (143) | 123 (13) / 125 (11) |
| Phone typing, 390 x 844 at 2 | 192 (128) / 192 (128) | 67 (0) / 66 (0) |
| Wheel up a 400-message thread | 333 (309) / 331 (307) | 145 (46) / 153 (48) |
| The same while an answer streams | 236 (202) / 248 (216) | 132 (45) / 131 (43) |
| Phone, wheel up the 400-message thread | 248 (232) / 230 (215) | 106 (24) / 91 (16) |
| An answer streaming, nothing else | 72 (3) / 73 (5) | 72 (5) / 72 (8) |

Three layouts per key became one: two came from the composer measuring its
own height inside the input event, now `field-sizing: content`. On the
400-message thread main ran 333 layouts in about 180 frames: the outline rail
eased its active bar's width, which dirtied layout before every scroll event,
and the event's first read forced it. Easing a transform instead took the
count to 153 with nothing else changed. The picture draft keeps two layouts
per key, from the paint layer drawn over its text.

## Key latency, median / p95 in ms

| Scenario | CPU | Main | Branch |
|---|---|---|---|
| Typing | x1 | 16.4 / 22.0, 16.9 / 21.4 | 13.8 / 21.0, 15.5 / 21.2 |
| Typing | x4 | 22.5 / 29.9, 21.2 / 29.2 | 19.0 / 24.4, 18.7 / 23.1 |
| 9,000-character draft | x4 | 32.5 / 39.4, 26.4 / 31.8 | 21.8 / 27.1, 21.4 / 27.0 |
| 1.5 MB picture in the draft | x1 | 17.9 / 28.7, 18.4 / 27.6 | 16.9 / 21.6, 14.3 / 21.5 |
| 1.5 MB picture in the draft | x4 | 40.5 / 47.1, 40.1 / 46.9 | 19.3 / 23.9, 18.9 / 26.9 |
| While an answer streams | x4 | 33.5 / 46.8, 33.1 / 47.2 | 25.8 / 37.6, 25.6 / 38.4 |
| Phone | x4 | 21.4 / 31.2, 22.7 / 30.1 | 17.9 / 22.2, 16.9 / 22.1 |

With the picture at CPU x4, main handled 41 of the keys sent in the window
and the branch 57: every key had cloned the picture into IndexedDB
(`SerializedScriptValueFactory::create`, 83 ms of the x1 window), and the
durable journal now waits for a pause in typing. Main thread per second at
x4 went from 438 / 429 to 375 / 361 ms for plain typing and from 597 / 598 to
400 / 404 ms with the picture.

## Scrolling at CPU x4

A wheel up the 400-message thread drew 29.3 / 27.3 fps on main and 30.7 /
28.8 on the branch, the phone 21.9 / 23.5 and 24.0 / 22.9. Both keep the main
thread busy about 1,000 ms a second there, mounting the messages the window
reaches and rasterizing them in software: fewer layouts do not show as frames.

What a mount costs, from CPU profiles of the same wheel at x1 on unminified
builds of an earlier head of this branch: a user message 139 to 71 ms, its
action row 93 to 41 ms, icons 64 to 31 ms, all script 911 to 775 ms.

## Following an answer

`tests/e2e/chat-scroll.test.ts` reads the distance to the bottom after each
layout while an answer streams at the bottom. Main painted a new paragraph up
to 36 px below the fold before catching up, ten times a second at most; the
branch paints none (1 px or less).

## The streaming scenarios before this run

Until this run the streaming scenarios sent their prompt to the fake's most
recent thread, which already runs a turn, so the prompt waited in its queue;
and they measured 600 ms after sending, while the fake agent was still
reasoning over the prompt, folded. The streaming rows of
[2026-09-30-ui-frames.md](2026-09-30-ui-frames.md) measured no streamed text.
They now open an idle thread and start once two paragraphs are on screen.

## What this does not show

- A GPU. WebView2 with acceleration rasterizes on the GPU; these are its
  worst case.
- A phone. The phone rows are Chrome's mobile emulation on this CPU.
- Pointer-driven behavior: the hold under a finger or the scrollbar thumb is
  covered by reading the code, not by a test.
