# Checkpoint store: adoption, compression and retention

Date: 2026-10-17. Machine: Windows 11 Pro, Ryzen 7 9800X3D, NTFS, Bun 1.4.2.
Source: the user's live `checkpoints/` folder, opened read-only and copied to
`D:/Dev/.temp/` with its hard links rebuilt by file ID, so the passes ran on
the copy only. Other agents and builds ran on the machine at the same time.

```sh
bun run bench/checkpoint-store.ts --source <data dir>/checkpoints --phase copy     # 942 s
bun run bench/checkpoint-store.ts --source <data dir>/checkpoints --phase run
bun run bench/checkpoint-store.ts --source <data dir>/checkpoints --phase rewinds
bun run bench/checkpoint-store.ts --source <data dir>/checkpoints --phase clean
```

`run` measures the copy, runs `StoreMigration` over every thread folder (the
pass the core runs three minutes after start, here without its tick pauses),
then `trimFolder` with the newest 50 manifests of each folder by modification
time, then `collectSharedBlobs` with no grace period, and measures again.
Bytes count each file ID once; "allocated" rounds each file up to 4 KiB.

| | Names | Files (inodes) | Bytes | Allocated | Manifests | Manifest bytes |
|---|---:|---:|---:|---:|---:|---:|
| Before | 301,464 | 100,096 | 3,034 MiB | 3,261 MiB | 1,488 | 200 MiB |
| After adoption and compression | 307,484 | 25,685 | 353 MiB | 420 MiB | 1,488 | 41 MiB |
| After 50-turn retention and collection | 180,628 | 14,532 | 183 MiB | 216 MiB | 1,341 | 37 MiB |

The store pass replaced 264,193 private names with links to the shared blob,
moved 6,020 blobs the store lacked into it, rewrote 17,489 shared blobs and
all 1,488 manifests as zstd frames, and found no file that did not hash to its
name and no refused hard link. It read 856 MiB and took 1,062 s. Retention
removed 147 manifests and 115,703 names no kept manifest needed, then the
collection removed 11,006 shared blobs, in 226 s.

Rewinds: 20 kept turns spread through the folders, each with the files as the
turn left them written to a scratch root, rewound through `restoreFiles` on
the store after the passes: 20 of 20 restored, 243 files, each file's SHA-256
equal to the checkpoint's. The first `run` sampled only 11 turns (its stride
skipped the rest); the `rewinds` phase after the fix took 20.

Not measured here: the rule that drops a thread archived or done for more
than 7 days, since the bench does not read the journal; the core's own pass,
which spreads the same work over ticks of 500 names or 16 MiB read, 200 ms
apart.
