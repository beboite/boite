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

The `release tags` ruleset keeps `v*` tags from being moved or deleted. Creating
one stays open, which the nightly reservation and a manual release rely on.

## Checks

| Change | Checks |
| --- | --- |
| Markdown docs, license, security policy, code of conduct, issue and pull request templates, CODEOWNERS, labeler rules, topics | Local documentation links and CI decision tests |
| Shell files or end-to-end tests | Windows shell tests, installer build and full end-to-end suite; Linux/macOS shell builds and Rust tests |
| Dockerfile, .dockerignore, docker/ | Docker smoke tests on native x64 and ARM64 |
| UI files | Type checks, UI tests, desktop checks and Docker smoke tests |
| Core, contracts, dependencies, shared build files, workflows, unknown paths | All checks, including core tests on Windows, Linux and macOS |
| Version tag | Complete checks, then a draft Windows release |
| Enabled nightly with an unpublished commit | Complete checks, development installer, development server image, prerelease |

Pull requests against any branch run CI. A newer commit cancels an older run of
that same PR. New main commits also cancel superseded ordinary CI runs.
Release and publication jobs finish instead of being interrupted
halfway through an upload. Live-provider tests stay disabled.

Linux and macOS run Rust tests, build Debian/AppImage packages and a macOS application
bundle, then launch the installed shell outside the checkout with a minimal PATH.
The Debian install, extracted AppImage and signed macOS bundle each run the smoke
test, which checks core startup, bundled UI serving, authenticated RPC and an
echo turn with a fresh data directory. It does not exercise native desktop controls.
The WebView2 shell end-to-end suite remains Windows-only.
Portable desktop checks run on x64 and ARM64 for both Linux and macOS.

## Build cost

Bun uses `packageManager` in the root manifest. Installs use the frozen lockfile
and cache the download store separately per OS and architecture. The UI tests
use at most eight workers and persist transformed modules in Vitest's disk cache.
The cache key includes the lockfile and the Svelte and Vitest configuration;
Vitest validates individual source files when loading cached transforms.

The Windows job builds the installer and runs Rust tests in the release profile,
sharing compiled dependencies. Successful jobs save Cargo caches for PRs as well
as main, under a release-specific key. Failed or interrupted jobs do not save an
incomplete cache that GitHub would keep immutable. GitHub scopes PR caches to
their merge ref.
It builds the installer once, then copies the existing sidecar beside the shell
for end-to-end testing. It does not recompile the core just to stage it again.
The tested installer becomes the release artifact, with no second release build.
CI sets `BOITE_E2E_PREBUILT_UI=1` to test the UI already built for that installer.
The test refuses a missing UI build. Local end-to-end runs rebuild it by default.

When Cargo uses a shared target directory, staging snapshots its shell into the
checkout before the tests. Another checkout's later build cannot replace it.

Docker builds on native x64 and ARM64 runners. Each architecture has its own
BuildKit cache. Dependency manifests are copied before source files, so a core
change does not reinstall agent CLIs. Publication pushes the image that passed
the smoke test and combines both digests into one multi-platform tag.

These are cache and job boundaries, not a promise of a particular runner time.
Measure actual workflow durations after the first cold and warm runs on GitHub.

Browser tests wait for committed navigation and resolved asynchronous conditions.
They disable background timer throttling and report page state and JavaScript
errors on an unmet condition. Windows setup has an explicit startup timeout.
The hidden shell test
passes `BOITE_SHELL_DEBUG_PORT` through WebView2's API because elevated runners
ignore environment-based WebView2 debug switches. Normal launches ignore this
test port. Hardware audio tests skip hosts without a default render endpoint;
the guard logic tests still run. Scripted Claude tests use Bun as their available
executable and never need a real CLI or login.

## boite de nuit

The `boite de nuit` workflow has a daily schedule at 03:23 UTC and a manual
`workflow_dispatch` entry. Both are gated by the repository variable
`NIGHTLY_ENABLED`, which must equal `true`. It is disabled by default. No variable
is created by this repository.

To enable it later, set that variable in Settings, Secrets and variables,
Actions, Variables. Remove it or set it to `false` to disable both entry points.
Manual runs must target `main`.

Before building, the workflow compares the selected commit with published
nightly releases. An unchanged commit skips the expensive jobs. Failed builds
have no published release and are retried next time. For example, the first build
on September 15 is `boite de nuit v2.0.0-nightly.20260915.1`; a new commit that day
gets `.2`. The counter resets the next UTC day. The base `2.0.0` comes from the
manifest, without its stable prerelease suffix.

The workflow reserves the version tag against the exact commit before building.
A failed build reuses that version on retry, even on a later day. A reserved tag
alone is not a successful release. The installer and core carry the nightly
version through temporary build inputs; source manifests keep their version.

The desktop uses the development identifier and data directory, shared with
local Boite Dev builds and separate from stable Boite. The server uses the `dev`
channel. Use a separate Compose project for nightly volumes. Nightly publication
never changes the stable Docker `latest` tag or GitHub's latest stable release.
Nightly verification skips the stable Docker job. Its publication job builds,
smoke-tests and pushes the development image once per architecture after the
other checks pass.

## Pull request reviews

`.coderabbit.yaml` configures CodeRabbit with advisory reviews. It does not
request changes or become a required merge check. Draft PRs and generated build
artifacts are excluded. Installing the GitHub App on this repository is a
separate prerequisite. CodeRabbit controls free-plan eligibility and review
limits; repository configuration does not override them.

## Security and labels

CodeQL's default setup analyses GitHub Actions, JavaScript/TypeScript and Rust on
pushes and pull requests. Secret scanning with push protection, Dependabot alerts
and Dependabot security updates are on. Vulnerability reports go through private
vulnerability reporting, as [SECURITY.md](../SECURITY.md) describes. Actions
must be pinned to a full commit SHA; the repository setting refuses a tag.

Dependabot updates the Bun workspace, the agent CLIs in `docker/agents`, the
shell's Cargo dependencies, the Docker base image and the workflow actions
weekly. Workspace minor and patch updates share one pull request; each major
update gets its own.

The `labeler` workflow labels pull requests by path with `core`, `ui`, `shell`,
`server`, `ci` and `documentation`, following `.github/labeler.yml`. It runs on
`pull_request_target` without checking out the pull request, so a fork gets
labels without its code running with write access.

## Releases and server images

A `v<version>` tag must match all package manifests, Cargo and the Tauri config.
Alternatively, manually run `release` on the branch or commit to publish: it
uses the version already in the manifests and creates its tag after the checks.
Neither entry point increments the version automatically.
The release workflow runs the complete CI and attaches the tested installer and
`SHA256SUMS.txt` to a draft. A maintainer reviews and publishes that draft.
Installers are currently unsigned; checksums detect corruption, not publisher
identity. No updater signature is implied by these files.

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
