# CI and publication

The `main protect` ruleset refuses direct pushes, force pushes and deletion of
`main`. Changes land through a squash-merged pull request once the required
checks `CI required` and `PR title` pass. No approval is required; CODEOWNERS
only requests reviews. Repository admins can bypass the rules when merging a
pull request, never on a direct push.

`CI required` fails when an applicable check fails or is cancelled, including
when a dependency never starts. Documentation-only changes still produce it.

`PR title` runs `scripts/ci/pr-title.ts` on every title edit. The squash commit
takes the title, so it must read `type(scope): summary` with a type among `feat`,
`fix`, `perf`, `refactor`, `docs`, `test`, `ci`, `build`, `chore` and `revert`.
The squash commit message body is left empty.

The changes job also runs `check:architecture` and its regression tests, even
for documentation-only changes. Runtime dependency cycles and forbidden
cross-package imports fail before the build matrix starts. So does a
production source file above 900 lines: the files already past it are listed in
`scripts/architecture/size-budget.json` at their size on 2026-09-25, and may
shrink but not grow. The contract, the in-memory client and the UI string
tables are exempt, since every new RPC method or UI sentence adds to them. The advisory complexity report does not impose a numeric
merge threshold.

The changes job runs `scripts/ci/translations.ts` too. A UI sentence that
exists in English and not yet in another language is a warning there, with its
path, and does not block a merge or a nightly. The release workflow runs the
same script with `--release` in its version job, before any build, and a
missing sentence fails it ([language.md](language.md)).

The `release tags` ruleset keeps `v*` tags from being moved or deleted. Creating
one stays open, which the nightly reservation and a manual release rely on.

## Checks

| Change | Checks |
| --- | --- |
| Markdown docs, license, security policy, code of conduct, issue and pull request templates, CODEOWNERS, labeler rules, topics | Local documentation links and CI decision tests |
| Shell files or end-to-end tests | Windows shell tests, installer build and full end-to-end suite; Linux x64 and macOS ARM64 shell builds and Rust tests |
| Dockerfile, .dockerignore, docker/ | Docker smoke tests on native x64 and ARM64 |
| UI files | Type checks, UI tests, desktop checks and Docker smoke tests |
| `apps/android/`, `android.yml`, `scripts/ci/android-apk.ts` | Unsigned APK build |
| `bench/`, `telemetry/`, `scripts/architecture/` | Type checks and UI tests: `bun run check` covers the benches and the telemetry Worker |
| Core, contracts, dependencies, shared build files, workflows, unknown paths | All checks, including core tests on Windows, Linux and macOS |
| Version tag | Complete checks, then a draft release for Windows, Linux and macOS |
| Nightly with an unpublished commit | Complete checks, signed nightly installers for all three systems, signed or reused APK, development server image, prerelease |

Pull requests against any branch run CI. A newer commit cancels an older run of
that same PR. New main commits also cancel superseded ordinary CI runs.

`scripts/ci/changes.ts` picks a mode besides the affected checks. A pull request
(`pr`) runs the portable desktop checks on Linux x64 and macOS ARM64 only. The
push on main that follows a merge (`warm`) skips the core tests and the Windows
end-to-end suite the pull request already passed. It still builds every
affected job, runs the Rust tests and the portable checks on all four
platforms, Linux ARM64 and macOS x64 included, and saves the caches pull
requests restore. A tag, a release, a nightly and a manual run (`full`) run
everything.
Release and publication jobs finish instead of being interrupted
halfway through an upload. Live-provider tests stay disabled.

Linux and macOS run Rust tests, build Debian/AppImage packages and a macOS application
bundle and DMG, then launch the installed shell outside the checkout with a minimal PATH.
The Debian install, extracted AppImage and signed macOS bundle each run the smoke
test, which checks core startup, bundled UI serving, authenticated RPC and an
echo turn with a fresh data directory. It does not exercise native desktop controls.
The WebView2 shell end-to-end suite remains Windows-only.
Portable desktop checks run on x64 and ARM64 for both Linux and macOS, the
second architecture of each only after a merge and on a release. Linux uses
the Ubuntu 22.04 runners: the packages they build are the ones a release
publishes, and 22.04's glibc sets the oldest Linux they run on.
Core changes run the core tests on all five runners before a merge: Windows,
Linux x64 and ARM64, and macOS ARM64 and Intel. The portable desktop jobs do
not repeat those tests after a merge.

Artifact uploads retry once through the shared upload action. A failed first
attempt can leave an artifact name reserved, so the retry replaces that name.
If the retry fails too, the job fails. Tests and builds are not retried.

## Build cost

Caches are saved from main only: Cargo, Vitest and Docker BuildKit. GitHub
lets a pull request read main's caches but scopes what it saves to that pull
request, and a repository keeps 10 GB. When every pull request saved its own
copies, 13.5 GB were active on 2026-09-22 and the eviction had removed main's
Windows Cargo cache and both Linux ones, so the Windows job rebuilt the whole
shell on every run.

Bun uses `packageManager` in the root manifest. Installs use the frozen lockfile
without a cached download store: its 200 to 350 MB per platform took a quarter
of the cache, and an install without it was no slower (the whole setup step on
macOS ARM64, 2026-09-22: 8 s on a miss, 10 s on a hit). The UI tests
use at most eight workers and persist transformed modules in Vitest's disk cache.
The cache key includes the lockfile and the Svelte and Vitest configuration;
Vitest validates individual source files when loading cached transforms.

Core test files run in fresh Bun processes, with four files at once by default.
`BOITE_TEST_WORKERS` accepts 1 to 8; `bun run --cwd packages/core test:serial`
runs one file at a time. Every core retains its own temporary data directory
and port. This avoids reusing Bun's native runtime between FFI tests after a
Windows Bun 1.4.2 worker crash and late-file timeouts observed on 2026-09-29.
The runner prints full per-file output and fails on any nonzero exit. The old
reused-worker runner took 189 s serially, 35 s with 16 workers and 53 s with
4 workers on 2026-09-25; those timings do not describe the fresh-process runner.

Thread-removal tests check rejected RPC errors with `catch` and
`toMatchObject`, including their code, message and data. Bun 1.4.2 on Windows
can crash after these scenarios when `.rejects` matchers are used, including
`.rejects.toMatchObject`. A successful response has no RPC error and fails
the explicit assertion; the ownership and deletion checks remain enforced.

Process-wide kernel handle assertions run in a dedicated child through
`procs.spawn`: a reused test worker can retain handles from earlier files.
The child still checks the real handle count and Job Object cleanup.
Mobile history tests wait for `popstate` before issuing the next Back; a fixed
delay can finish before the traversal it was meant to await.

Where the time goes, from `gh run view` on the 23 finished `ci` runs before
2026-09-25 14:20 UTC: a run took 13.8 minutes at the median. The Windows
desktop job sets that length (12.8 minutes): 5.8 for the end-to-end suite, 3.5
for the installer build and 1.1 for the Rust tests. Every other job a pull
request waits on finishes in under 6 minutes; the Windows core job took 4.9, of
which 4.1 were the serial core tests that parallel workers now shorten. The
Intel macOS portable leg (16.2 minutes) runs only after a merge and on
releases. Four of those runs failed: three in the Windows end-to-end suite and
one in the Ubuntu core tests. Rerun the same query before quoting new numbers.

The Windows job builds the installer and runs Rust tests in the release profile,
sharing compiled dependencies. Successful main jobs save Cargo caches under a
release-specific key. Failed or interrupted jobs do not save an incomplete cache
that GitHub would keep immutable.
It builds the installer once, then copies the existing sidecar beside the shell
for end-to-end testing. It does not recompile the core just to stage it again.
After the build, `scripts/ci/budgets.ts` fails the job when the UI's entry
chunk, the whole UI without its `.br` and `.gz` copies, or the core's
`dist/main.js` grows past its limit in `scripts/ci/budgets.json`. The limits
sit about 10% above the sizes measured on 2026-09-26 (337 KB, 2221 KB and
649 KB; `main` built a 681 KB core that day). The core's limit moved on
2026-09-27 to 10% above the 726 KB core of the agent hooks change, whose
descriptor checks, profile sharing and hook ledger all run at startup. The
whole UI's limit moved on 2026-09-28 to 10% above 3003 KB, once Settings,
Appearance, Reading bundled seven more faces (about 600 KB of woff2 and their
licences): a browser fetches a face's file only after it is picked, so the
entry chunk and the first screen do not carry them. The entry chunk's limit
moved the same day to 448 KB with the buttons chosen from Appearance. Folded
tool rows, their diffs, the question dock and the zoom applied at boot also
draw a thread's first screen: they added 13 KB to the 362 KB `main` of that
morning, and the merge of both built 424 KB, under that limit. It moved again
to 520 KB, 10% above the 462 KB that `bun run build:ui` then
`bun scripts/ci/budgets.ts` measured on 2026-09-28 for the change that edits, forks, rewinds and
moves a thread from its messages and menus, folds changed files and archives
projects: all of it draws on the first screen. The project stack marks (28 KB)
and the find bar stay out of the entry chunk and load when first needed. Raise
one in the change that explains the growth. On 2026-09-29 the compact theme
picker, colour math, persistence and prepaint handling added 9,000 bytes to
the entry chunk and 57,141 bytes to the complete UI, including palette CSS,
French strings and community license notices. The Windows desktop jobs measured
524,773 / 3,393,503 bytes on `main` at `c26a03a` and 533,773 / 3,450,644 bytes
with the themes at `bedd795`. The UI limits moved to 588,000 and 3,796,000 bytes,
about 10% above the combined build; the core limit stayed at 817,600 bytes.
The later account connection changes raised the core limit to 904,000 bytes
([measurements](performance.md)).
The resource audit retains those limits, shortens scope-class prefixes and
loads settings synchronization on first use to reduce emitted bytes while
keeping readable core function names in errors. On 2026-10-01 automatic
compaction (its timers, checks and settings validation), on top of the handover
of running turns, built a 904,139-byte core on the Windows desktop job, 139
bytes over; the core limit moved to 995,000 bytes, about 10% above it. Timings
are not gated:
they vary too much on shared runners.
The tested installer becomes the release artifact, with no second release build.
CI sets `BOITE_E2E_PREBUILT_UI=1` to test the UI already built for that installer.
The test refuses a missing UI build. Local end-to-end runs rebuild it by default.
The native Windows shell suite runs against that installer in the desktop job.
The remaining E2E files run on three independent Windows runners, starting
alongside the installer build. Each runner builds the production UI from the
same checkout and prepares its own Vite cache and fake-client bundle. Nightly
version changes apply to these runners too. Bun's `--shard=N/3` partitions the
complete list of E2E files except `shell.test.ts`, which the desktop job runs.
New E2E files enter that list automatically.

Files stay sequential within each shard: two and three parallel workers sharing
a Windows runner produced navigation and startup hook timeouts on 2026-09-24.
Every file still takes its own ports, data directory and browser profile.
Headless Chromium uses CPU compositing on CI, with software GL disabled,
instead of forcing Direct3D 11 on a hosted runner. Launch failures retain a
bounded stderr log alongside the captures, and an exited browser fails promptly.
Assertions and test deadlines are unchanged. The matrix has `fail-fast: false`,
so a failing shard does not prevent the others from reporting their failures.
`CI required` also requires the E2E matrix; a failure, cancellation or unexpected
skip blocks it. Retrying a failed browser shard does not rebuild the installer
or rerun the other successful shards.

`tests/e2e/lib/warm.ts` runs in a separate preparation step. Each phase logs its
start, elapsed time and errors. It reads the optimized dependency's response
body before closing Vite. The existing 35-minute job deadline remains; no
shorter per-phase or per-test limit is introduced. Failure captures are also
attempted when a step is cancelled.
It optimizes Vite's dependencies once, since on a fresh checkout each dev
server would otherwise empty `packages/ui/node_modules/.vite` under the
servers of the other workers. It also builds the fake-client bundle that
`BOITE_E2E_FAKE_UI` hands to every worker. Warming under a `NODE_ENV` other
than `test`, the one `bun test` sets, changes Vite's config hash and brings the
race back. Every file that only drives the page serves that bundle through
`startUi`. The preparation uses the same fixture plugin as `startDevUi`, since
Vite also hashes the plugin configuration and otherwise optimizes again.
A file whose page imports `/src/...`, or blocks a module by its
source URL, needs a dev server: `startDevUi` transforms every module the page
can load before its hook returns, and that hook allows 60 s. Before this, the
cold transform ran inside the first browser launch: on 2026-09-24 it outran the
30 s test hook of `app-updates` or `harness-updates` in three failed runs.

When Cargo uses a shared target directory, staging snapshots its shell into the
checkout before the tests. Another checkout's later build cannot replace it.

Docker builds on native x64 and ARM64 runners. Each architecture has its own
BuildKit cache, written from main only. Dependency manifests are copied before source files, so a core
change does not reinstall agent CLIs. Publication pushes the image that passed
the smoke test and combines both digests into one multi-platform tag.

These are cache and job boundaries, not a promise of a particular runner time.
Measure actual workflow durations after the first cold and warm runs on GitHub.

### Measuring the E2E partition

`bench/e2e.ts` runs every test in both modes and records per-group logs, elapsed
time and JUnit reports. Case identities and counts come from JUnit, even when
Bun suppresses passing console lines. Its comparison requires the serial report
first and refuses failures, skipped tests or a different list of test cases.
The parallel measurement uses four local
processes, including the native shell; CI uses separate runners for those
groups. Build and stage the shell once, then run from the checkout root:

```powershell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
$env:BOITE_E2E_PREBUILT_UI = '1'
$env:BOITE_E2E_FAKE_UI = 'tests/e2e/.artifacts/fake-ui'
bun tests/e2e/lib/warm.ts $env:BOITE_E2E_FAKE_UI
bun bench/e2e.ts serial
bun bench/e2e.ts sharded
bun bench/e2e.ts compare tests/e2e/.artifacts/timings/serial/result.json tests/e2e/.artifacts/timings/sharded/result.json
```

Run serial and sharded measurements on the same machine and checkout. Report
local test latency separately from hosted CI latency and bot review latency.
More concurrent runners can reduce elapsed time while increasing total runner
minutes; the comparison does not claim a reduction in compute cost.

On 2026-09-28, the commands above on Windows with Bun 1.4.2 produced:

| Local measurement | Serial | Sharded |
| --- | ---: | ---: |
| Elapsed E2E time | 252.66 s | 103.74 s |
| Passing cases | 185 | 185 |
| Assertions | 1,184 | 1,184 |
| Failures or skipped tests | 0 | 0 |

The comparison reported `Same test cases; elapsed time reduced by 58.9%`.
Two earlier sharded runs took 123.48 s and 119.56 s against a 272.31 s serial
reference, with the same 185 cases. These are local measurements with prepared
builds, not hosted workflow or review-cycle measurements.

The first hosted run of [PR #108](https://github.com/beboite/boite/actions/runs/36480733289)
passed all checks on its first attempt. Against the medians of successful runs
from the September 28 PR audit:

| Hosted measurement | Previous median | PR #108 |
| --- | ---: | ---: |
| Complete CI workflow | 15 min 41 s | 6 min 57 s |
| Windows desktop job | 14 min 43 s | 6 min 31 s |
| Full E2E window | 8 min 28 s | 5 min 35 s |

The E2E window starts with the first preparation step and ends when every E2E
group, including the native shell, has finished. It includes the native suite's
wait for the installer build. The hosted logs contain the same 185 cases as the
local reference. These reductions, 55.7%, 55.7% and 34.1%, compare historical
medians with one new run; repeated hosted runs are needed to establish a median.
The desktop job still spent 3 min 32 s building the installer, 1 min 12 s
compiling and running Rust tests, and 35 s in the native shell E2E suite.

Browser tests wait for committed navigation and resolved asynchronous conditions.
They disable background timer throttling and report page state, JavaScript
errors and the requests still in flight on an unmet condition. Windows setup has an explicit startup timeout.
The hidden shell test
passes `BOITE_SHELL_DEBUG_PORT` through WebView2's API because elevated runners
ignore environment-based WebView2 debug switches. Normal launches ignore this
test port. Hardware audio tests skip hosts without a default render endpoint;
the guard logic tests still run. Scripted Claude tests use Bun as their available
executable and never need a real CLI or login.

## boite (de nuit)

The `boite (de nuit)` workflow runs daily at 03:23 UTC and also accepts manual
`workflow_dispatch` runs on `main`. Both entry points are enabled by default.
Set the repository variable `NIGHTLY_ENABLED` to `false` to stop both entry
points. Removing it or setting it to `true` enables them again.

Before building, the workflow compares the selected commit with published
nightly releases. An unchanged commit skips the expensive jobs. Failed builds
have no published release and are retried next time. For example, the first build
on September 15 is `boite (de nuit) v2.0.0-nightly.20260915.1`; a new commit that day
gets `.2`. The counter resets the next UTC day. The base `2.0.0` comes from the
manifest, without its stable prerelease suffix.

The workflow reserves the version tag against the exact commit once the checks
and server builds pass, before it publishes the server channel tags and the
prerelease. The `release tags`
ruleset keeps a tag from being deleted, so a build that fails its checks takes
none, and the next build takes the same number. A build that fails while
publishing keeps its tag and reuses that version on retry, even on a later day.
A reserved tag alone is not a successful release. The installer and core carry the nightly
version through temporary build inputs; source manifests keep their version.

The desktop shares Boite's identifier, installation and data directory, allowing
the in-app update selector to move between stable and nightly. Local Boite Dev
builds remain isolated. The server uses the `dev` channel; use a separate Compose
project for nightly volumes. Nightly publication
never changes the stable Docker `latest` tag or GitHub's latest stable release.
Nightly verification skips the stable Docker job. The development images build
and run smoke tests alongside verification, once per architecture. Tested images
are pushed under run-specific staging tags, and their digests are saved as
artifacts. Only after verification, both image builds and version reservation
succeed does `server-manifest.yml` promote those digests to `nightly`, the version
tag and the commit tag. A failed check leaves the published channel unchanged;
an unchanged commit skips both verification and image builds. Ordinary server
publication uses the same manifest workflow immediately after its builds.

The nightly also publishes a signed Android APK, or takes the previous
release's back when `apps/android/`, the host and the signing key are
unchanged. A failed APK job fails the nightly like any other check.
[android.md](android.md) covers the reuse rule, `ANDROID_HOST` and the key.

On 2026-09-29, `gh run view 36531647917 --json jobs` showed verification's last
build finishing at 06:44:34 UTC and the server build starting at 06:44:48. The
slowest server build took 4 min 27 s. Overlapping it with verification removes
that serial build phase; the resulting total duration still needs a GitHub run
to measure runner availability and cache effects.

## Pull request reviews

`.coderabbit.yaml` configures CodeRabbit with advisory reviews. It does not
request changes or become a required merge check. Draft PRs and generated build
artifacts are excluded. Installing the GitHub App on this repository is a
separate prerequisite. CodeRabbit controls free-plan eligibility and review
limits; repository configuration does not override them.

Automatic code reviews and chat replies remain enabled. The
[PR follow-up rules](../AGENTS.md#follow-through-on-pull-requests) group verified
fixes before a push, inspect CI and reviews together, and avoid duplicate review
requests. Acknowledgements need no further reply unless they contain a new
finding. CI checks must still pass; unresolved bugs or missing reviews must be
reported. Test requests must identify a failure that existing coverage cannot
detect, rather than multiply equivalent cases.

## Security and labels

CodeQL's default setup analyses GitHub Actions, JavaScript/TypeScript and Rust on
pushes and pull requests. Secret scanning with push protection, Dependabot alerts
and Dependabot security updates are on. Vulnerability reports go through private
vulnerability reporting, as [SECURITY.md](../SECURITY.md) describes. Actions
must be pinned to a full commit SHA; the repository setting refuses a tag.

Dependabot updates the Bun workspace, the agent CLIs in `docker/agents`, the
shell's Cargo dependencies, the Docker base image and the workflow actions
weekly. The actions, the agent CLIs and the Cargo dependencies share one pull
request, the `weekly` multi-ecosystem group. Workspace minor and patch updates
share another; each workspace major update gets its own.

The `labeler` workflow labels pull requests by path with `core`, `ui`, `shell`,
`server`, `ci` and `documentation`, following `.github/labeler.yml`. It runs on
`pull_request_target` without checking out the pull request, so a fork gets
labels without its code running with write access.

## Releases and server images

A `v<version>` tag must match all package manifests, Cargo and the Tauri config.
Alternatively, manually run `release` on the branch or commit to publish: it
uses the version already in the manifests and creates its tag after the checks.
Neither entry point increments the version automatically.
The release workflow runs the complete CI and attaches the tested Windows
installer, the Linux .deb and AppImage (x64 and ARM64), the macOS DMG and
updater archive (Intel and Apple Silicon), their updater `.sig` files,
`latest.json` and `SHA256SUMS.txt` to a draft. A maintainer
reviews and publishes that draft. The nightly publishes the same signed update
artifacts as a prerelease after its checks pass.

Only release callers set the reusable CI's `sign-updates` input and inherit the
`TAURI_SIGNING_PRIVATE_KEY` secret. Ordinary PR builds require no signing key.
The build refuses an empty key when signing is requested. The Tauri updater
overlay generates signatures without recompiling the tested installer in the
publication job. `scripts/ci/updater-manifest.ts` requires exactly one signed
payload for each of the seven updater targets, refuses unknown files and binds
every URL to the reserved version tag. The Linux and macOS builds of an
ordinary PR sign with a throwaway key so the same file set is checked on every
run ([releasing](releasing.md#signed-update-artifacts)).

Updater signatures authenticate the payload to Boite. They are separate from
Windows Authenticode signing: the shell installer still has no Authenticode
publisher certificate. The bundled Bun runtime retains its own signature.

Publishing a release starts `publish server`. It requires a successful release
workflow on that exact commit before building and testing both architectures.
Images receive the version tag and `sha-<full commit>`. Only the release that
GitHub currently reports as latest can move the Docker `latest` tag. Publishing
an old release does not roll servers back. For a retry, manually dispatch
`publish-server.yml` on the same published version tag.

The registry path is `ghcr.io/<owner>/<repository>/boite-server`. Make the package
public in GHCR after its first publication if anonymous pulls are wanted. The
workflows use `GITHUB_TOKEN`; they do not need a registry password stored as a
repository secret. No production host is contacted or updated by CI.

The repository component keeps this image separate from Boite Legacy's existing
`ghcr.io/beboite/boite-server` package. Its tags and data are not migrated by these
workflows.

## Automatic changelog

Release notes come from Git commits, including commits without a pull request.
Each subject links to its commit, and a comparison link opens the complete diff.
Merge commits are excluded because the commits they merge are already listed.
Subjects starting with `feat`, `fix` and `perf` get their own sections; every
other subject goes under "Other changes". A list with no typed subject has no
headings.

For a stable release, the range starts at the previous published stable release
reachable from that commit. A prerelease may start at a previous prerelease.
Nightlies compare with the previous published nightly. Drafts and releases from
unrelated branches never become the baseline. The first release includes the
repository's history.

The manual release and nightly forms accept an optional `announcement`. It
appears above the generated changelog. Leave it empty for fully automatic notes.
You can also edit the release draft before publishing. Retrying an existing
draft refreshes its artifacts and preserves manually edited notes; it refuses
to replace a published release or a tag pointing at another commit.

## Repository presentation

The README carries the project name, pronunciation, supported agents and search
terms. `.github/topics.json` holds the matching GitHub topics. Applying them is
a separate repository metadata operation:

```sh
gh api repos/beboite/boite/topics --method PUT --input .github/topics.json
```

This updates topics only. It does not change the About description. Review the
file before applying it. Action revisions are pinned by SHA and grouped weekly
Dependabot updates keep them reviewable.
