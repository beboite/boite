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

The Windows job shares release-profile Rust dependencies, builds the installer
once, and stages its existing core beside the shell for native E2E. Installer
regressions set `BOITE_CI_INSTALLER_REQUIRED=1`, so missing NSIS or generated
fixtures fail rather than skip. Unsupported local runs keep intentional skips.
The tested installer becomes the release artifact.

`scripts/ci/budgets.ts` reads [budgets.json](../scripts/ci/budgets.json):

| Measure | Maximum uncompressed bytes |
| --- | ---: |
| UI entry chunk | 588,000 |
| UI files, excluding `.br` and `.gz` copies | 4,345,000 |
| Core `dist/main.js` | 995,000 |
| All emitted core JavaScript, including lazy chunks and workers | 3,615,000 |

The total JavaScript measure excludes native binaries and source maps. On
2026-10-03, fresh builds of `e1f00a3` measured 2,695,204 core bytes and 3,932,309
UI bytes. The orchestration additions measured 3,228,444 and 3,943,301 bytes:
the core gains 533,240 bytes, mostly the official MCP SDK and its validation
dependency, loaded only by `boite mcp`; the UI gains 10,992 bytes for recovery,
task history, capabilities and fork return. The entry sizes stayed below their
unchanged limits. These are build sizes, not startup or memory measurements.

Sizes and blurs for deferred pictures measured 3,587,361 emitted core bytes
on Windows CI on 2026-10-06, 7,361 bytes above the previous 3,580,000 limit:
the image header parser and the preview queue.

The agents' chat, entrusted threads and robots, merged with `main` at
`bdd28f7b`, measured 4,329,091 UI bytes and 3,596,505 emitted core JavaScript
bytes on Linux on 2026-10-07. The UI limit rises to 4,345,000 and the core
JavaScript limit to 3,615,000, leaving about 16 KB and 18 KB of headroom.

Recent's Done and Working groups measured 3,949,936 UI bytes on 2026-10-03
before integrating these orchestration additions. The combined build measured
3,961,330 UI bytes and 3,239,585 emitted core JavaScript bytes on the same day.
Reproduce it with `bun run build:ui && bun run build:core && bun scripts/ci/budgets.ts`.

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

A dispatch with `dry-run` builds any branch with throwaway signing keys and an
unsigned APK, even a commit that already has a nightly. It accepts that
branch's pull request CI run without rerunning it, skips reservation and every
publication, and has its own concurrency group.

Versions use `2.0.0-nightly.YYYYMMDD.N`, taking the base from the manifest and
resetting the counter each UTC day. For example, September 15's first build is
`2.0.0-nightly.20260915.1`, then `.2` for a new commit. Build inputs stamp the
version; source manifests retain theirs.

The CI check, desktop builds, native image builds and Android run alongside one
another. Only after all pass does reservation bind the tag to the exact commit. A publishing
failure keeps that tag for retry, including on a later day. A reserved tag alone
is not a successful release. `server-manifest.yml` promotes the tested digests
to `nightly`, the version and commit tags after reservation. It never moves
stable Docker `latest` or GitHub's latest stable release.

Stable and nightly desktop tracks share the regular install and data; Boite Dev
is separate ([updates](updates.md)). The server uses `dev`; use separate Compose
volumes ([server](server.md)). The signed or reused APK is required too;
[Android](android.md) owns the host, signing and reuse rules.

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
