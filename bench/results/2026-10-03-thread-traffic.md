# Thread-opening traffic, 2026-10-03

Measured with Bun 1.4.2 on Linux, using a temporary real core and the echo
provider. No provider login or existing conversation was used.

```sh
bun bench/thread-traffic.ts --rtt 150 --mbps 2 --runs 7
bun bench/thread-traffic.ts --rtt 150 --mbps 2 --runs 7 --attachment-kib 0
```

The relay adds 150 ms round-trip delay and limits each direction to 2 Mbit/s.
Counters include WebSocket framing and compression, excluding IP and TLS
overhead. Both protocols use the same history and connection with remote
compression enabled. Each pair alternates which protocol runs first, with
seven samples per protocol and phase. Results below are medians.

The fixture has 400 completed messages with repetitive text. The attachment
variant replaces the latest message's text with a 192 KiB random binary file.
A cold visit asks for 40 messages. A quiet return starts at the last completed
message; the snapshot protocol supplies its previous resume proof.

| Fixture | Visit | Protocol | Sent bytes | Received bytes | RPC latency, ms |
| --- | --- | --- | ---: | ---: | ---: |
| Attachment | Cold | Four-call burst | 459 | 199,475 | 992.03 |
| Attachment | Cold | Opening snapshot | 193 | 1,620 | 176.42 |
| Attachment | Quiet return | Four-call burst | 482 | 198,438 | 991.60 |
| Attachment | Quiet return | Opening snapshot | 287 | 614 | 161.04 |
| Text | Cold | Four-call burst | 459 | 1,603 | 165.16 |
| Text | Cold | Opening snapshot | 193 | 1,561 | 163.31 |
| Text | Quiet return | Four-call burst | 482 | 800 | 160.15 |
| Text | Quiet return | Opening snapshot | 287 | 618 | 158.22 |

The cold attachment visit receives 99.19% fewer bytes and completes 82.22%
sooner because the file loads only when clicked. A quiet attachment return
receives 99.69% fewer bytes and completes 83.76% sooner. Sent bytes fall 57.95%
on cold visits and 40.46% on quiet returns in both fixtures.

Text already compresses well: received bytes fall 2.62% on cold visits and
22.75% on quiet returns. Its roughly two-millisecond latency difference is
small beside the imposed round trip and does not establish a general rendering
speedup. A file subsequently downloaded still transfers its complete bytes.

These measurements exclude application boot, optional panels, provider work,
TLS, physical phones and the native desktop shell. The old protocol's separate
previous-thread unsubscribe and unread acknowledgement are excluded too.
Pending cards are empty in the traffic fixture and remain covered by contract
and Store tests. Images and inline media retain their initial content.

The production browser checks separately verify cached reading before a
750 ms response, complete tool-output hydration, compact first reads, unchanged
returns and byte-exact user and assistant file downloads on desktop and paired
phone layouts. Desktop and phone captures were opened for inspection.

```sh
BOITE_E2E_PREBUILT_UI=1 bun test tests/e2e/thread-switch.test.ts tests/e2e/thread-loading.test.ts
```

The traffic benchmark checks that each reply still contains the latest message
after reusable tails are merged. The contract scenarios check that a compact
proof cannot certify a full-file response, journal data stays intact and an
attachment cannot be read under another thread ID.
