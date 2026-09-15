# CI and publication

The required check is `CI required`. Configure branch protection to require that
single job. It fails when an applicable check fails or is cancelled, including
when a dependency never starts. Documentation-only changes still produce it.

## Checks

| Change | Checks |
| --- | --- |
| Markdown docs, license, issue templates, topics | Local documentation links and CI decision tests |
| Code, dependencies, build files, workflows, unknown paths | Above, type checks, core tests on Windows and Linux, UI tests, Windows shell tests, installer build, full end-to-end suite, Docker smoke tests on x64 and ARM64 |
| Version tag | Complete checks, then a draft Windows release |
| Enabled nightly with an unpublished commit | Complete checks, development installer, development server image, prerelease |

Pull requests against any branch run CI. A newer commit cancels an older run of
that same PR. Release and publication jobs finish instead of being interrupted
halfway through an upload. Live-provider tests stay disabled.

## Build cost

Bun uses `packageManager` in the root manifest. Installs use the frozen lockfile
and cache the download store separately per OS and architecture. The UI tests
use at most eight workers and persist transformed modules in Vitest's disk cache.
The cache key includes the lockfile and the Svelte and Vitest configuration;
Vitest validates individual source files when loading cached transforms.

The Windows job shares one Cargo cache between unit tests and the release build.
It builds the installer once, then copies the existing sidecar beside the shell
for end-to-end testing. It does not recompile the core just to stage it again.
The tested installer becomes the release artifact, with no second release build.

When Cargo uses a shared target directory, staging snapshots its shell into the
checkout before the tests. Another checkout's later build cannot replace it.

Docker builds on native x64 and ARM64 runners. Each architecture has its own
BuildKit cache. Dependency manifests are copied before source files, so a core
change does not reinstall agent CLIs. Publication pushes the image that passed
the smoke test and combines both digests into one multi-platform tag.

These are cache and job boundaries, not a promise of a particular runner time.
Measure actual workflow durations after the first cold and warm runs on GitHub.

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
