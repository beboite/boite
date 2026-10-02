# Releasing

This guide owns release channels, artifact layout and signing. Run build
commands from the repository root. [Development](development.md) owns local
setup and test commands; [portability](portability.md) records platform limits.

[CI and publication](ci.md) covers automated checks, draft releases, Docker
images and the daily nightly schedule.

## The order

Run the [development checks](development.md#checks-and-tests) and
`bun run check:translations` before packaging. Then:

```bash
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

`build:shell` builds the UI and compiles the core through `stage:core`. The
staging command after it copies that existing core beside the newly built shell;
it does not compile again. The end-to-end suite refuses missing or stale artifacts.

## What each step produces

Linux CI also writes a signed `boite-server_<version>_<arch>.zip` for x64 and
ARM64, containing the compiled core, CLI shim, UI and embedded release version.
`scripts/ci/server-bundle.ts` creates it and Tauri's signer signs the payload
with the desktop updater key and release version. Both stable and nightly
publication require those signatures, include the archives in the checksums,
and add separate server targets to `latest.json`. Docker images remain separate.

- `build:ui` writes `packages/ui/dist`. That directory is what the core serves at
  `/` and what the shell bundles as its frontend. The Tauri config also runs it
  as its own before-build command, so a shell build never ships a UI older than
  the sources.
- `build:core` cleans and writes `packages/core/dist`: `main.js`, `jobs-worker.js`,
  `guard-worker.js`, and hashed chunks for the main module and lazy drivers.
  Keep every emitted file together when distributing this bundle. Lazy imports
  keep the SDKs off the start path. `bun run core` and the shell both prefer this
  bundle over the sources when it is there.
- `build:core:exe` compiles `packages/core/dist/boite-core`, with `.exe` on Windows. On x64 it embeds
  Bun's baseline runtime, which needs no AVX2. The two worker
  files are not compiled into it: the core loads them by name from beside its own
  executable, so they travel with it.
- On Windows the installed sidecar is not that executable. It is Bun's baseline
  runtime of the version the build ran under, copied as `boite-core.exe`, with every file of the bundle
  but the workers in a `core` directory beside it, and the shell starts it as
  `boite-core.exe core/main.js`. The baseline build runs on x64 CPUs without
  AVX2, where the default one stops at its first instruction. `stage-sidecar.ts`
  downloads it once from the Bun release, checks the archive against the
  release's `SHASUMS256.txt` and keeps it under `node_modules/.cache`, so the
  first staging needs the network. The runtime carries its publisher's signature;
  the [2026-09-19 Windows comparison](../bench/results/2026-09-29-resources.md#runtime-and-bundle-measurements-2026-09-19-to-2026-09-29)
  recorded about 650 ms of additional startup inspection for an unsigned core.
  Because the checksum comes from the same release, staging also verifies the
  signature: `stage-sidecar.ts` refuses a
  runtime whose signature is not valid or whose signer is not Bun's publisher
  (`O=Codeblog CORP`, `apps/shell/scripts/runtime-signature.ts`). It checks the
  cached copy again at every staging and downloads it again when that copy
  fails. It also refuses a Bun other than the `packageManager` pin, as do
  `packages/core/bin/compile.ts` and `build:core:linux`, since each ships the
  Bun it runs under. `BOITE_ALLOW_BUN_MISMATCH=1` allows another one for a build
  that is not shipped. `apps/shell/scripts/tauri.ts` adds
  `tauri.bundle.windows.conf.json`, which names the `core` directory as a
  resource, to any Windows build that passes the bundle overlay.
- `stage:core` puts the sidecar, both workers and the two `boite` shims
  (`packages/core/shims`, see [cli.md](cli.md)) where the two things that
  run them look. The bundler wants
  `apps/shell/src-tauri/binaries/boite-core-<target triple>`, with `.exe` on Windows, for
  `bundle.externalBin`, plus the workers and the `boite` shims in that same directory for the resource
  entries that land them beside the installed sidecar. The end to end suite wants
  the same files beside `apps/shell/src-tauri/target/release/boite-shell`, with
  `.exe` on Windows, so the script copies there whenever that executable exists.
  The Windows shell refuses a sidecar missing either worker and names the missing file.
- `build:shell` runs the Tauri build with the bundle overlay and produces the
  NSIS installer on Windows, Debian and AppImage packages on Linux, or an
  application bundle and DMG on macOS. Build on the target OS and architecture;
  staging supports Windows x64 and Linux/macOS x64 and ARM64.

The shell passes Tauri's resource directory to the core through `BOITE_UI_DIR`,
so the installed core can serve the phone UI from the macOS application bundle
and Linux package. Windows workers are required only by the Windows shell.
Neither form of the sidecar needs a separately installed Bun runtime.
Linux builds also need `xdg-utils`, alongside the WebKitGTK and appindicator
development packages. The Debian package declares `xdg-utils` for opening links.
Install `patchelf` too. The shell build wrapper selects it from PATH for
linuxdeploy. On ARM64 it preserves the compiled Bun sidecar, whose ELF load
segments break after an RPATH rewrite. The exception checks that the sidecar
only needs glibc libraries; CI compares the packaged core with the original.

Portable CI runs `scripts/ci/desktop-smoke.ts <installed-shell>` against the
Debian package, extracted AppImage and macOS application bundle. Signing, notarization and testing
on older operating systems remain release prerequisites; a local unsigned
bundle is not a notarized download. Native notifications and Windows process
guards are not implemented on Linux or macOS.
The [architecture](architecture.md#closing-and-restart) describes resident-core
shutdown. Installed smoke tests use a temporary home, run outside the checkout
without Bun on PATH, and verify an echo turn executing `boite where`.
[Platform readiness](portability.md) separates that coverage from native webview,
notification, provider-login and older-OS checks.

macOS requires 13.0 or newer and includes the JIT entitlements needed by the
[compiled Bun runtime](https://bun.sh/docs/bundler/executables). CI starts an
ad-hoc signed bundle when Developer ID/notarization credentials are absent.

A shell executable with no installer, for a quick look at the window:

```bash
bun run --cwd apps/shell tauri build --no-bundle
```

## The bundle overlay

`apps/shell/src-tauri/tauri.conf.json` is the base config without a sidecar.
`tauri.bundle.conf.json` adds `bundle.externalBin` and the resource map for the
core, Windows workers, CLI shims and built UI. The base can build before core
compilation; distributable builds use the overlay.

CLI `--config` paths resolve from `apps/shell`, while paths inside the configs
resolve from `src-tauri`. A directory resource preserves its tree under the
mapped name, giving `ui/index.html`; a glob would flatten it. Windows adds a
separate resource overlay for the split `core/` JavaScript bundle.

## Channels

Boite and Boite Nightly are update tracks of the same installed application.
They share `com.boite.two`, the Boite installer name and the `boite2` data
directory. Nightly uses `icons-nightly/`, the white mark on violet and magenta, and
displays boite (de nuit) in the window title and tray. The in-app channel selector downloads the selected
track, including an older stable version when leaving nightly.
[Desktop updates](updates.md) covers restart behavior and data compatibility.

Boite Dev remains a separate development install. It uses `com.boite.two.dev`,
the product name Boite Dev and `boite2-dev`, with no automatic app updates.

The build commands:

```bash
bun run build:shell         # Boite, com.boite.two, boite2
bun run build:shell:nightly # nightly overlay; CI stamps the nightly version
bun run build:shell:dev     # Boite Dev, com.boite.two.dev, boite2-dev
```

The dev build passes a second overlay, `apps/shell/src-tauri/tauri.dev.conf.json`,
after the bundle one. The Tauri CLI takes `--config` more than once and merges
in the order given, so the dev overlay carries only what differs: the product
name, the identifier and `bundle.icon` pointing at `icons/`, the black mark on
white. The release uses `icons-dev/`, the white mark on black. These asset
directory names are historical. Two identifiers mean two NSIS product
codes, so the second installer installs beside the first instead of over it.

The shell derives its channel from the identifier's `.dev` suffix and passes
`--channel dev` to its core. Shell and core must select the same directory:
otherwise a development shell can adopt a stable core and journal. Stable and
nightly share the regular WebView2 profile; Boite Dev has its own. Core adoption
and version/hash checks belong to the [architecture](architecture.md).

## Signed update artifacts

Release and nightly callers enable `BOITE_SIGN_UPDATES=1` and provide
`TAURI_SIGNING_PRIVATE_KEY` through the CI secret. The Tauri wrapper adds
`tauri.updater.conf.json`, which enables `createUpdaterArtifacts`, and refuses
signing without a key. Normal local builds and the Windows PR build remain
unsigned. The Linux and macOS CI builds always sign: a PR or main push uses a
throwaway key generated on the runner, so every run proves the payloads and
signatures a release will need; only release callers use the real key.

The public verification key is in `tauri.conf.json`. Keep the matching private
key backed up outside the repository: replacing the public key strands clients
that only trust the old one. No private key belongs in an artifact or Git.

The Windows build uploads the installer and its `.sig`. Each Linux and macOS
runner collects its packages with `scripts/ci/desktop-bundles.ts` into a
`desktop-bundle-<runner>` artifact: the .deb and AppImage with their `.sig` on
Linux, the DMG and the updater archive `Boite.app.tar.gz` with its `.sig` on
macOS. That archive has the same name on both Mac architectures, so the script
renames it after the DMG beside it (`Boite_<version>_aarch64.app.tar.gz`). It
fails the runner when a payload or a signature is missing or when a file of
another architecture is present. Publication gathers every artifact, and
`scripts/ci/updater-manifest.ts` creates `latest.json` with the exact version,
publication date, release notes, and one signature and immutable release
download URL per updater target. It requires all nine targets: Windows x64,
two macOS architectures, Linux .deb/AppImage on both architectures, and two
standalone Linux server archives. Unknown release files are refused. DMGs are
manual downloads. `SHA256SUMS.txt` covers desktop/server payloads; stable
publication also includes tested-image provenance metadata. Stable releases
remain drafts until reviewed; nightlies publish automatically. The desktop
updater excludes drafts and unsigned older releases.

Docker publication reuses the tested image digests. Version tags identify the
release; the shared `sha-<full commit>` alias can change between stable and
nightly builds of the same source. Use a version tag or digest to pin a build.
Stable `latest` promotion runs separately under a repository-wide concurrency
group and rechecks GitHub's current stable release before writing the alias.

These are Tauri updater signatures, not Windows Authenticode signatures or
Apple Developer ID signatures.

A release or nightly signs the macOS application with a Developer ID and
notarizes it when six repository secrets are set: `APPLE_CERTIFICATE` (the
Developer ID Application `.p12`, base64), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, and the App Store Connect API key used for
notarization, `APPLE_API_ISSUER`, `APPLE_API_KEY_ID` and
`APPLE_API_PRIVATE_KEY` (the `.p8` contents). The CI then checks the stapled
ticket and Gatekeeper's verdict on the bundle. Without all six, and on every
pull request, the bundle is signed ad hoc and Gatekeeper asks once before the
first start (README). Developer ID signing and notarization need the Apple
Developer Program. Linux
packages are built on Ubuntu 22.04, whose glibc 2.35 is the oldest a user can
run them on.

## What the installer holds

The bundle target is NSIS, the identifier is `com.boite.two` and the product
name is `Boite`. The install is per user and asks for no elevation.
`%LOCALAPPDATA%\Boite` ends up holding:

- `boite-shell.exe`, the window and the tray icon.
- `boite-core.exe`, the sidecar it starts: Bun's baseline runtime under the core's name.
  Run by hand with no script it is `bun`, so a subcommand goes after the bundle:
  `boite-core.exe core\main.js pair --owner`.
- `core/`, the bundled core that runtime runs: `main.js` and its lazy chunks.
- `jobs-worker.js`, beside the core because that is where the core looks for it.
  Without it the trace reports `poll` instead of `events`.
- `guard-worker.js`, the focus guard and the audio mute.
- `boite` and `boite.cmd`, the CLI shims the core puts on an agent's PATH; each
  invokes the adjacent core's CLI entry ([cli.md](cli.md)).
- `ui/`, the same build a phone gets over the pairing link.

The identifier is fresh, so Boite installs beside Boite Legacy rather than over
it. To see the exact file list a build produced, read
`apps/shell/src-tauri/target/release/nsis/x64/installer.nsi` before installing
anything: it names every file and where it goes.

## How the shell finds a core

[Architecture](architecture.md#the-core-is-the-host-the-shell-is-a-client)
owns core adoption and residency; [portability](portability.md) records shutdown
limits. [Desktop updates](updates.md#download-and-restart) owns installer
admission, running-core replacement and shortcut preservation.

Core lookup order:

1. `BOITE_CORE_COMMAND`, split on whitespace. This is the override the tests and
   the bench use.
2. `boite-core.exe` beside the shell executable, given `core/main.js` as its
   script when that file is beside it too. This is the installed case, and
   it is also what the end to end suite drives, which is why a stale staged
   sidecar is refused rather than tolerated.
3. `packages/core/dist/main.js` through bun, when a repository root is found
   above the executable. The development case with a built bundle.
4. `packages/core/src/main.ts` through bun. The development case without one.

## Installed-shell diagnostics

Close exits the shell by default; General settings can keep it in the tray.
`<dataDir>/shell-settings.json` stores that choice. Tray Quit always exits; Show
restores the main window. Hover/click opens a quota popup that polls only while
visible and is destroyed 45 seconds after hiding. Hidden/minimized Windows
pages and browser panels stop painting and see `document.hidden`.

`shell.lock` permits one shell per data directory. A second launch uses the
loopback port/token in `shell-wake` to show the existing window. Hidden test
shells never request it. Setup failures and panics go to `shell-error.log`;
visible setup failures name that file in a dialog. Missing WebView2 uses Tauri's
dialog. A tray-creation failure leaves a usable window that exits on Close.

Resident cores append to `core-output.log`, truncated at startup above 8 MiB.
`BOITE_CORE_RESIDENT=0` makes a Windows shell own its core through a
`KILL_ON_JOB_CLOSE` Job Object. POSIX gives its owned core three seconds for
SIGTERM before forcing exit. [Updates](updates.md) owns the installer hooks
that close the shell before replacing its running core.

## Icons

The app icon source is `packages/ui/public/icons/icon.svg`. The light shell
icon set and the two PWA pngs are rendered from it, the first through the Tauri CLI's
own icon command from `apps/shell`. Nothing else draws the mark, and the UI's own
copy of it is a Svelte component using `currentColor`.

The release uses the inverted `packages/ui/public/icons/icon-dev.svg`, rendered
into its own directory. Remove the Android/iOS outputs of the icon command,
as for the light set:

```bash
bun run --cwd apps/shell tauri icon ../../packages/ui/public/icons/icon-dev.svg -o src-tauri/icons-dev
```

Nightly keeps the white mark on a ground lit from below, near-black violet at
the top fading to magenta, with a faint halo around the mark.
`packages/ui/public/icons/icon-nightly.svg` renders into `src-tauri/icons-nightly`
with the same command and the same cleanup.

## Version numbers

The version lives in the root `package.json`, each workspace package,
`apps/shell/src-tauri/Cargo.toml` and `apps/shell/src-tauri/tauri.conf.json`.
Update them together and refresh the package entry in `Cargo.lock` in the same
release commit.

## Before handing a build to anyone

Run `bun run e2e` on the staged build, not on the sources alone: it is the only
thing that drives the real shell executable over its debugging port, hidden.
Then run `bun run bench` and `bun run bench/idle-rss.ts` fresh, so the resource
figures in the release notes come from the build being released and carry its
date. The idle bench reports two points for each process: `fresh`, 4.5 s after
the spawn, and `steady`, 75 s after it, once the first automatic update check
has run. Quote both, with the working set, private bytes and thread count it
prints. The bench starts its cores with `BOITE_HOST_AGENTS=0`, so by default
the check finds no provider and the steady point measures an empty check. For
the notes, a person runs it with `BOITE_BENCH_HOST_AGENTS=1`, so the update
check reads the providers installed on the machine as a user's core would, and
says which providers those were. An agent never sets it: the check runs each
agent's `--version`, and an agent's own updater can open a console window.

## Release notes

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
