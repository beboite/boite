# Agent browser frames, 2026-10-05

`bun bench/remote-browser-frames.ts --rtt 0,80,200` on the Linux container
`boite` (Ryzen 7 5825U shared with other guests), Bun 1.4.2, Chrome 153. The
core starts its own headless browser for the conversation, the page is set to
1200x1300 CSS at device scale 1 and frames are shrunk to 780 px by the browser
(a screenshot clip with a scale), 8 s per run. The page animates, so every
frame changes. Latency is added on the phone client's side; bandwidth is not
limited and the phone's own decoding is not measured.

"before" is a fixed 300 ms pause after each frame; "after" is the viewer's
current schedule (`nextPollDelay`).

| Added RTT | Before | After | Trip before / after |
| --- | --- | --- | --- |
| 0 ms | 1.9 frames/s | 4.0 frames/s | 215 / 223 ms |
| 80 ms | 1.8 frames/s | 3.4 frames/s | 297 / 299 ms |
| 200 ms | 1.5 frames/s | 2.5 frames/s | 427 / 414 ms |

Every frame carried 127 to 128 KiB of base64. No request was refused for coming
earlier than the core's spacing. These numbers do not compare with the
2026-10-03 run, which measured the desktop shell's tab relayed through the core
on Windows: the capture now happens in the core's own browser, about 200 ms a
frame for this page on this machine.
