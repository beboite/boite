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
reporting, and loaded desktop/phone-width UI. It builds the UI first and retains
fixture evidence under `tests/e2e/.artifacts/stress/`. Live-provider tests stay
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
architectures of each OS.

`desktop.yml` holds the desktop builds: the Windows installer job and one job
per portable platform, named after it (`Desktop / macOS x64`). `ci.yml` calls
it with the Rust tests; the nightly calls it without them. Only `CI required`
and `PR title` are required checks, so a display name can change freely, except
the `release.yml` job names that `server-provenance.ts` checks.

Intel macOS packages are cross-built on the Apple Silicon runner with
`BOITE_TARGET=x86_64-apple-darwin`. The core compiles for `bun-darwin-x64`, and
the Rust tests and installed smoke check run as Intel binaries under Rosetta.
Only the core suite still runs on an Intel runner. On 2026-10-04 the Intel
desktop leg took 14.0 minutes and the Apple Silicon one 8.1 (nightly run
37234148865, the longest job of that run).

Core changes run the full core suite on Windows, Linux x64/ARM64 and macOS
ARM64/Intel in every mode. Linux desktop packages build on Ubuntu 22.04,
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

Cargo, Vitest and BuildKit save caches only from `main`. Cargo namespaces
separate Windows release builds and each portable runner. Vitest stores
transforms under `node_modules/.vitest-cache`; its namespace includes
`bun.lock`, Svelte/Vitest configuration and `packages/ui/icon-plugin.ts`.
Each Docker architecture has its own BuildKit scope. Agent dependency manifests
are copied before source files, so a core edit does not reinstall CLIs.

Bun follows `packageManager` and installs with `--frozen-lockfile`, without a
cached download store. UI tests use at most eight workers. Core files run in
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
once, and stages its existing core beside the shell for native E2E. Installer
regressions set `BOITE_CI_INSTALLER_REQUIRED=1`, so missing NSIS or generated
fixtures fail rather than skip. Unsupported local runs keep intentional skips.
The tested installer becomes the release artifact.

`scripts/ci/budgets.ts` reads [budgets.json](../scripts/ci/budgets.json):

| Measure | Maximum uncompressed bytes |
| --- | ---: |
| UI entry chunk | 593,000 |
| UI files, excluding `.br` and `.gz` copies | 4,938,000 |
| Core `dist/main.js` | 995,000 |
| All emitted core JavaScript, including lazy chunks and workers | 4,127,000 |

The total JavaScript measure excludes native binaries and source maps.

On 2026-10-15, views placed inside an answer (PR #502), merged with PR #497,
measure 4,935,954 UI bytes and 4,122,833 core JavaScript bytes after fresh
`bun run build:ui` and `bun run build:core` on Linux. The UI adds the answer
split around views. The UI limit becomes 4,938,000; the core and entry limits
stay unchanged.

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
installer in the desktop job. Every other E2E file enters three independent
Windows shards through `bun test --shard=N/3`. Each shard builds from the same
checkout and owns its Vite cache and fake-client bundle. Files run sequentially
within a shard with separate ports, data and browser profiles. Matrix
`fail-fast: false` preserves other shards' results after a failure.

`tests/e2e/lib/warm.ts` logs phase starts, elapsed times and errors, optimizes
Vite once with `NODE_ENV=test`, and builds `BOITE_E2E_FAKE_UI` with the same
fixture plugin used by `startDevUi`. It consumes the optimized dependency body
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

`bench/e2e.ts` compares serial and sharded runs using JUnit case identities.
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
