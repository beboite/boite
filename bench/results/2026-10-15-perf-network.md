# Network pass, 2026-10-15

Machine: Linux LXC, Ryzen 7 5825U host, Bun 1.4.2. Base `origin/main` 3e535df3.

## Quotas and push (part 1)

These changes remove work rather than speed it up, so they are measured as
counts of reader calls, frames and preparation steps. Each count comes from the
regression test named beside it, run on `origin/main` code and on the branch:
`nice -n 10 bun test packages/core/test/quotas.test.ts packages/core/test/push.test.ts`.
Time per avoided call is unmeasured: a Codex probe needs a signed-in Codex.

| What | Test | origin/main | branch |
| --- | --- | --- | --- |
| Reader calls for a Codex account a session just reported | a Codex session reading stands as a fresh read | 1 | 0 |
| `quotas.progress` frames to a second owner connection, 3 rows | quota progress reaches the connection that asked and no other | 3 | 0 |
| Reader calls on the next list after renaming one of 2 accounts | changing one account re-reads that account only | 2 | 1 |
| Reply walks and badge counts per finished turn, no subscriber, no group | a finished turn prepares no push at all | 1 and 1 | 0 and 0 |

## Group sync backoff (part 2)

A member that stops answering is offered the same roster again after 30 s,
then 60 s, 120 s, 240 s and 300 s, instead of every 15 s. Counted by the test
"a member that stops answering waits longer each time" in
`packages/core/test/group.test.ts`: offers to a silent member in the round
right after a failed one, 1 on `origin/main`, 0 on the branch. Derived from the
schedule, dial rounds per silent member per hour drop from 240 to about 14.
Time and sockets saved are unmeasured.

## Server update payload (part 2)

`bench/server-update.ts`, the archive built from the installed 2.x server
(`boite-core` 108 MB plus the UI, 452 files, 55 MB zipped) and served from
`python3 -m http.server` on loopback. The packet carries the publisher key id
with an invalid signature, so both versions read and hash everything and
refuse it at the end; the unpack runs after it. `origin/main` is measured with
its `release.ts` copied beside the branch's.

```sh
bun bench/server-update.ts prepare ~/.local/lib/boite/boite-core ~/.local/lib/boite/ui /tmp/bench-su/srv
/usr/bin/time -f %M nice -n 10 bun bench/server-update.ts run <release.ts> http://127.0.0.1:38411/payload.zip /tmp/bench-su/srv/signature /tmp/bench-su/work
```

Three runs each, alternated, median:

| What | origin/main | branch |
| --- | --- | --- |
| Peak RSS of the process | 279 MB | 74 MB |
| Longest event loop stall, download and signature check | 197 ms | 43 ms |
| Longest event loop stall, unpack | 5198 ms | 48 ms |
| Download and check, wall | 412 ms | 425 ms |
| Unpack, wall | 5197 ms | 6858 ms |

The unpack takes longer because it now hands the event loop back after each
64 KiB of archive; on `origin/main` the whole unpack is one stall.
