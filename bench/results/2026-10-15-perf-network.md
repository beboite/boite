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
