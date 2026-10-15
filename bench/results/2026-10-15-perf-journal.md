# Streaming writes beside the message row, 2026-10-15

Measured on the Linux container (Ryzen 7 5825U host, Bun 1.4.2), base
`origin/main` at `3e535df3` and the `boite/perf-journal` branch, run back to
back, three runs each, medians below. The same bench file ran on both sides.

```sh
nice -n 10 bun bench/streaming-load.ts 128 32
```

WAL autocheckpoint is off in the bench, so `walMiB` counts every byte a run
wrote to the WAL. `wide-row` streams 60 s of text (120 writes, one every
500 ms on a simulated clock, 100 characters each) into one message that already
holds 100 tool parts of 8 KB, an 803 KiB row.

| scenario | measure | base | branch |
| --- | --- | ---: | ---: |
| wide-row | WAL written | 95.69 MiB | 4.19 MiB |
| wide-row | write p50 | 4.48 ms | 0.18 ms |
| wide-row | write max | 50.4 ms | 7.8 ms |
| stream-only | WAL written | 32.37 MiB | 32.78 MiB |
| stream-only | final write | 755 ms | 641 ms |
| stream-and-read-one | WAL written | 32.37 MiB | 32.78 MiB |
| stream-and-read-one | final write | 1,054 ms | 588 ms |

On the branch, the wide row is written whole twice (at 30 s and 60 s); those
two writes are the maximum and most of the 4.19 MiB. The other 118 writes each
store only the growing text part in `streaming_parts`.

`stream-only` and `stream-and-read-one` grow a single 256 KiB text part per
stream, so the changed part is the whole message and the WAL volume stays the
same. Their final-write times vary by 2x between runs on both sides and show no
reliable difference. The branch's starting RSS is about 22 MiB higher in these
two scenarios because a message keeps its stored part JSON from `putMessage`
on, where the base keeps it from the first timed write, 500 ms later; both
hold the same strings while a message streams.
