# Thread switching, 2026-10-02

## Workload and measurement

The benchmark builds the real UI with its in-memory transport enabled, then
opens it in muted headless Chrome on Linux with hardware acceleration. It
records the WebGL renderer and rejects a software fallback. Both
versions use the same installed dependencies and a fresh browser profile.
The baseline UI and contracts come from `83ae9b46`. Thread RPCs, permissions
and questions receive a 300 ms artificial delay; history paging does not.

Each run opens a 400-message conversation, loads its older pages, then leaves
and returns seven times. A sample ends after the last message has mounted and
the browser has produced the next frame. A separate return captures a message
and its offset halfway through the history, then checks that position after
the fresh snapshot. This measures painted fixture content, not a native
WebView or a physical phone.

```sh
bun bench/thread-switch.ts --delay 300 --runs 7 --ui <baseline>/packages/ui
bun bench/thread-switch.ts --delay 300 --runs 7
bun bench/thread-switch.ts --delay 300 --runs 7 --phone --cpu 4 --ui <baseline>/packages/ui
bun bench/thread-switch.ts --delay 300 --runs 7 --phone --cpu 4
```

The four retained runs started between 12:55 and 13:06 UTC. Chrome reported
`ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)`.
Preliminary measurements using software rendering were discarded.

| Return to latest message | Baseline median | Optimized median | Time reduction |
| --- | ---: | ---: | ---: |
| Desktop, 1280 x 900 | 358.4 ms | 45.2 ms | 87.4% |
| Phone, 390 x 844, CPU throttled 4 times | 539.2 ms | 189.9 ms | 64.8% |

Seven samples per version, in milliseconds and measurement order:

| Configuration | Samples |
| --- | --- |
| Baseline desktop | 364.3, 369.1, 367.6, 356.9, 358.4, 350.4, 349.8 |
| Optimized desktop | 48.8, 53.7, 45.2, 50.6, 40.8, 43.0, 44.5 |
| Baseline phone | 536.2, 612.5, 544.2, 542.4, 519.1, 527.8, 539.2 |
| Optimized phone | 202.0, 180.2, 200.7, 189.9, 207.3, 156.2, 174.2 |

A return halfway through the history painted in 367.0 versus 58.2 ms on
desktop, and 601.1 versus 251.2 ms on phone. Position drift after synchronization
was 0.0 px for both optimized runs and at most 0.3 px for the baseline. Browser
errors were empty. Mounted rows at the latest message fell from 15 to 9 on
desktop and from 11 to 5 on phone.

Each configuration also measured one uncached visit: 743.8 versus 549.6 ms on
desktop and 920.5 versus 670.3 ms on phone. These single samples do not establish
a reliable cold-start distribution. The runs were sequential on a shared host;
CPU throttling simulates slower execution rather than a physical phone.

## Production browser check

```sh
bun test tests/e2e/thread-switch.test.ts
```

This separate test uses the production bundle and a real temporary core with
220 messages. The last message contains a 1.84 MB command output. The folded
output adds no output DOM; expanding it retrieves the complete text. A cached
return must paint within 500 ms despite a snapshot delayed by 750 ms.

| Return | Painted content | Position drift after synchronization |
| --- | ---: | ---: |
| Desktop, 1280 x 900 | 123.9 ms | 0.0 px |
| Desktop to phone, 390 x 844 | 223.8 ms | 0.3 px |
| Phone to phone | 186.5 ms | 0.0 px |
| Phone to desktop | 251.6 ms | 0.3 px |

Desktop and phone captures were opened and inspected. The broader run of
thread switching, mobile navigation, scroll following, chat delivery and
message editing passed 30 scenarios, including paired-phone editing. Native
desktop shells, physical phones, deployed clients and live providers were not
tested.

The production check was repeated after the review fixes at 14:14 UTC. It
also replaces only the suffix of an expanded output, with its length, status
and preview unchanged, then verifies that same-thread revalidation retrieves
the revised full text. Three store regressions failed before the fixes:
terminal NotFound/Refused invalidates cached reading, with or without a previous
thread, and a compact prefix cannot certify a previously hydrated output.
The final affected UI run passed 129 scenarios.

## Combining approaches after the independent pass

The independent implementation was tested and measured before inspecting
[t3code at `54084ae1`](https://github.com/pingdotgg/t3code/tree/54084ae1e6c32809db040e4fa571c80fdf2d8ae4).
The comparison concerns source mechanisms; t3code was not built or benchmarked.

| Mechanism | t3code | Combined Boite implementation |
| --- | --- | --- |
| Cached history | Retained snapshots seed the detail stream; idle retention lasts five minutes and settled data can persist | A synchronous snapshot paints before RPCs; up to 16 recent visits share a 16 MiB text budget per Store |
| Reading position | Row ID and offset; keep the target mounted while estimated index scrolling settles | Seed the first window from the saved message ID, offset, measured rows and viewport height, then reconcile with actual layout |
| Obsolete requests | Resume ownership and history epochs reject stale work | Client identity and visit generation isolate snapshots, history pages and tool fetches; same-thread refresh clears old paging |
| Initial history | Last ten user-anchored turns, older pages of twenty | Forty messages for the initial snapshot, older pages of 120; large completed tool outputs use bounded previews |

The comparison added restoration by message ID before the first window is
drawn, reuse of viewport height, resetting older-page loading on a new visit,
and tool-fetch ownership per client and visit. Those navigation failures have
regressions that failed before their fixes. In-memory retention stays bounded by
bytes rather than copying t3code's disk cache or background streams.

Sources: [thread state and resume ownership](https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/packages/client-runtime/src/state/threads.ts),
[retention](https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/packages/client-runtime/src/state/threadRetention.ts),
[timeline restoration](https://github.com/pingdotgg/t3code/blob/54084ae1e6c32809db040e4fa571c80fdf2d8ae4/apps/web/src/components/chat/MessagesTimeline.tsx).
