# Agent browser frames from a screencast, 2026-10-15

`nice -n 10 bun bench/remote-browser-frames.ts --rtt 0,80,200` and the same
with `--still`, three runs each, back to back on `origin/main` (3202e281) and
on this branch, on the Linux container `boite` (Ryzen 7 5825U shared with other
guests), Bun 1.4.2, Chrome 153 headless. The page is 1200x1300 CSS, frames are
asked at 780 px, 8 s per row. The viewer follows `nextPollDelay` and names the
frame it shows (`after`); `origin/main` ignores `after`. Chrome CPU is the
utime and stime of the Chrome processes of the run's profile, from /proc.
Values are medians of the three runs, for the viewer's current schedule.

On `origin/main`, each frame is a `Page.captureScreenshot` with a scaled clip.
On this branch, it is the newest picture of a screencast on a second DevTools
session of the tab.

## Still page (`--still`)

| Added RTT | Frames/s | Base64 KiB/s | Chrome CPU | Trip |
| --- | --- | --- | --- | --- |
| 0 ms | 1.3 -> 0.1 | 163 -> 15 | 8 % -> 0 % | 54 -> 2 ms |
| 80 ms | 1.8 -> 0.1 | 224 -> 15 | 12 % -> 2 % | 132 -> 83 ms |
| 200 ms | 1.3 -> 0.1 | 163 -> 15 | 7 % -> 0 % | 248 -> 203 ms |

The branch sends one frame per row, the first one (126 KiB in 8 s), then 0.6
`unchanged` answers a second of a few dozen bytes each. On `origin/main` the
scaled captures of the still page differ, so the viewer rarely slows down.

## Moving page

| Added RTT | Frames/s | Base64 KiB/s | Chrome CPU | Trip |
| --- | --- | --- | --- | --- |
| 0 ms | 4.0 -> 4.0 | 509 -> 502 | 35 % -> 34 % | 74 -> 2 ms |
| 80 ms | 4.0 -> 4.0 | 509 -> 501 | 36 % -> 38 % | 158 -> 83 ms |
| 200 ms | 3.6 -> 4.0 | 464 -> 502 | 33 % -> 33 % | 275 -> 203 ms |

The frame rate stays capped at four a second by the viewer's 250 ms spacing.
The trip loses the capture, about 72 ms here. A first version acknowledged
every waiting picture on each take; Chrome then encoded two pictures per frame
taken and used 44 to 47 % of a core on the moving page. Keeping one picture
unacknowledged brought it back to the numbers above.
