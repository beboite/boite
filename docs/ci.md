# CI and publication

Changes land through squash-merged pull requests. The repository's merge policy
requires `CI required` and `PR title`, forbids direct pushes, force pushes and
deletion of `main`, and permits admin bypass only when merging a PR. CODEOWNERS
requests reviews; approval is not required. The `release tags` policy protects
`v*` tags from movement and deletion while allowing their creation.

`PR title` runs `scripts/ci/pr-title.ts` on title edits. The squash title is
`type(scope): summary`, with an optional scope and one of `feat`, `fix`, `perf`,
`refactor`, `docs`, `test`, `ci`, `build`, `chore` or `revert`. Its body is empty.

## Checks

`scripts/ci/changes.ts` selects jobs from changed paths. Unknown paths run the
complete suite; renames affect both the old and new path. Every run has a
`CI required` gate, including documentation-only changes. It requires success
for selected jobs and an intentional skip for the others. Failure, cancellation
or an unexpected skip blocks it, including jobs whose dependency never started.

| Change | Selected checks |
| --- | --- |
| `docs/*.md` and nested Markdown, listed root policies, issue/PR templates, CODEOWNERS, labeler rules, topics, `.coderabbit.yaml` | Changes job only |
| `apps/shell/` | Windows installer, Rust and native shell E2E; three browser/core E2E shards; portable desktop matrix |
| `tests/e2e/` | Desktop and E2E checks plus `check:e2e`; `tests/e2e/lib/` also selects stress |
| `Dockerfile`, `.dockerignore`, `docker/` | Native x64 and ARM64 Docker smoke tests |
| `packages/ui/` | Full type checks and UI tests, desktop/E2E, Docker and stress |
| `apps/android/`, `android.yml`, `scripts/ci/android-apk.ts` | Unsigned APK build |
| `telemetry/` | Full type checks and UI tests plus the existing relay behavior suite |
| `tests/stress/`, `bench/agent-stress.ts`, `bench/lib/` | Full type checks, UI tests and stress |
| Other `bench/` files, `scripts/architecture/` | Full type checks and UI tests |
| Core, contracts, dependencies, shared builds, other workflows and unknown paths | All checks |
| Release or manual full run | All checks, except jobs the caller replaces through explicit inputs |

The changes job always installs frozen dependencies, runs `bun audit`, local
link checks, `bun test scripts/ci ./bench ./apps/shell/scripts`, architecture
checks and their tests, and translation validation. Changes to workflows,
composite actions or `scripts/ci/` also run checksum-verified actionlint 1.7.12.

Architecture checks reject runtime dependency cycles, forbidden package imports
and production files above 900 lines. Existing oversized files have ratcheting
limits in `scripts/architecture/size-budget.json` from 2026-09-25. Contracts,
the in-memory client and UI string tables are exempt. Complexity reporting is
advisory. Missing translations warn on PRs and nightlies; the release version
job requires every sentence ([language](language.md)).

The focused telemetry job runs `bun test packages/core/test/telemetry.test.ts`
when the full core suite is absent. The focused E2E type job runs
`bun run check:e2e` when the web job, which already includes it, is absent.

The required Windows stress job runs all three existing offline scenarios with
`bun run test:stress`: protocol isolation/cancellation/recovery, failed health
reporting, and loaded desktop/phone-width UI. It tests the UI the `Build UI`
job built (below) and retains fixture evidence under `tests/e2e/.artifacts/stress/`. Live-provider tests stay
disabled. See [performance](performance.md#concurrent-agent-stress) for workloads
and [portability](portability.md) for what these fixtures cannot prove.

### Run modes and platforms

PRs against any branch use `pr` mode and compare with their base. Main pushes
use `warm`: they run affected core and E2E suites too, add Linux ARM64 and macOS
Intel desktop legs, and save caches. A push event does not prove that an
equivalent PR tree passed. A main push compares with the last main commit whose
CI passed, not with the previous push, so the changes of a cancelled or failed
run are tested again. A green main commit therefore has every suite passing on
a tree no later change affected, as far as the path rules above hold; the
nightly publishes on that. Without an answer from the API, the run selects every
check. Tags, reusable full calls and manual runs use `full`. PR portable
desktop legs are Linux x64 and macOS ARM64; warm/full runs use both
architectures of each OS. The core suite follows the same rule for its Intel
Mac: a PR runs it on Linux x64/ARM64, Windows and macOS ARM64, and warm/full
runs add `Core tests (macOS x64)` on `macos-15-intel` (`coreRunners` in
`changes.ts`). That job took 322 to 409 s a PR on a scarce runner (2026-10-17);
an Intel-only core failure now shows on the main push.

`desktop.yml` holds the desktop builds: the Windows installer job and one job
per portable platform, named after it (`Desktop / macOS x64`). `ci.yml` calls
it with the Rust tests; the nightly calls it without them. On Windows they run
in `Desktop / Windows x64 Rust tests`, a job of their own beside the installer
build; portable jobs keep them in line. Only `CI required`
and `PR title` are required checks, so a display name can change freely, except
the `release.yml` job names that `server-provenance.ts` checks.

Intel macOS packages are cross-built on the Apple Silicon runner with
`BOITE_TARGET=x86_64-apple-darwin`. The core compiles for `bun-darwin-x64`, and
the Rust tests and installed smoke check run as Intel binaries under Rosetta.
Only the core suite still runs on an Intel runner. On 2026-10-04 the Intel
desktop leg took 14.0 minutes and the Apple Silicon one 8.1 (nightly run
37234148865, the longest job of that run).

Core changes run the full core suite on Windows, Linux x64/ARM64 and macOS
ARM64 in every mode, and on Intel macOS outside PRs. Linux desktop packages build on Ubuntu 22.04,
setting a glibc 2.35 floor. Portable jobs run Rust tests and installed smoke
checks against Debian, extracted AppImage and macOS application bundles.
These verify startup, UI serving, authenticated RPC and a fixture echo turn
outside the checkout. Native WebView2 E2E remains Windows-only.

New commits cancel older ordinary runs for the same PR or main ref. Stable
release and publication groups include the ref and SHA, so different versions
do not replace each other's pending run. Nightlies retain one shared group:
a running publication finishes, while newer pending work can supersede older
pending work.

Artifact uploads retry once, replacing a name reserved by the failed attempt.
A second failure fails the job. Tests and builds are not retried, with one
exception. `scripts/ci/hdiutil-retry.ts` bundles the macOS application again,
three attempts at most, when hdiutil reports `Resource busy`. That runner
fault (actions/runner-images#7522) failed the Apple Silicon DMG of nightly
37213994348 and cost a rerun. Before retrying, it detaches what the failed
attempt left attached and removes its partial DMGs. Any other failure ends
the step.

## Build cost

Cargo, Vitest, the Bun store and BuildKit save caches only from `main`. Cargo namespaces
separate Windows release builds and each portable runner. Vitest stores
transforms under `node_modules/.vitest-cache`; its namespace includes
`bun.lock`, Svelte/Vitest configuration and `packages/ui/icon-plugin.ts`.
Each Docker architecture has its own BuildKit scope. Agent dependency manifests
are copied before source files, so a core edit does not reinstall CLIs.

Bun follows `packageManager` and installs with `--frozen-lockfile`. The setup
action restores Bun's download store (`bun pm cache`) keyed on OS,
architecture, Bun version and `bun.lock`, falling back to the newest store of
the same Bun; only `main` saves it. Install still links every package and runs
lifecycle scripts, so a stale store costs downloads only. Uncached, install took
20 to 33 s on the Windows and macOS runners (2026-10-17). UI tests use at most eight workers. Core files run in
fresh Bun processes, four at once by default; `BOITE_TEST_WORKERS` accepts 1 to
8 and `bun run --cwd packages/core test:serial` runs one file at a time. Each
core has a fresh data directory and port. Full per-file output and nonzero
exit failures are retained. A file still running after five minutes, its event
loop blocked where no test timeout can fire, is ended and reported with what it
printed (`BOITE_TEST_FILE_DEADLINE_MS`).

Browser command, sharing and profile scenarios run in separate files so their
combined Chromium startup time does not consume one five-minute file budget.
Each file registers its own loopback site and fresh-core hooks through a fixture
factory; individual scenario deadlines and assertions remain unchanged.
Crash-recovery fixtures disarm resident delegation, coordination, workflow and
group readers before closing the journal, without draining interrupted work.
Real-core browser gestures wait for a decoded, enabled frame fitted to the view;
an image can load before the automatic viewport resize has finished.
Deferred-dialog fixtures release a loopback response after the agent's commands
finish and observe the page's completion request before reading its title.
Network-diagnostic assertions wait for the asynchronous response event, which
DOM readiness does not include. Desktop-host fixtures close Chromium and remove
their profiles when setup fails, and register cleanup before returning a host.
The command/dialog scenario prints a bounded, content-free CDP timing trace only
on failure, retaining the original error and restoring its observers afterward.
Fold-reveal coverage includes lazy rows arriving after the opening animation;
the follow period starts when content is ready, and user input still cancels it.

The Windows job shares release-profile Rust dependencies, builds the installer
once, and stages its existing core beside the shell for native E2E. The shell's
Rust tests run beside it in their own job, which restores the same
`desktop-release-v1` cache and never saves it: the test build turns on
`tauri/test` and drops `custom-protocol`, so it needs neither the UI nor the
staged core, and in line it added 97 to 102 s after the 221 s build. Installer
regressions set `BOITE_CI_INSTALLER_REQUIRED=1`, so missing NSIS or generated
fixtures fail rather than skip. Unsupported local runs keep intentional skips.
The tested installer becomes the release artifact.

The shipped shell uses fat LTO over one codegen unit. Its final step is serial:
on 2026-10-17, recompiling only the shell crate took 8 min 57 s with fat LTO and
10 min 18 s with thin LTO on the shared 8-thread development machine, against
1 min 32 s with Cargo's defaults (`bun run --cwd apps/shell tauri build
--no-bundle`). `Cargo.toml` therefore keeps Cargo's release defaults, and
`desktop.yml` sets `CARGO_PROFILE_RELEASE_LTO=fat` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1` only on the steps that build a shipped
shell (the Windows installer, the Debian package, the macOS bundle) and only
when `sign-updates` is on: the nightly and a release. Other steps and runs set
`false` and `16`, Cargo's defaults, so `test:shell --release` keeps them even in
a release run. Both desktop jobs get 60 minutes instead of 35 when publishing.
The cache is saved from `main`, so a publishing run also
compiles its dependencies with LTO, an estimated 7 to 8 minutes more per
platform. On Windows `stage:core` no longer compiles `dist/boite-core.exe`:
2026-10-17, four alternating local runs of the old and new command, median
5.4 s against 3.4 s, and a 105 MB write less.

`scripts/ci/budgets.ts` reads [budgets.json](../scripts/ci/budgets.json):

| Measure | Maximum uncompressed bytes |
| --- | ---: |
| UI entry chunk | 493,800 |
| UI files, excluding `.br` and `.gz` copies | 4,868,600 |
| Core `dist/main.js` | 995,000 |
| All emitted core JavaScript, including lazy chunks and workers | 4,478,300 |

The total JavaScript measure excludes native binaries and source maps.

On 2026-10-18, the draft heading that names the machine, merged with
`origin/main` at `80c2da06`, measures 492,819 entry bytes and 4,646,842 UI
bytes with `measure()` after a fresh `bun run build:ui` on Linux, against
491,872 and 4,867,996 that main measured on Windows (the two agreed on
`95862236`, 490,185): 947 entry bytes for the machine's icon and name in the
desktop sentence and after the phone's project chip. The entry limit rises to
493,800, about a kilobyte above. Geist, Figtree and DM Sans leave the bundle,
221,154 UI bytes of woff2; the other limits stay.

On 2026-10-18, keeping the prompt cache warm (PR #594) merged with
`origin/main` at `3a19eb57` measures 491,872 entry bytes, 4,867,996 UI bytes
and 4,477,807 core JavaScript bytes with `measure()` after fresh
`bun run build:ui` and `bun run build:core` on Windows, against 490,436,
4,860,909 and 4,470,119 recorded below for that main on the same machine.
Measured on its own against `95862236`, the settings card adds 3,897 bytes to
the settings chunk, the quiet ping line and its message grouping 1,539 to the
entry chunk, the sentences 1,523; the keepalive scheduler, its guards and the
request clock add 7,732 core bytes. The entry, UI and core JavaScript limits
rise to 492,200, 4,868,600 and 4,478,300; `main.js` stays.

On 2026-10-18, the journal compaction (schema 37: zstd values, per-thread
command lines, the paced background passes in `journal/retention.ts` and
`journal/processes.ts`, and the start-time VACUUM in `journal/vacuum.ts`)
merged with `origin/main` at `95862236` measures 490,436 entry bytes,
4,860,909 UI bytes and 4,470,119 core JavaScript bytes with `measure()` after
fresh `bun run build:ui` and `bun run build:core` on Windows, against 490,185,
4,859,771 and 4,447,509 for that main on the same machine: the window's
compacting state adds 1,138 UI bytes and the journal code 22,610 core bytes.
The UI and core JavaScript limits rise to 4,861,500 and 4,470,500; the other
limits stay.

On 2026-10-18, the server update rollback merged with `origin/main` at
`feccdfcd` measures 4,447,509 core JavaScript bytes with `measure()` after a
fresh `bun run build:core` on Windows, against the 4,438,396 recorded below for
PR #590. The rollback record, the kernel lock a restore holds, the data lock it
keeps through the swap, its flushed completion mark and the restore a start
finishes add 9,113 bytes; `main.js` shrinks by 1,669 as the data lock moves to
its own module. The core limit rises to 4,448,000; the other limits stay.

On 2026-10-18, the lighter sidebar project headers (PR #592) merged with
`origin/main` at `36ef9a81` measure 4,859,521 UI bytes with `measure()` after
a fresh `bun run build:ui` on Linux, against 4,857,911 for that main: the
header's shared tile and chevron slot, the menu that reserves no width and
the counter pills add 1,628 bytes to `index.css`, the entry chunk 18 fewer.
The UI limit rises to 4,860,100; the others stay.

On 2026-10-18, Claude's agent totals and the usage cache split (PR #590)
merged with `origin/main` at `3a91f49f` measure 490,193 entry bytes,
4,857,911 UI bytes and 4,438,396 core JavaScript bytes with `measure()` after
fresh `bun run build:ui` and `bun run build:core` on Linux, against 489,771,
4,857,227 and 4,437,160 for that main; at `616c9856` Windows CI measured the
same UI bytes as Linux. The cache split's sentences add 684 UI bytes, the
recorded totals and their retry handling 1,236 core bytes. The UI and core
JavaScript limits rise to 4,858,500 and 4,439,000; the others stay.

On 2026-10-18, the boot notice that tells a lost chunk from an old browser,
on `origin/main` at `5055522c`, measures 4,856,869 UI bytes with `measure()`
after a fresh `bun run build:ui` on Windows, against 4,854,887 for main at
`ee9f9ac8`: its sentences, retry button and feature probe add 1,982 bytes to
`index.html`. The UI limit rises to 4,857,800; the other limits stay.

On 2026-10-18, agent browser downloads (PR #585) on `origin/main` at
`ee9f9ac8` measure 4,436,753 core JavaScript bytes on the Windows CI runner.
Fresh `bun run build:core` on Linux gives 4,436,794 for the branch against
4,417,268 for that main: the quarantine, its CLI commands and their help add
19,526 bytes. The core JavaScript limit rises to 4,437,500; the others stay.

On 2026-10-18, the tool summaries setting on `origin/main` at `150d7bb6`
measures 489,501 entry bytes, 4,854,418 UI bytes and 4,413,357 core
JavaScript bytes with `measure()` after fresh `bun run build:ui` and
`bun run build:core` on Windows, the same UI bytes Windows CI measured. Its
switch and English/French sentences put the UI 518 bytes over its limit,
which rises to 4,855,400; the other limits stay.

On 2026-10-18, the UI runtime change merged with `origin/main` at `7eaaf9c7`
(the group vet, on the slow draft journal and the lean boot) measures 489,501
entry bytes, 4,852,925 UI bytes and 4,413,077 core JavaScript bytes with
`measure()` after fresh `bun run build:ui` and `bun run build:core` on
Windows, against 486,005 and 4,727,998 that main measured: 3,496 entry bytes
and 124,927 UI bytes more, of which the highlight worker is 114,882. The rest
is the change's terminal status reader with its overflow seams and the model
cache's held write. Reading a snapshot that ends on a bare ESC brings the UI
to 4,853,016. The entry and UI limits rise to 490,500 and 4,853,900,
about a kilobyte above; the core limits stay.

On 2026-10-18, the group vet merged with `origin/main` at `8868384d` (the
slow draft journal) measures 486,005 entry bytes, 4,727,998 UI bytes and
4,413,077 core JavaScript bytes with `measure()` after fresh `bun run build:ui`
and `bun run build:core` on Windows, 583 UI bytes over that main. The UI limit
rises to 4,729,000; the other limits stay.

On 2026-10-18, the slow draft journal merged with `origin/main` at `9ffdb977`
(the lean boot) measures 486,005 entry bytes, 4,727,415 UI bytes and
4,413,077 core JavaScript bytes with `measure()` after fresh `bun run build:ui`
and `bun run build:core` on Windows. The UI limit rises to 4,728,000; the
other limits stay.

On 2026-10-18, the UI runtime change merged with `origin/main` at `15fdbb81`
measures 598,199 entry bytes and 5,159,382 UI bytes after fresh
`bun run build:ui` and `bun run build:core` on Windows, against 595,295 and
5,036,764 for that main on the same machine. The highlight worker
(`code-highlight.worker.ts`) is 114,882 bytes: Vite builds a worker as a bundle
of its own, so it carries highlight.js and every grammar the page already loads
lazily. It is fetched with the first text of 20,000 characters or more, never at
startup ([panel](panel.md)). Composer thumbnails, the resting second clock,
the shared list and picture observers, the hidden terminal's release with the
scanner that reads its marks meanwhile, and the worker's fallback add the
other 7,736 UI bytes, 2,904 of them in the entry; core JavaScript measures
4,412,886 bytes on both sides. Merged again with `origin/main` at `47c10e36`
(message pictures as file tickets, the lean install), the tree measures
599,526 entry bytes, 5,160,249 UI bytes and 4,412,366 core JavaScript bytes
after fresh builds the same way, 1,327 entry bytes more than before the merge,
close to the 1,283 that main's ticket and relay choice measured. Reading the
terminal's sequences as xterm.js 6 ends them brings the UI to 5,160,535, and
making that reader the only source of a terminal's status and directory to
5,160,658. Holding only its reports while a snapshot is on its way, in
`terminal-status.ts`, brings it to 5,161,378. Those measures
predate the lean boot; the newest note sets the limits.

On 2026-10-18, the lean boot merged with `origin/main` at `2be13d45`
(message pictures as file tickets and the media wire) measures 486,005 entry
bytes, 4,725,790 UI bytes and 4,412,394 core JavaScript bytes after fresh
`bun run build:ui` and `bun run build:core` on Windows. The entry limit rises
to 487,000, about a kilobyte above it; the other limits stay.

On 2026-10-18, the lean boot merged with `origin/main` at `57d41e70`, which
refreshes the UI dependencies, measures 485,472 entry bytes, 4,724,812 UI
bytes and 4,408,525 core JavaScript bytes after fresh `bun run build:ui` and
`bun run build:core` on Windows. The entry limit rises to 486,500,
a kilobyte above it; the other limits stay.

On 2026-10-18, the lean boot on `origin/main` at `b611c01f` measures 484,682
entry bytes and 4,723,056 UI bytes after a fresh `bun run build:ui` on
Windows, against 595,295 and 5,036,764 for `b611c01f` built the same way:
English left the entry for a chunk of its own, nine components the first frame
does not draw load lazily, the fake client resolves to an empty module, Geist
ships as latin, latin-ext and rest subsets and the onboarding clip is
re-encoded at 15 fps; a notice and a retry cover a catalogue or a lazy part
that fails to load. The limits fall to 485,800 and 4,727,000; the core
limits stay. [Performance](performance.md#static-files) has the boot files.

On 2026-10-18, the group vet's two-phase wait (`group-links.svelte.ts`) and
the vet client's own open deadline (`ws-client.ts`), on `origin/main` at
`2be13d45`, measure 5,038,322 UI bytes in the Windows desktop job of CI, 598
more than the 5,037,724 that main measures after a fresh `bun run build:ui` on
Windows. The UI limit rises to 5,039,000; the other limits stay.

On 2026-10-18, removing a purged or erased thread's Claude transcripts and
muting new audio sessions on Core Audio's notice, rebased on `b611c01f`,
measure 4,400,530 core JavaScript bytes after a fresh `bun run build:core` on
Windows, against 4,390,768 for that main: `threads/transcript-purge.ts`,
`threads/native-sessions.ts` and the notification vtables of
`audio-sessions.ts` add 9,762 bytes. The core JavaScript limit rises to
4,401,000; the other limits stay.

On 2026-10-18, the checkpoint store (blob and manifest compression, the
background adoption pass and 50-turn retention in `checkpoint-store.ts` and
`code-checkpoints.ts`, and the agent browser's profile trim) merged with
`origin/main` at `0990d9ab` measures 4,412,886 core JavaScript bytes after a
fresh `bun run build:core` on Windows, against 4,400,530 for that main, 12,356
more. The core JavaScript limit rises to 4,413,000; the other limits stay.

On 2026-10-17, sending message pictures as file tickets with a 320 px
thumbnail copy, on `origin/main` at `b611c01f`, measures 596,578 UI entry
bytes, 5,037,588 UI bytes and 4,394,594 core JavaScript bytes with `measure()`
from `scripts/ci/budgets.ts` after fresh `bun run build:ui` and `bun run
build:core` on Windows, against 595,295, 5,036,764 and 4,390,768 for that main
built the same way. The store's ticket and relay choice adds 1,283 entry bytes
and 824 UI bytes; the byte tickets, the thumbnail copy and its fallbacks add
3,826 core bytes, none of them in `main.js`. The entry, UI and core limits
rise to 596,700, 5,038,000 and 4,395,000.

On 2026-10-18, message pictures as file tickets merged with `origin/main` at
`10f16a25` (the transcript purge and the checkpoint store) measure 596,578 UI
entry bytes, 5,037,588 UI bytes and 4,416,712 core JavaScript bytes after fresh
`bun run build:ui` and `bun run build:core` on Windows, against 4,412,886 core
bytes for that main: the same 3,826. The core JavaScript limit rises to
4,417,000; the entry and UI limits stay at 596,700 and 5,038,000.

On 2026-10-18, a slow draft journal (the late read, its notice and the
attachments it resolves, in `lib/store/drafts.svelte.ts` and
`lib/draft-journal.ts`) merged with `origin/main` at `2be13d45` measures
5,039,331 UI bytes with `measure()` after a fresh `bun run build:ui` on
Windows, against 5,037,724 for those two files at that main, 1,607 more; the
entry chunk stays at 596,622. The UI limit rises to 5,040,000; the other
limits stay.

On 2026-10-17, PR #566 merged with `origin/main` at `b6ae659a`, which brings
the thread links and agent mail direction (PR #562), measures 595,205 entry
bytes, 5,036,527 UI bytes and 4,390,768 core JavaScript bytes after fresh
`bun run build:ui` and `bun run build:core` on Windows; a context menu that
only a scroll holding its row closes brings the UI to 595,295 and 5,036,764.
The entry is back under main's 596,500, which stays; the UI limit rises to
5,037,000 and the core limit stays at 4,391,000.

On 2026-10-17, PR #562 adds thread links in answers, reasoning and mission
results (`chat-links.ts`, `workspace.openThreadLink` and `followThreadLink`)
and the direction line on agent mail rows. Merged with `origin/main` at
`ec52ba98`, a fresh Windows `vite build` measures 5,026,308 UI bytes, 4,597
over the 5,021,711 PR #567 measured for its main, and a 593,355-byte entry
chunk against 596,347: since `workspace.svelte.ts` imports `chat-links.ts`,
Rollup moves that module out of the entry into the workspace chunk. Windows
CI agreed at `634840c3` (5,020,641 against 5,016,064 for `b8967956`). The UI
limit becomes 5,029,000; the entry limit stays at 596,500.

On 2026-10-17, PR #566 merged with `origin/main` at `ec52ba98`, which brings
subagent counts, their questions in the parent and agent-side resume (PR #567),
measures 597,841 entry bytes, 5,031,574 UI bytes and 4,390,771 core JavaScript
bytes after fresh `bun run build:ui` and `bun run build:core` on Windows. Each
PR's growth over `6004522f` is kept; the entry, UI and core limits rise to
598,000, 5,032,000 and 4,391,000.

On 2026-10-17, subagent counts, their questions in the parent and agent-side
resume (PR #567) merged with `origin/main` at `6004522f` measure a 596,347-byte
UI entry chunk, 5,021,711 UI bytes and 4,366,674 core JavaScript bytes with
`measure()` from `scripts/ci/budgets.ts` after fresh builds on Windows, against
593,513, 5,016,415 and 4,355,255 for that main on the same machine. The parent
row's subagent chip, the children's questions and permissions in the parent's
dock and the reads that keep them add 2,834 entry bytes and 5,296 UI bytes;
pause provenance, `delegation.resume`, the restart cut that continues children
and steps, the workflow adoption of a resumed step and one continuation per
stopped turn add 11,419 core bytes, none of them in `main.js`. The entry, UI
and core limits rise to 596,500, 5,022,000 and 4,367,000.

On 2026-10-17, opening an untouched conversation's panel on its launcher
(PR #563) merged with `origin/main` at `acb17c0a` measures 593,610 UI entry
bytes on Windows CI, 197 over that main's 593,413: the store's wide-window
`MediaQuery` and the untouched layout live in `right-panel.svelte.ts`, which
the entry loads. The entry limit is 594,000, which the Agents tab's list of
every machine's agents (PR #568) set without a note; the other limits stay
unchanged.

On 2026-10-17, Windows CI measured a 593,177-byte UI entry chunk for
`origin/main` at `7c7327ab`, already over its 593,000 limit after PRs #558 to
#560. The PR watch state (PR #564) adds 236 bytes there, 593,413 in total, and
201 bytes in a fresh Linux `bun run build:ui` (538,541 to 538,742). The entry
limit becomes 593,500; the other limits stay unchanged.

On 2026-10-17, pausing the UI's loops at rest and stepping them on a 60 Hz
grid measures 594,479 entry bytes and 5,020,875 UI bytes after a fresh `bun run
build:ui` on Windows, against 593,177 and 5,012,389 for `7c7327ab` built the
same way: the rest watcher, the loop phase and the shell's focus cue add 1,302
entry bytes, and the six easing staircases of `app.css` most of the 8,486. The
limits rise by that growth to 594,500 and 5,028,000.

On 2026-10-17, letting the followed live end of the open thread go past the
reading cache's bound measures 594,696 entry bytes and 5,022,260 UI bytes after
a fresh `bun run build:ui` on Windows, against 594,479 and 5,020,875 before it.
`store/live-end.ts` and the list's pruning of the heights it measured add 217
entry bytes; the entry limit rises to 594,800 and the UI limit stays.

On 2026-10-17, PR #566 merged with `origin/main` at `acb17c0a`, which brings
the PR watch state (PR #564) and the unread history reading (PR #565),
measures 595,104 entry bytes, 5,023,979 UI bytes and 4,378,787 core JavaScript
bytes after fresh `bun run build:ui` and `bun run build:core` on Windows. The
entry limit rises to 595,200; the other limits stay.

On 2026-10-17, the MCP servers started on demand, the frozen idle browser tabs
and the batched process records of PR #566 measure 4,378,383 core JavaScript
bytes after a fresh `bun run build:core` on Windows, against 4,355,066 for
`7c7327ab` built the same way; Windows CI measured 4,378,339. They add 23,317
bytes, none of them in `main.js`. The core limit becomes 4,379,000.

On 2026-10-17, the lazy MCP proxy dropping a call cancelled during its
server's start, and refusing a request whose session ended while its body
came, measure 4,379,352 core JavaScript bytes after a fresh `bun run
build:core` on Windows, against 4,378,787 before them. They add 565 bytes; the
core limit becomes 4,380,000.

On 2026-10-16, the server update recovery (PR #552) on `origin/main` at
`08c11d82` measures 4,353,036 core JavaScript bytes after a fresh `bun run
build:core` on Windows, against 4,348,624 for that main; Windows CI measured
4,352,918 for the first push. The update worker's recovery, its idempotent
rollback and the stale update cleanup add 4,412 bytes, 112 of them in
`main.js`, which stays under its limit. The core limit becomes 4,356,000; the other limits stay
unchanged. The table before this still showed 4,994,000 and 4,314,000 while
`budgets.json` held the 5,019,500 and 4,350,000 that PRs #545 to #550 set.

On 2026-10-16, shared git reads, checkpoint blobs and merged-PR backoff
(PR #526) merged with `origin/main` at `83f1720a` measure 4,988,020 UI bytes and
4,310,297 core JavaScript bytes after fresh `bun run build:ui` and `bun run
build:core` on Linux, against 4,987,764 and 4,299,107 for that main: the shared
checkpoint store, the batch diff read, the eight read slots, the worktree pool
and the merged-PR proof backoff add 11,190 core bytes and 256 UI bytes. The
limits rise by that growth to 4,994,000 and 4,314,000; the entry and `main.js`
limits stay unchanged.

On 2026-10-16, the network pass (PR #518: group sync backoff, streamed server
update unpacking, device frame reuse, per-account quota reads and the merge of a
live Codex reading into the account's last read) merged with `origin/main` at
`060cb452` measures 4,984,789 UI bytes and 4,299,107 core JavaScript bytes after
fresh `bun run build:ui` and `bun run build:core` on Linux, against 4,983,859
and 4,294,823 for that main: 930 UI and 4,284 core bytes. The core limit
becomes 4,302,000; the UI limit keeps room for that growth and stays
unchanged, as do the entry and `main.js` limits.

On 2026-10-16, faster provider detection and the native Codex binary (PR #524)
merged with `origin/main` at `0a63d907` measure 4,983,859 UI bytes and 4,292,757
core JavaScript bytes after fresh `bun run build:ui` and `bun run build:core`
on Linux, against 4,983,859 and 4,281,763 for that main: the hand-written ACP
update parser, the Codex launcher lookup, the live Codex limits and the provider
lookup memo add 10,994 core bytes. The core limit becomes 4,297,000; the other
limits stay unchanged.

On 2026-10-16, the process sampling changes (PR #522) merged with `origin/main`
at `2f979036` measure 4,983,647 UI bytes and 4,281,183 core JavaScript bytes
after fresh `bun run build:ui` and `bun run build:core` on Linux, against
4,982,829 and 4,272,145 for that main: the load pace, the bounded trace rows,
the `thread.load` event and the command lookup cache add 9,038 core bytes, the
client side of `thread.load` 818 UI bytes. The limits rise by that growth to
4,990,000 and 4,286,000; the entry and `main.js` limits stay unchanged.

On 2026-10-16, the reading cache, display image and pull request polling
changes (PR #525) merged with `origin/main` at `0a63d907` measure 4,986,586 UI
bytes after fresh `bun run build:ui` on Linux, against 4,983,859 for that main;
core JavaScript is unchanged at 4,281,763. The shared pull request timer, the
reading cache's size accounting, the bounded display image cache and the
per-project sidebar lists add 2,727 bytes. The UI limit becomes 4,993,000; the
other limits stay unchanged.

On 2026-10-16, the browser recording and viewer changes (PR #529) merged with
`origin/main` at `c561ea2c` measure 4,982,829 UI bytes and 4,272,145 core
JavaScript bytes after fresh `bun run build:ui` and `bun run build:core` on
Linux, against 4,982,096 and 4,263,703 for that main: the recorder's frame
pacing and the per-width viewer screencasts add 8,442 core bytes. The core
limit becomes 4,276,000; the other limits stay unchanged.

On 2026-10-16, `main` at `7ccb238d` measures 4,982,096 UI bytes and 4,263,703
core JavaScript bytes after fresh `bun run build:ui` and `bun run build:core` on
Linux, above its 4,982,000 and 4,244,000 limits. Nine pull requests merged that
day each fit the limits alone; together they add 6,681 UI bytes and 25,836 core
bytes over `9c5c1849`. Measured after each merge: #521 10,828 core bytes, #520
6,273 UI bytes, #519 5,070 core and 125 UI, #528 4,287 core and 283 UI, #516
3,693 core, #523 814, #531 518, #514 318 and #530 308 core bytes. The limits
rise by the growth they did not yet count, every byte but #516's 3,693 core
bytes, to 4,989,000 and 4,267,000; the entry and `main.js` limits stay
unchanged.

On 2026-10-16, the runtime optimization pass (PR #516) merged with `origin/main`
at `0f480824` measures 4,241,560 core JavaScript bytes after fresh `bun run build:core`
on Linux, against 4,237,867 for that main: the bounded journal walks, the copy
memo, the per-pump delegation config map and the undelivered-run set add 3,693
bytes. The core limit becomes 4,244,000; the UI measures 4,975,415 bytes on both
and its limits stay unchanged.

On 2026-10-16, the dialog showing what a Claude thread sends (PR #501) merged
with `origin/main` at `4eec5562` measures 4,975,415 UI bytes and 4,237,867 core
JavaScript bytes after fresh `bun run build:ui` and `bun run build:core` on
Linux, against 4,958,781 and 4,231,749 for that main: the dialog, its strings in
both languages and the store add 16,634 UI bytes, the reader of the recorded
request 6,118 core bytes. On `d11f6d16` Windows CI measured the UI about 5,000
bytes above Linux. The limits become 4,982,000 and 4,240,000; the entry and
`main.js` limits stay unchanged. The core row before this showed 4,161,000
while `budgets.json` held the 4,233,000 PR #505 set.

On 2026-10-15, views placed inside an answer (PR #502), merged with PR #503,
measure 4,938,784 UI bytes and 4,151,081 core JavaScript bytes after fresh
`bun run build:ui` and `bun run build:core` on Linux. The UI adds the answer
split around views. The UI limit becomes 4,941,000; the core limit stays at
the 4,161,000 PR #503 set, and the entry limits stay unchanged.

On 2026-10-15, Claude's preset system prompt (PR #500) merged with `origin/main`
at `2adac07b` measures 4,150,454 core JavaScript bytes after a clean
`bun run build:core` on Linux with Bun 1.4.2, against 4,127,241 for that main.
The Claude Agent SDK's update from 0.3.296 to 0.3.300 adds 21,565 bytes to its
lazy chunk, which never loads at startup. The core total limit becomes
4,152,000; the UI, entry and `main.js` limits stay unchanged.

On 2026-10-15, updating another Windows PC's desktop app (PR #498) merged
with PR #494 measures 4,926,156 UI bytes and 4,125,352 core JavaScript bytes
after fresh `bun run build:ui` and `bun run build:core` on Linux. The limits
become 4,928,000 and 4,127,000; the entry limits stay unchanged.

On 2026-10-15, the server update's handoff and the slimmer backup (PR #494),
with a handoff time in the update cards since removed, measured 4,917,711 UI bytes
and 4,119,340 core JavaScript bytes after fresh `bun run build:ui` and
`bun run build:core` on Linux, 711 and 340 bytes over the limits of that day;
Windows CI measured 4,119,299 core bytes. The limits become 4,919,000 and
4,121,000; the entry limits stay unchanged.

On 2026-10-14, files dropped on the desktop window going to the composer
(`lib/native-drop.ts`, the attach overlay and its English and French strings)
measured 4,900,488 UI bytes on Linux, 2,488 bytes over the 4,898,000 limit of
that day. Merged with `862a9aa6`, fresh `bun run build:ui` and
`bun run build:core` on Linux measure 4,902,582 UI bytes; the entry chunk is
525,965 bytes, under its unchanged limit. The UI total limit becomes 4,906,000.

On 2026-10-13, the audit refactors and fixes measure 4,899,213 UI bytes,
compared with 4,897,240 at `bc3244ef`: an increase of 1,973 bytes (0.04%).
Fresh Linux builds match the Windows CI total. The existing workspace chunk
adds 1,585 bytes from composer helpers and boot lifecycle arguments; the
remaining changes include quota fixes and diagnostic labels. Both builds
contain 135 JavaScript chunks, with unchanged public-asset sizes and no
duplicate rendered module IDs. The UI total limit becomes 4,902,000, leaving
2,787 bytes; the entry and core limits stay unchanged. Reproduce with
`bun run build:ui` and compare files excluding compression sidecars, or run
`bun scripts/ci/budgets.ts` after building both UI and core.

On 2026-10-13, prompt-free draft preparation, attachment uploads and crash
recovery measured 4,853,814 UI bytes and 4,092,165 core JavaScript bytes after
`bun run build:ui`, `bun run build:core` and `bun scripts/ci/budgets.ts` on Linux.
Compared with `2893abd8`, the workspace chunk adds 6,904 bytes (0.14% of the UI)
and the core adds 35,861 bytes (0.88%). The UI entry remains 518,508 bytes and
the core entry 15,114 bytes. The total budgets rise to 4,870,000 and 4,110,000;
entry budgets stay unchanged. These are bundle sizes, not runtime memory or
startup measurements.

After integrating `af3acd8e` and the reservation ownership audit fixes, fresh
Linux builds on 2026-10-13 measure 4,870,320 UI bytes and 4,096,583 core
JavaScript bytes. The entries are 523,170 and 15,114 bytes. The merged UI
limit remains main's 4,872,000; the core total limit remains 4,110,000.
`bun scripts/ci/budgets.ts` passes all four measures.

On 2026-10-10 on Linux with Bun 1.4.2, `main` at `27aa04a8` measured about
4,438,500 UI bytes and 3,719,300 emitted core JavaScript bytes. The group relay
and notifications forwarded between members measured 4,442,877 and 3,731,676:
the core gains about 12,400 bytes for the relay route and its socket pipe, the
UI about 4,400 for relay routes, the member's notification target and the
English/French sentences. Merged with `bbffc85a`, the UI measured about
4,445,700 bytes and the core about 3,731,800. `budgets.json` then held 4,442,000
and 3,722,000, raised by `27aa04a8` and `bbffc85a` without this table, which
still said 4,435,000 and 3,714,000. The limits rose to 4,450,000 and
3,736,000. Merged with `b1faab5e`, whose project search had raised the UI limit
to 4,460,000, the UI measured 4,455,331 bytes, within it, and the core
3,733,915, 2,085 bytes under its limit after the plugin changes merged
meanwhile. The core limit rises to 3,740,000.

On 2026-10-11 on Linux with Bun 1.4.2, `26d9f7be` measured 4,455,331 UI bytes
and 3,734,556 core bytes, and reviewed goals (`/goal2`) on top of it 4,461,282
and 3,743,353: 5,951 UI bytes for the goal bar's verdicts, the fake core's
reviewer and the English/French sentences, and 8,797 core bytes for the
reviewer loop and its prompts. The Windows job measured 3,749,386 core bytes
for that same branch, 6,033 more than Linux. Merged with `b8dc6c21`, whose
limits were 4,466,000 and 3,744,000, the branch measured 4,469,022 and
3,749,375 on Linux, about 3,755,400 core bytes on Windows. The limits rise to
4,475,000 and 3,760,000.

On 2026-10-11 on Linux with Bun 1.4.2, `main` at `4762402b` measured 4,471,508
UI bytes with a 581,473-byte entry chunk. Several drafts per project, the
composer's own undo history and image-carrying copy, the work counts on the
Threads/Agents switch, the merged project fold, thread-like done rows with long
press and their English/French sentences measured 4,493,255 and 590,779: 21,747
bytes in all, 9,306 of them in the entry chunk. The display options panel loads
on its own (6,646 bytes of JavaScript, 3,613 of CSS) to keep the entry chunk
under its unchanged 591,000. The Windows job measured the same UI total. The UI
limit rises to 4,500,000. Merged with `5dd77e39` and its review fixes, the
Windows job measured a 591,007-byte entry chunk at `b294a3da`, and the next
fixes 591,270 on Linux. A done row now loads with the first done rows (5,167
bytes of JavaScript, 3,113 of CSS): the entry chunk measured 587,071 and the UI
4,496,036. Merged with `daff9a53`, whose agent discussions had raised the UI
limit to 4,500,000 on their own, the Windows job measured 591,322 and
4,508,531 at `a1bd2cc4`. The project fold's rows now load at its first opening
or after the list has drawn (7,250 bytes of JavaScript, 3,406 of CSS): on Linux
the entry chunk measured 585,204, under its unchanged 591,000, and the UI
4,511,041. The UI limit rises to 4,525,000.

Later on 2026-10-11 on Linux with Bun 1.4.2, `main` at `5dd77e39` measured
4,472,003 UI bytes and 3,749,519 core bytes, and settings cards (`boite
settings`) on top of it 4,495,656 and 3,760,802; the Windows job measured
3,760,540 core bytes for an earlier head of that branch. The core gains 11,283
bytes for the card checks, the CLI and MCP commands; the UI 23,653 for the
card, which loads outside the entry chunk, its English and French sentences
and the shared checks in contracts. The entry chunk grows 5,016 bytes, to
586,462. The limits rise to 4,499,000 and 3,767,000. `main` at `da347f40`,
whose agent mail had raised the UI limit to 4,500,000 without this table,
measured 4,485,829 UI bytes, a 585,698-byte entry chunk and 3,754,727 core
bytes; merged with settings cards, 4,509,505, 590,714 and 3,766,024. The
limits rise to 4,515,000, 593,000 and 3,772,000, the core keeping room for the
Windows job's larger build.

On 2026-10-12 on Linux with Bun 1.4.2, the latency pass (idle warm-up of the
pages, kept Agents view, optimistic pin and archive, single permission answer)
merged with `main` measured 4,513,690 UI bytes and a 591,872-byte entry chunk,
within the limits above.

On 2026-10-12 the Windows job measured 4,623,852 UI bytes for device keys in
the group merged with `main` at `5ee76431`: the signing chunk
(`@noble/ed25519`, loaded at the first signature), Add a device and the group's
device rows. The UI limit rises to 4,640,000. The same job then measured
3,927,501 core bytes: signed hellos, device admission and served origins
(`group/clients.ts`, `group/device-keys.ts`). The core limit rises to 3,935,000.

On 2026-10-12 on Linux with Bun 1.4.2, the terminal rewrite (#453) measured
4,802,359 UI bytes, 593,425 for the entry chunk and 3,915,408 core bytes; the
Windows job measured 3,915,831 core bytes. The xterm WebGL, search and Unicode
11 addons are lazy chunks of 113,385, 31,879 and 24,853 bytes, loaded with the
first terminal, never at startup. The find bar, the recent commands list and
their English/French sentences make up the rest of the UI growth, and the bash
and PowerShell integration scripts the core's. The limits rise to 594,000,
4,810,000 and 3,925,000.

Merged with `main` at `5feb7d82` on Linux it measured 4,814,973 UI bytes,
556,942 for the entry chunk and 3,942,646 core bytes, after the device keys
above. The UI limit rises to 4,823,000 and the core limit to 3,951,000.

On 2026-10-13 on Linux with Bun 1.4.2, `main` at `b5d73b56` measured 3,943,237
core bytes and the dependency update on top of it 4,022,479. The Claude Agent
SDK (0.3.283 to 0.3.296) grows its lazy chunk by 70,752 bytes and the ACP SDK
(1.5.0 to 1.8.0) its own by 7,662; neither loads at startup. The core limit
rises to 4,030,000.

Context modes, the same day on Linux, measured 4,829,171 UI bytes and 4,031,205
core bytes against 4,822,797 and 4,023,886 for `main` at `aa0ced74`: 6,374 UI
bytes for the badge, the fake client's checks and the English/French sentences,
and 7,319 core bytes for the resolution, the journal column, the CLI flags and
the driver options. The UI limit rises to 4,836,000 and the core limit to
4,040,000.

On 2026-10-13 on Linux with Bun 1.4.2, `main` at `aa0ced74` measured 4,822,797
UI bytes and a 557,709-byte entry chunk. The dictation spectrum, the reasoning
ramp, favorites shared through each core's settings with their check, folds
that follow the list and their English/French sentences measured 4,836,660 and
562,724 on top of it, as the Windows job did: 13,863 bytes. Merged with context
modes at `c8e9d2ac`, whose limit was 4,836,000, the branch measured 4,843,049 UI
bytes. The UI limit rises to 4,850,000. With the earlier reasoning slider back,
lit by level and crossed by speed streaks, and the dictation in a floating
menu, it measured 4,845,313 bytes and a 557,726-byte entry chunk. Merged with
persistent agents and their setting cards at `2893abd8`, whose limit was
4,860,000 and which measured 4,846,910, the branch measured 4,863,429 UI bytes,
the same 16,519 bytes on top. The UI limit becomes 4,872,000.

Opening a thread on one screen of history (#472) measured 4,823,117 UI bytes
merged with `main` at `224597ed` (4,822,128), as the Windows job did: 989 bytes
for the page byte budgets the store sends, the list that pages itself when it
cannot scroll, the old first row put back after a page lands, and the fake
core's budgets. Merged with context modes at `c8e9d2ac` it measured 4,830,160,
within the 4,836,000 above; merged with the dictation menu at `af3acd8e`,
4,864,454, within 4,872,000.

The update card, merged with `main` at `8ac1d98f`, measured 4,888,826 UI bytes
and a 522,879-byte entry chunk on Linux, against 4,864,454 for `main`: 24,372
bytes for the card, its rows and buttons, the Update all button in Machines and
their sentences ([performance](performance.md#update-everything)). The UI limit
rises to 4,898,000.

Several drafts per project, merged with settings cards at `87fca361`, measured
4,536,091 UI bytes and a 590,215-byte entry chunk on Linux: the done rows and
the project fold's rows load outside the entry chunk, which stays under 593,000.
Merged with `bafe8898`, whose diagnostic logs had raised the UI limit to
4,581,000, the branch measured 4,606,394 UI bytes, a 591,099-byte entry chunk
and 3,901,792 core bytes on Linux the same day. The UI limit rises to
4,620,000.

On 2026-10-12 on Linux with Bun 1.4.2, `main` at `8035c2f7` measured 4,608,637
UI bytes and a 591,096-byte entry chunk. Edge scrollbars and load on press on
top of it measured 4,625,475 and 591,725, as the Windows job did: 16,838 bytes
in all. The scrollbar overlay (6,168) and the press listener (3,575) load only
while their switch is on; their starter (2,397) loads after mount, and the
entry chunk gains 629. Merged with `a0c02d16`, whose shared thread and agent
code shrank the UI, the branch measured 4,602,452 and 554,651, within the
unchanged 4,620,000 and 593,000.

On 2026-10-10, `bun run build:ui` with Bun 1.4.2 measured 4,420,649 UI bytes at
`feeb393b` and 4,425,557 with close confirmation and typed agent archival.
The dialogs, input binding and English/French sentences add 4,908 bytes. The UI
total limit increases by 5,000 bytes to 4,429,000, leaving 3,443 bytes; entry
and core limits stay unchanged.

On 2026-10-10 the Windows CI job printed 4,321.8 KB of UI and 3,623.0 KB of
core JavaScript for `main`, and 4,481,389 and 3,815,569 bytes for the
diagnostic logs branch. The UI gains about 56 KB for the Diagnostics page, the
report dialog, the client error reporter and their English/French sentences;
the core about 106 KB for the instrumentation of every subsystem, the
anonymizer, the export and the `boite logs` and `boite issue` commands. A local
Linux build of the same head measured 3,823,800 core bytes. The UI total limit
becomes 4,493,000 (this increase on top of `main`'s own) and the core JavaScript
limit 3,826,000; entry and core
bundle limits stay unchanged.
Merged with `ed68bd94` (group relay, project search, plugin updates), a local
Linux build of the branch measured 4,511,575 UI bytes and 3,843,682 core
bytes, and the limits become 4,520,000 and 3,852,000. Merged with `ffd433a4`,
whose firewall check had raised `main`'s limits by 6,000 and 4,000 bytes, the
branch measured 4,516,117 and 3,851,614 on Linux on 2026-10-11, and its limits
take the same increase: 4,526,000 and 3,856,000. Merged with `b8dc6c21`, whose pairing
card raised `main`'s limits by the same 6,000 and 4,000 bytes again, the
branch measured about 4,519,200 and 3,851,600 the same day, and its limits
become 4,532,000 and 3,860,000. The review fixes that followed (redaction
before bounding, strict diagnostics parameters, safer file writes) brought the
core to about 3,859,000 bytes on Linux on 2026-10-11, under 1 KB from its
limit, so the core JavaScript limit rises by 4,000 to 3,864,000.
Merged with `0b13bd40` and `957768a8`, whose reviewed goals raised `main`'s
limits by 9,000 and 16,000 bytes, the branch measured about 4,524,600 and
3,868,100 on Linux on 2026-10-11, and its limits take the same increase:
4,541,000 and 3,880,000.
Merged with `e7b2b8c8`, whose agent mail raised `main`'s UI limit by 25,000
bytes to 4,500,000, the branch's UI limit takes the same increase: 4,566,000.
`main` kept its core limit while its own changes grew the merged core by about
10,400 bytes: the branch measured about 4,542,500 UI bytes and 3,879,700 core
bytes on Linux on 2026-10-12, 300 bytes under its core limit, which rises to
3,900,000.
Merged with `87fca361`, whose settings cards raised `main`'s limits by 15,000
UI bytes, 2,000 entry bytes and 12,000 core bytes, the branch measured
4,567,439 UI bytes and 3,891,447 core bytes on Linux on 2026-10-12, and its
limits take the same increases: 4,581,000, 593,000 and 3,912,000.

On 2026-10-12 on Linux, `main` at `bafe8898` measured 4,579,818 UI bytes. Priced
usage rows measured 4,581,495: the UI gains 1,677 bytes for the rate notes and
their English and French sentences. Merged with `5ee76431`, the branch measured
4,608,071 UI bytes, under the 4,620,000 that `main` had set by then, and
3,908,480 core bytes with its table of public API rates, under the unchanged
3,912,000. No limit changes.

On 2026-10-03, fresh builds of `e1f00a3` measured 2,695,204 core bytes and 3,932,309
UI bytes. The orchestration additions measured 3,228,444 and 3,943,301 bytes:
the core gains 533,240 bytes, mostly the official MCP SDK and its validation
dependency, loaded only by `boite mcp`; the UI gains 10,992 bytes for recovery,
task history, capabilities and fork return. The entry sizes stayed below their
unchanged limits. These are build sizes, not startup or memory measurements.

Sizes and blurs for deferred pictures measured 3,587,361 emitted core bytes
on Windows CI on 2026-10-06, 7,361 bytes above the previous 3,580,000 limit:
the image header parser and the preview queue.

On 2026-10-07 on Linux, `main` at `d32a4a95` measured 4,250,457 UI bytes, 457
above the 4,250,000 limit after the Machines and updates page and the
mid-turn effort changes, and 3,597,242 emitted core JavaScript bytes. The UI
limit rises to 4,270,000 and the core JavaScript limit to 3,615,000, leaving
about 19 KB and 18 KB of headroom.

The agents' chat, entrusted threads and robots, on the same `main`,
measured 4,336,325 UI bytes and 3,602,928 emitted core JavaScript
bytes on Linux on 2026-10-07. The UI limit rises to 4,355,000, leaving about
19 KB of headroom; the core JavaScript limit of 3,615,000 leaves about 12 KB.

Later the same day `main` at `9356e7b6` measured 4,355,057 UI bytes on Windows
CI, 57 above that limit, after the panel's keyboard, mouse and clipboard
input. The mouse's back and forward buttons add 2,301 bytes, measured on Linux
with and without them: 4,357,517 against 4,355,216. The UI limit rises to
4,375,000, leaving about 17 KB of headroom. Formatting clocks in the
machine's region adds 434 UI bytes, measured on Linux at `9356e7b6` with and
without it: 4,355,491 against 4,355,057 UI bytes.

Inline views, on `main` at `7d1f126c`, measured 4,385,281 UI bytes and
3,672,277 emitted core JavaScript bytes on Linux on 2026-10-07, 27,764 UI
bytes above the 4,357,517 measured just above and 46,642 core bytes above the
3,625,635 that `main` measured when built the same way. The core gains
publishing a page, the headless check, the kit stylesheet stored with each
page, and the texts `boite view help` and `boite view example` print. The UI
gains the frame, the order of views in the timeline, and the kit and
bootstrap, which the client chunk keeps because the fake client stores pages
with them. The UI limit rises to 4,405,000 and the core JavaScript limit to
3,690,000, leaving about 20 KB and 18 KB.

On 2026-10-09 on Linux, `main` at `4f5a3f66` measured 3,689,568 emitted
core JavaScript bytes, 432 below the 3,690,000 limit. Counting a thread's open
asynchronous questions on its row adds 812 bytes: 3,690,380 with it. The core
JavaScript limit rises to 3,710,000, leaving about 19 KB.

A conversation following its agent to another account adds 1,233 core bytes,
measured on Linux on 2026-10-09 against `main` at `a5646a7e` built the same
way (3,690,646 against 3,689,413): the account fallback and the title model
chosen by family. It fits under the same 3,710,000 limit.

Managed releases that follow their publisher, Claude's on Windows, add about
7 KB: reading the version file and the manifest, the forward-only rule and the
update joining an older download. Merged with `main` at `2ffd95e0`, they measured
3,703,464 bytes on Linux on 2026-10-10, under the same 3,710,000 limit.

Choosing the machine a new agent runs on, with the form's labelled rows,
adds 5,137 UI bytes: 4,430,694 against 4,425,557 for `main` at `19ef51b2`,
measured on Linux on 2026-10-10. A machine icon in the picker cost another
2,563 bytes through a chunk split and was left out. The UI limit rises from
4,429,000 to 4,435,000, leaving about 4 KB.

The Windows Defender Firewall check and its pairing-card notice add 3,866 UI
bytes and 5,792 emitted core JavaScript bytes: 4,445,296 and 3,726,463 against
4,441,430 and 3,720,671 for `main` at `64a0b6ad`, measured on Linux on
2026-10-10. Merged with `main` at `ed68bd94` they measured 4,459,197 and
3,739,869 bytes, within the 4,460,000 and 3,740,000 limits set there.
Making the computer reachable from the pairing card, its restart and its
sentences add 2,958 UI bytes and 175 core bytes on top: 4,462,155 and 3,740,044
measured the same way. The UI limit rises to 4,466,000 and the core JavaScript
limit to 3,744,000, leaving about 3.8 KB and 4 KB.

Recent's Done and Working groups measured 3,949,936 UI bytes on 2026-10-03
before integrating these orchestration additions. The combined build measured
3,961,330 UI bytes and 3,239,585 emitted core JavaScript bytes on the same day.
Reproduce it with `bun run build:ui && bun run build:core && bun scripts/ci/budgets.ts`.

Provider switches and OpenCode 2 measured 4,256,207 UI bytes and 3,616,381
emitted core JavaScript bytes on the same day, on `main` at `6bf59cd7`: 5,750 UI
bytes for the switches, the Turned off group and the composer chip, and 19,139
core bytes for the second descriptor, the version readings behind a
candidate's `major`, the SQLite login, the switch and the subscription proxy's
provider block for OpenCode 2. The core JavaScript limit rises to 3,640,000.
With the agents' chat merged, the build measured 4,342,122 UI bytes and
3,622,067 core bytes, 12,878 and 17,933 under their limits.

On 2026-10-05 on Linux, `origin/main` at `290220a9` measured about 4,183,200 UI
bytes and 3,446,800 emitted core JavaScript bytes. Stewards and the owner's
control commands measured 4,205,907 and 3,487,583: the steward settings, letter
labels and their translations add about 22,700 UI bytes, and the grant checks,
notices and control CLI about 40,800 core bytes. The UI limit rises to
4,225,000 and the core JavaScript limit to 3,505,000, leaving about 19 KB and
17 KB of headroom.

The agent browser on the conversation's machine ([the agent's browser](browser.md))
then measured 3,531,655 bytes of emitted core JavaScript on the same day: the
DevTools client, the browser launcher, the in-browser recorder and the page
scripts add about 44,100 bytes, less the removed desktop relay. The core
JavaScript limit rises to 3,550,000, leaving 18,345 bytes of headroom; the
other limits are unchanged.

On 2026-10-03, `290ba1f3` measured 3,977,635 UI bytes. Adding project Working
and Done counters, folded project lists and their empty states measured
3,983,551 bytes, a 5,916-byte increase using the same source filename hashes.
At that revision the UI total limit was 3,990,000 bytes, leaving 6,449 bytes of headroom. The
534,926-byte entry remains below its unchanged limit; core limits are unchanged.

On 2026-10-03, Linux
UI builds with Bun 1.4.2 measured 3,950,303 bytes at `df3159d4` and 3,974,754
bytes at `807387a0` after the vertical text alignment changes. Text leaves and shared label
rules add 24,451 bytes (0.62%). Windows desktop CI at `a77909e6` measured
3,983,734 bytes, above the former 3,980,000-byte limit. The 4,020,000-byte
limit retains 36,266 bytes above that Windows measurement. Alignment changes
leave the entry and core limits unchanged.

On 2026-10-04, Linux core builds measured 3,409,224 emitted JavaScript bytes at
`0f8104b1` and 3,424,372 bytes on the subagent branch (model routing,
`boite delegate` output and the delegation guide). Windows desktop CI measured
3,424,333 bytes, above the former 3,420,000-byte limit. The 3,460,000-byte
limit retains 35,667 bytes above that measurement; `dist/main.js` stays at
13,211 bytes.

Main's desktop CI at `72cc0b92` reported 4060.0 KB of UI, about 2,600 bytes
below the former 4,160,000-byte limit. Merged with main, the subagent branch measured
4,160,739 bytes on Linux and in desktop CI: about 3,300 bytes for the model and
reasoning picker, the team view and their translations. The 4,200,000-byte
limit retains 39,261 bytes above that build; the entry limit stays unchanged.

After integrating main at `8b72af5b` and aligning the new proxy controls, the
same Linux setup measured 3,992,019 UI bytes, within the existing limit.
On 2026-10-03, phone remote coding merged with main at `c3e9c37` measured
4,068,675 UI bytes on Windows, and 4,069,242 with its review fixes: about
107 KB above the combined build for the phone composer, viewer, browser sharing
and settings. The 4,100,000-byte limit keeps 30,758 bytes above it; the entry
and core limits are unchanged.
On 2026-10-04, Windows desktop CI measured 4,101,897 UI bytes for main at
`bb14bf55`, after the Device panel. Thread terminal tabs, splits and their
reconciliation merged with it measured 4,120,993 bytes on Windows, 19,096 more.
The 4,160,000-byte limit keeps 39,007 bytes above it; the entry and
core limits are unchanged.
On 2026-10-04, Linux builds with Bun 1.4.2 measured 4,097,984 UI bytes and
3,341,343 emitted core JavaScript bytes for main at `eb69e5bf`. Machine groups
merged with it measured 4,123,339 and 3,391,488: the UI gains 25,355 bytes for
the group card, its sentences in two languages and the group links, within its
unchanged limit; the core gains 50,145 bytes for the roster, sealing, tickets
and the join route. The core total limit becomes 3,420,000 bytes, 28,512 above
this measurement; the entry and `main.js` limits are unchanged.

On 2026-10-10 on Linux, `origin/main` at `bbffc85a` measured about 4,441,400 UI
bytes, under 1 KB below its limit. The draft's searchable project dropdown
measured 4,450,765 bytes, and Windows desktop CI 4,450,386 on its first head:
about 9,400 bytes for the search, the keyboard walk, the machine groups and two
sentences in each language. The UI limit rises to 4,460,000, 9,235 bytes above
the Linux build; the entry and core limits are unchanged.

On 2026-10-13 on Linux, `origin/main` at `c8e9d2ac` measured 4,829,171 UI
bytes and 4,031,205 emitted core JavaScript bytes. Persistent agents taking
over from stewards measured 4,825,176 and 4,039,499: removing the steward
settings saves the UI 3,995 bytes net of the projects field, files, memory chip
and brain folder, and the core gains 8,294 bytes for the projects entrusted to
an agent, its notices, the memory pass and the brain folder move. The core
total limit becomes 4,050,000 bytes, 10,501 above this measurement; the UI,
entry and `main.js` limits are unchanged.
Cards asking the user to change an agent's settings, merged with `68898598`
the same day, measured 4,846,910 UI bytes and 4,056,373 core bytes: about
21,700 UI bytes for the lazy card, the conversation's card for an agent's
pending questions, the in-memory client's three methods and the sentences in
both languages, and about 16,900 core bytes for the cards, their shared checks,
the CLI command and two MCP tools. The UI limit becomes 4,860,000 and the core
total limit 4,070,000; the entry chunk (518,508 bytes) and `main.js` limits are
unchanged.
Explain measured growth when changing a limit. Shared-runner timings are not gated. Earlier sizes and
runner observations remain in the [dated report](../bench/results/2026-09-29-resources.md#historical-ci-measurements).

### E2E preparation

`BOITE_E2E_PREBUILT_UI=1` tests the built production UI and refuses missing
artifacts; local E2E rebuilds by default. `shell.test.ts` runs against the
installer in the desktop job. Every other E2E file enters one of three Windows
shards. Files run sequentially within a shard with separate ports, data and
browser profiles. Matrix `fail-fast: false` preserves other shards' results
after a failure.

The `Build UI` job builds both UIs once on Linux: `bun run build:ui` (artifact
`ui-dist`, `.well-known` included) and the fake-client bundle
(`bun tests/e2e/lib/warm.ts --build-only`, artifact `ui-e2e-fake`). The shards
and stress download them instead of building about 31 s each on Windows.
On `6004522f` (2026-10-17), the Linux UI of `app.yml` run 39065496375 and a
Windows build of the same commit had the same 459 files and, chunk hashes aside,
the same JavaScript, HTML and manifest. The only differences: lightningcss
rounds one `lab()` value in the CSS at its sixth decimal (`.857866` against
`.857878`), which renames every chunk importing that stylesheet and the service
worker's build id, and each `.gz` carries its OS byte (3 or 10). The installer
still builds its own UI on Windows.

Shards are cut by `scripts/ci/e2e-shards.ts` from
[e2e-durations.json](../scripts/ci/e2e-durations.json), the seconds each file
took on recorded green runs: files go longest first to the lightest shard, and
a file with no record counts as the median. `bun test --shard` cut by file
count and ran 285 to 317, 410 to 417 and 501 to 519 s of tests; the recorded
seconds of 2026-10-17 split into 376, 376 and 376 s. Refresh the record after
adding or reshaping heavy files, from one or more green `ci.yml` runs:

```sh
bun scripts/ci/e2e-shards.ts refresh <run id> [<run id> ...]
```

It reads each run's `E2E n/3` logs with `gh`, where `bun test` opens a group
per file, averages the runs and prints the new split. `bun scripts/ci/e2e-shards.ts
<shard> 3` prints a shard's files. `e2e-shards.test.ts` fails when the record
splits the current files more than 15 % apart.

`tests/e2e/lib/warm.ts` logs phase starts, elapsed times and errors, optimizes
Vite once with `NODE_ENV=test`, and builds `BOITE_E2E_FAKE_UI` with the same
fixture plugin used by `startDevUi`; in CI it runs `--prebuilt` on the
downloaded bundle and refuses a directory without `index.html`. It consumes the optimized dependency body
before closing Vite. Tests importing or blocking `/src/` URLs still use a dev
server, warming reachable modules within its 60-second hook. Job deadlines stay
35 minutes. Failure captures are attempted on cancellation too.

The first Chrome of a hosted Windows runner can take over 30 seconds to open
its debugging port, which failed the first browser test of a shard on `main`
and on branches on 2026-10-07. `warm.ts` therefore opens the fake-client bundle
in a browser once before the tests, where nothing has a deadline, and only
warns when that browser does not come up. `BrowserPage.launch` starts a fresh
browser once more when the first never reached its page: no debugging port,
no devtools socket, or a first navigation that did not commit in 20 seconds.
It logs `[e2e] the browser did not start` when it does. Nothing the page does
after it has loaded is retried.

Both E2E steps point `TEMP` and `TMP` at `runner.temp`, on the runner's D:
drive, so browser profiles and core data directories leave C:. With them on
C:, Chrome held page loads for 15 to 60 s after the UI server had answered every
request, while a fresh connection to the same server got the file in
milliseconds: 8 such stalls in 5 of 9 shard runs, against none in 9 on D:, and
706 s of tests against 420 s (PR #513, 2026-10-15). They had failed about one
shard in five since 2026-10-10, on `main` as on branches, a different test each
time. `scripts/ci/e2e-harness.test.ts` keeps both variables on both steps.

CI Chromium uses CPU compositing with software GL disabled. Browser launch
failures retain bounded stderr; exited browsers fail promptly. Navigation waits
for committed state and asynchronous conditions, reporting page state, JS errors
and requests still in flight on failure. Background timer throttling is disabled.
WebView2 receives the hidden shell's debug port through its API; normal launches
ignore it. Hardware-audio tests skip hosts without a render endpoint, while
guard logic tests still run. Scripted Claude tests need no CLI login.

Shared Cargo targets are snapshotted into the checkout before shell tests so
another build cannot replace the tested executable. Thread-removal tests assert
RPC errors through `catch` and `toMatchObject` to avoid Bun 1.4.2 Windows
`.rejects` crashes. Kernel-handle assertions use a dedicated child through
`procs.spawn`; mobile Back tests await `popstate`.

### Measuring the E2E partition

`bench/e2e.ts` compares serial and sharded runs using JUnit case identities;
its shards are the CI ones.
It refuses failures, skips or a changed case list. Build/staging commands,
the 2026-09-28 local comparison and the first hosted PR #108 run are preserved
in the [dated report](../bench/results/2026-09-29-resources.md#e2e-partition-measurements-2026-09-28).
Measure local latency separately from hosted CI and review latency. More runners
can shorten elapsed time while increasing total runner minutes.

## boite (de nuit)

The nightly runs at 03:23 UTC and accepts manual dispatches on `main`.
`NIGHTLY_ENABLED=false` disables both; removing it or setting it to `true`
enables them. An already published commit skips every build. An unpublished or
failed build is eligible next time.

The nightly does not run CI again. Its `CI passed` job (`scripts/ci/commit-ci.ts`)
waits for the `ci` run that pushing this commit to main started. It reruns that
run's failed jobs once and fails unless the run ends green; a commit with no
such run after ten minutes fails. Beside it, `desktop.yml` builds and signs
each desktop package once and tests what ships: installer regressions and
native shell E2E on Windows, the installed Debian package, the extracted
AppImage and the macOS bundle. The Rust tests are skipped because the commit's
CI already ran them.

A dispatch with `dry-run` builds any branch with throwaway signing keys, even a
commit that already has a nightly. It accepts that
branch's pull request CI run without rerunning it, skips reservation and every
publication, and has its own concurrency group.

Versions use `2.0.0-nightly.YYYYMMDD.N`, taking the base from the manifest and
resetting the counter each UTC day. For example, September 15's first build is
`2.0.0-nightly.20260915.1`, then `.2` for a new commit. Build inputs stamp the
version; source manifests retain theirs.

The CI check, desktop builds and native image builds run alongside one
another. Only after all pass does reservation bind the tag to the exact commit. A publishing
failure keeps that tag for retry, including on a later day. A reserved tag alone
is not a successful release. `server-manifest.yml` promotes the tested digests
to `nightly`, the version and commit tags after reservation. It never moves
stable Docker `latest` or GitHub's latest stable release.

Stable and nightly desktop tracks share the regular install and data; Boite Dev
is separate ([updates](updates.md)). The server uses `dev`; use separate Compose
volumes ([server](server.md)). The signed or reused APK, which opens the phone
app's address, is required too; [Android](android.md) owns the host, signing
and reuse rules.

## The phone app's address

`app.yml` builds the UI on `main` when `packages/ui/`, `packages/contracts/` or
the workflow change, or by hand; from `main` it waits for that commit's CI to
pass (`scripts/ci/commit-ci.ts`, as the nightly does) and deploys it with
GitHub Pages to the
repository's custom domain, `APP_ORIGIN` in the contracts
([phone](phone.md#the-app-on-its-own-address)). It packs the site itself so
`/.well-known/assetlinks.json` ships, which `upload-pages-artifact` would leave
out as a hidden folder. Pages must use GitHub Actions as its source, and the
domain's DNS names `beboite.github.io`.

## Pull request reviews

`.coderabbit.yaml` enables advisory reviews and chat replies, excluding drafts
and generated artifacts. CodeRabbit is not a required check. Its installed App,
plan eligibility and quotas are external prerequisites.

Follow the [PR rules](../AGENTS.md#follow-through-on-pull-requests): inspect CI
and review findings together, verify and group fixes before pushing, and report
unresolved bugs or unavailable reviews. Acknowledgements need no reply or repeat
review request unless they contain a new finding. A regression test must catch
a failure existing coverage cannot detect.

## Security and labels

The hosted security policy uses CodeQL default setup for Actions,
JavaScript/TypeScript and Rust, secret scanning with push protection, and
Dependabot alerts/security updates. Vulnerability reports use the private
channel in [SECURITY.md](../SECURITY.md). Actions are pinned to full commit SHAs.
Hosted rulesets and security settings are managed separately from these files.

Dependabot runs weekly for the Bun workspace, `docker/agents`, Cargo, Docker
and Actions. Actions, agent CLIs and Cargo share the `weekly` multi-ecosystem
group. Workspace minor/patch updates share another PR; majors are separate.

The labeler uses `.github/labeler.yml` for `core`, `ui`, `shell`, `server`, `ci`
and `documentation`. It runs on `pull_request_target` without checking out or
executing PR code, with write scope limited to pull-request labels.

## Releases and server images

A `v<version>` tag must match package, Cargo and Tauri versions. Manual `release`
uses those versions and creates its tag after checks; neither entry increments
them. Full CI produces the tested signed desktop/server artifacts, updater
manifest and checksums for a maintainer-reviewed draft. Nightlies publish a
prerelease automatically. [Releasing](releasing.md#signed-update-artifacts)
owns signing and the nine updater targets.

Stable release images build and smoke-test once per architecture in `server.yml`,
using release-intended telemetry flags with networking disabled for smoke.
Run-specific staging tags retain the tested digests. The draft stores
`server-images.json` with SHA, version, tag, run ID/attempt and both digests, and
includes it in checksums. This metadata survives the one-day workflow digest
artifact retention.

On publication, `publish-server.yml` validates that metadata against the exact
release, tag commit, workflow run/attempt and successful version, verification,
image and draft jobs. Skipped or unrelated runs cannot supply proof. Publication
promotes those digests without rebuilding to the version tag and the compatible
`sha-<full commit>` alias. The SHA alias is mutable: stable and nightly builds
of the same commit can have different channels and versions, and either can
replace it. Pin a version tag or digest when that distinction matters.

Version promotions remain independent across releases. A separate job serializes
Docker `latest` promotion across the repository, without cancelling an active
promotion. After acquiring that group, it checks GitHub's current stable release
before writing `latest`; an older release cannot finish its write after a newer
promotion. An API or validation failure leaves `latest` unchanged. Retry by
dispatching publication on the same published tag.

The registry is `ghcr.io/<owner>/<repository>/boite-server`. Anonymous pulls
require public GHCR package visibility. Publishing uses `GITHUB_TOKEN`, without
a registry-password secret. CI does not contact a production host or migrate
Boite Legacy's separate `ghcr.io/beboite/boite-server` package.

## Automatic changelog

[Release notes](releasing.md#release-notes) cover commit ranges, grouping,
announcements and draft retries.

## Repository presentation

`.github/topics.json` holds the GitHub topics. Review it before applying:

```sh
gh api repos/beboite/boite/topics --method PUT --input .github/topics.json
```

This changes topics only; the About description is separate repository metadata.
