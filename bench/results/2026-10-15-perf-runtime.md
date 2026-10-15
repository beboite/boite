# Runtime optimization pass, 2026-10-15

Linux LXC (Ryzen 7 5825U host, CPU weight 50), Bun 1.4.2. Each line is the
median of the medians of 3 runs, each run 6 timed calls after a first one,
back to back on `origin/main` (3e535df3) and on the branch, under `nice -n 10`.

## Fresh-session history (RUNTIME-2, MEDIA-5)

`bun run bench/continuation.ts <messages> <toolKiB> <files> <fileKiB>` times
`continuationInput` on an echo thread of `messages` user and assistant pairs,
each assistant message one tool output of `toolKiB`, with `files` attached
files of `fileKiB` spread through the thread. The first call writes the file
copies; the timed ones are the repeat continuation. The file callback is what
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
