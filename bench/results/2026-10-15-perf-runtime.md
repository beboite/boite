# Runtime optimization pass, 2026-10-15

Linux LXC (Ryzen 7 5825U host, CPU weight 50), Bun 1.4.2. Each line is the
median of the medians of 3 runs (each section says what a run times),
back to back on `origin/main` (3e535df3) and on the branch, under `nice -n 10`.

## Fresh-session history (RUNTIME-2, MEDIA-5)

`bun run bench/continuation.ts <messages> <toolKiB> <files> <fileKiB>` times
`continuationInput` on an echo thread of `messages` user and assistant pairs,
each assistant message one tool output of `toolKiB`, with `files` attached
files of `fileKiB` spread through the thread. A run times 6 calls after a
first one, which writes the file copies; the timed ones are the repeat continuation. The file callback is what
the core passes on each checkout: `fileReference` on main, the per-thread
`FileReferences` on the branch.

| Shape | main, ms | branch, ms | run medians, main | run medians, branch |
| --- | ---: | ---: | --- | --- |
| `100 1024 25 1100` (105 MB of tool output, 25 files) | 345.2 | 28.8 | 314.3, 345.2, 422.6 | 28.8, 24.6, 29.9 |
| `200 200 0 0` (40 MB of tool output) | 83.3 | 4.6 | 83.3, 94.8, 78.7 | 4.7, 4.6, 4.5 |
| `40 1 25 1100` (25 files, all kept in the prompt) | 139.8 | 52.4 | 168.0, 139.8, 132.4 | 66.5, 52.4, 48.6 |

The prompt has the same length on both sides (61,029, 60,626 and 49,327
characters); `packages/core/test/continuation.test.ts` checks it byte for byte
against the former single walk. The last shape still reads the 37 MB of file
data the kept messages hold; what it saves is the base64 decode, the SHA-256
and the read of each copy.

## Queue admission (RUNTIME-1)

`bun run bench/queue-admission.ts <held> 16` creates 16 enabled teams that
share `held` children, queues one echo turn per child behind an account login
hold, then times 20 `scheduler.retry()` passes over the held queue after 3
warm-up passes. Every turn that ends anywhere runs the same pass. Each line is
the median of the 3 run medians; the machine was busy with other builds, which
widens the spread on both sides.

| Held turns | main, ms | branch, ms | run medians, main | run medians, branch |
| --- | ---: | ---: | --- | --- |
| 256 | 10.3 | 0.27 | 10.34, 10.47, 9.22 | 0.24, 0.27, 0.34 |
| 1,024 | 45.9 | 2.02 | 45.68, 45.92, 54.43 | 1.64, 3.48, 2.02 |

The pass no longer reads a thread row per held turn, and reads each team's
setting once instead of once per turn. The logged wait reason and its order
of checks are unchanged.

## Workflow redelivery (RUNTIME-4)

A throwaway script on `startTestCore` wrote 500 delivered `done` runs of
40 KB on one conversation, then timed `Workflows.redeliver`, which every
`delegation.changed` of the conversation runs, 20 times after 3 warm-up calls.
Median of the 3 run medians: 44.0 ms on main (44.02, 47.75, 39.90) and
0.002 ms on the branch (0.002, 0.002, 0.003). The branch keeps in memory the
conversations that have a finished or paused run whose result is not handed
over yet, and skips the query for the others.

## Delegation tick (RUNTIME-5)

Unmeasured. The tick no longer parses result letters, which never expire, and
no longer calls `deliver` for a recipient whose team is paused or off, where
`deliver` found nothing after four reads. Resuming the team now hands over its
held mail at once instead of at the next tick
(`packages/core/test/delegation.test.ts`, "a paused team keeps its results
until the owner resumes it, then they wake the parent at once").
