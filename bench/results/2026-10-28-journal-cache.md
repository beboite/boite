# The journal's page cache, 2026-10-28

## On a loaded server

Measured on the Linux container (Ryzen 7 5825U host shared with another
guest, 14 GB, Bun 1.4.2) while 15 agent sessions ran builds and test suites:
the agents' cgroup used 6.5 to 9.2 GB, swap was full, and in 96 minutes the
core logged 24 memory pressure changes and its memory guard killed 12
processes. The journal was 4.09 GiB.

The kernel kept almost none of the journal's file pages. A read-only
connection dropped them with `posix_fadvise(DONTNEED)`, then `mincore` counted
the pages read back by the core alone: 4,213 distinct pages, 16.5 MiB, in
three minutes, of which 0.4 to 9.1 MiB were still cached at any check. The core's main
thread was in uninterruptible sleep 13 % of the time, in `folio_wait_bit_common`
and `dm_thin_find_block`. `GET /health` answered in 4 ms at the median, 737 ms
at p99 and 1.9 s at worst; 1,076 calls logged `rpc.slow` in 96 minutes
(`threads.list` 258 times, median 2.3 s), and the desktop client dropped the
connection 8 times.

The thread list, the `VISIBLE_THREADS` query of `threads.list` (1,332 visible
threads out of 3,660), timed from a separate read-only connection inside one
read transaction:

| page cache | list | read from the file | from the disk | time |
| --- | --- | ---: | ---: | ---: |
| SQLite default, 2 MiB | 1st | 2.59 MiB | 4.00 MiB | 919 ms |
| SQLite default, 2 MiB | 2nd | 2.28 MiB | 0 | 58 ms |
| SQLite default, 2 MiB | 3rd | 2.28 MiB | 3.46 MiB | 500 ms |
| 64 MiB | 1st | 2.54 MiB | 3.96 MiB | 670 ms |
| 64 MiB | 2nd | 0 | 0 | 44 ms |
| 64 MiB | 3rd | 0 | 0 | 25 ms |

With the default cache each list read the whole table again, and the kernel
had dropped it between the second and the third list. The core runs that read
on its event loop.

## When SQLite keeps its cache

A scratch WAL database of 18 MiB, scanned on a connection with a 64 MiB cache
after each step (Python's SQLite 3.45; Bun ships 3.53.2):

| before the scan | read from the file |
| --- | ---: |
| nothing | 0 |
| a write on the same connection | 0 |
| a passive checkpoint from another connection | 0 |
| a truncating checkpoint from another connection | 18.08 MiB |
| a write from another connection | 18.08 MiB |

The core writes only through its main connection. Its checkpoint Worker
truncates the WAL only after 30 s without a write, so the cache is dropped at
most once per quiet spell.

## Bench

```sh
nice -n 10 bun bench/journal-reads.ts --runs 3
```

Branch `boite/journal-page-cache` on `26325751`, three runs, medians.
4,000 threads of about 700 bytes with 10 messages each, every list after a
thread write on the same connection:

| page cache | read from the file per list | list time |
| --- | ---: | ---: |
| SQLite default, 2 MiB | 3,670 KiB | 56.1 ms |
| the journal's, 64 MiB | 1.8 KiB | 56.2 ms |

The bench's journal was just written, so its pages are still in the kernel's
cache and the time is the same: what the 64 MiB cache removes is the 3.6 MiB
each list asked the kernel for, which a machine short of memory reads from
the disk, as in the first table.
