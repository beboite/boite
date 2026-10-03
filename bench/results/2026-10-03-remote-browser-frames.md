# Remote browser frames, 2026-10-03

`bun bench/remote-browser-frames.ts --rtt 0,80,200,400` on Windows 11, Bun
1.4.2, headless Chrome at 1200x1300 CSS and device scale 1.5 (a PC panel),
frames shrunk to 780 px (a 390 pt iPhone at 2x), 8 s per run. The page
animates, so every frame changes. Latency is added on the phone client's side;
bandwidth is not limited and the phone's own decoding is not measured.

"before" is the viewer up to this change: a fixed 300 ms pause after each frame
(500 ms past a 600 ms trip) and a q90 capture before shrinking. "after" asks
again once 250 ms have passed since the last request, and captures at q75.

| Added RTT | Before | After | Trip before / after | Desktop capture and shrink before / after |
| --- | --- | --- | --- | --- |
| 0 ms | 2.4 frames/s | 4.0 frames/s | 131 / 114 ms | 123 / 106 ms |
| 80 ms | 2.0 frames/s | 4.0 frames/s | 221 / 208 ms | 135 / 121 ms |
| 200 ms | 1.6 frames/s | 3.3 frames/s | 344 / 308 ms | 137 / 101 ms |
| 400 ms | 1.3 frames/s | 1.9 frames/s | 535 / 528 ms | 129 / 121 ms |

Every frame carried 66 KiB of base64 in both runs, so the lighter
intermediate capture changes only the desktop's work. No request was refused
for coming earlier than the core's 220 ms spacing.
