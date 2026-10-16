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

## Core recordings of a moving page

`nice -n 10 bun bench/browser-recording.ts --runs 3 --seconds 10
--ffprobe <ffprobe>` (and `--frame-rate 60 --seconds 6`), back to back with
`origin/main`'s `packages/core/src/browser/recorder.ts` and with this branch's,
same container, Bun 1.4.2, Chrome 153 headless, ffprobe N-66595 static. The
page is 1920 × 1080 CSS with a spinning 300 px disc. Frames are counted with
`ffprobe -count_frames` over the MP4 the recording returned; frames/s is
frames over the file's duration. Chrome CPU as above. The container's load
average was 21 to 26 on 16 threads (other jobs ran at the same time).

| Take | Frames/s (median of 3) | Chrome CPU |
| --- | --- | --- |
| 30 fps, 10 s | 19.7 -> 29.4 | 453 % -> 339 % |
| 60 fps, 6 s | 18.7 -> 26.9 | 460 % -> 524 % |

Per take at 30 fps: before 196, 196, 194 frames in 9.97 to 9.98 s; after
293, 296, 275 frames (the last in 9.37 s, during a load spike). A second run
of the branch gave 297 frames in 9.99 to 10.00 s three times (29.7
frames/s, Chrome 336 %). At 60 fps the branch draws more frames and Chrome
works more for them; some takes lost their last 0.4 to 0.8 s when the
encoder fell behind.

Decoding one frame in the page (a 1920 × 1080 q80 JPEG, 351,232 base64
characters, mean of 20, two runs):

| Way | Base64 to bytes | Bytes to bitmap included |
| --- | --- | --- |
| `Uint8Array.from(atob(...), fn)` | 19.1, 17.8 ms | 33.6, 31.1 ms |
| `Uint8Array.fromBase64` | 0.26, 0.23 ms | 12.6, 12.0 ms |
| `fetch('data:...').blob()` | | 17.7, 16.5 ms |

The recorder uses `Uint8Array.fromBase64` and keeps the per-byte copy for an
engine without it.

Unmeasured, the work is removed: `Network.enable` with zero buffers (Chromium
keeps no response body for a tab), network events relayed by the desktop app
cut to the fields the core reads, and request addresses stored bare without
`data:` and `blob:` ones.
