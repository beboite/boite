# Opening a long thread on one screen's budget, 2026-10-13

Measured with Bun 1.4.2 on Linux, a temporary real core and the echo provider,
headless Chrome at 1280x900, on the fixture of the
[2026-10-05 report](2026-10-05-thread-open.md): 200 messages, 48.9 MB of parts.
Each figure is the median of three runs. Main ran from its own checkout with
the UI built beside it; the bench file is this branch's, so main received the
`maxBytes` rows too and ignored the parameter.

```sh
bun run build:ui
bun run bench/thread-open.ts --runs 3
bun run bench/thread-open.ts --runs 3 --core <main checkout>/packages/core/src/main.ts
```

"Light page" is what the UI asked for before this change: 40 messages with
compact tools, files, images and tool parts. "Screen page" adds
`maxBytes: INITIAL_PAGE_BYTES` (128 KiB), what the UI asks for now. "Relay" is
deflated bytes on the wire through a 150 ms round trip; "throttled" is Chrome
at 150 ms and 10 Mbit/s.

| Measure | main 5f19f0b1 ms | KB | branch ms | KB |
| --- | ---: | ---: | ---: | ---: |
| Whole last page, loopback | 156 | 12,045 | 154 | 12,045 |
| Light page, loopback | 54 | 1,305 | 36 | 152 |
| Light page, relay | 242 | 362 | 195 | 21 |
| Screen page, loopback | 57 | 1,305 | 42 | 129 |
| Screen page, relay | 250 | 362 | 197 | 18 |
| Screen page around a message far up, loopback | 65 | 1,305 | 40 | 130 |
| Click to first message, loopback, 3 of 3 opened | 191 | | 155 | |
| Click to first message, throttled, 3 of 3 opened | 1,902 | | 297 | |

The light page fell from 1,305 KB to 152 KB because a successful call's output
no longer travels: 27 of the fixture's 30 outputs per answer are 2,000
characters, under the 16 KiB that deferred an output before.

## A working journal

The last 40 messages of the 30 most recently active threads of one working
journal, read without writing to it, projected as main and this branch send
them: 18.6 MB together on main, 2.6 MB on the branch. The heaviest thread's
first page went from 9.5 MB (40 messages, 3,619 tool calls) to 63 KB (4
messages); the median went from 267 KB to 87 KB. The largest branch page,
211 KB, is one message over the budget, which a page always carries whole.

## Scrolling up through pages

Small pages mean more pages landing above the reader. On main, each landing
moved the text being read down by 850 px at 1280x900: the restore counted the
rows mounted just above the reader at their estimated height. With the old
head put back where it stood on screen, the same landing in the same fixture
moved it by 0 px (`tests/e2e/thread-reopen.test.ts`).
