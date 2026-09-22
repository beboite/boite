# Releasing

From a clean tree to an installer. Every command below exists in the workspace
`package.json` files and runs from the repository root.

[CI and publication](ci.md) covers automated checks, draft releases, Docker
images and the daily nightly schedule.

## The order

```bash
bun run check
bun run test
bun run test:shell
bun run build:shell
bun run apps/shell/scripts/stage-sidecar.ts
bun run e2e
```

`build:shell` builds the UI and compiles the core through `stage:core`. The
staging command after it copies that existing core beside the newly built shell;
it does not compile again. The end-to-end suite refuses missing or stale artifacts.

## What each step produces

- `build:ui` writes `packages/ui/dist`. That directory is what the core serves at
  `/` and what the shell bundles as its frontend. The Tauri config also runs it
  as its own before-build command, so a shell build never ships a UI older than
  the sources.
- `build:core` cleans and writes `packages/core/dist`: `main.js`, `jobs-worker.js`,
  `guard-worker.js`, and hashed chunks for the main module and lazy drivers.
  Keep every emitted file together when distributing this bundle. Lazy imports
  keep the SDKs off the start path. `bun run core` and the shell both prefer this
  bundle over the sources when it is there.
- `build:core:exe` compiles `packages/core/dist/boite-core`, with `.exe` on Windows. The two worker
  files are not compiled into it: the core loads them by name from beside its own
  executable, so they travel with it.
- On Windows the installed sidecar is not that executable. It is the Bun runtime
  the build ran under, copied as `boite-core.exe`, with every file of the bundle
  but the workers in a `core` directory beside it, and the shell starts it as
  `boite-core.exe core/main.js`. The runtime carries its publisher's signature;
  an unsigned compiled core costs about 650 ms more at every start on Windows 11
  ([performance.md](performance.md)). `stage-sidecar.ts` warns when the runtime's
  signature is not valid. `apps/shell/scripts/tauri.ts` adds
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
On a normal quit, the POSIX shell gives the core three seconds to handle
`SIGTERM`, stop its direct children and close the journal before forcing exit.

macOS requires 13.0 or newer. The bundle includes the JIT entitlements required
by the [compiled Bun runtime](https://bun.sh/docs/bundler/executables).
CI signs locally with an ad-hoc identity and starts that signed bundle. A public
release still needs an Apple Developer ID and notarization credentials.

A shell executable with no installer, for a quick look at the window:

```bash
bun run --cwd apps/shell tauri build --no-bundle
```

## The bundle overlay

`apps/shell/src-tauri/tauri.conf.json` is the base config and names no sidecar.
`apps/shell/src-tauri/tauri.bundle.conf.json` is the overlay that `build:shell`
passes, and it is the only place `bundle.externalBin` and the resource map live:

```json
{
  "bundle": {
    "externalBin": ["binaries/boite-core"],
    "resources": {
      "binaries/jobs-worker.js": "jobs-worker.js",
      "binaries/guard-worker.js": "guard-worker.js",
      "binaries/boite": "boite",
      "binaries/boite.cmd": "boite.cmd",
      "../../../packages/ui/dist": "ui"
    }
  }
}
```

Splitting it this way means the base config still builds for anyone who has not
compiled the core. Two path rules bite here and are worth reading twice. A
`--config` path is resolved against the directory the CLI was invoked from,
`apps/shell`, while every path written inside a config is resolved against
`src-tauri`: the two bases are not the same. And a `bundle.resources` entry whose
key is a directory copies the whole tree under the target name, which is why the
UI arrives as `ui/index.html` and needs no glob. A glob key would flatten the
tree instead.

## Channels

Boite and boite de nuit are update tracks of the same installed application.
They share `com.boite.two`, the Boite installer name and the `boite2` data
directory. Nightly uses `icons-nightly/`, the white mark on violet and magenta, and
displays boite de nuit in the window title and tray. The in-app channel selector downloads the selected
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

The dev one passes a second overlay, `apps/shell/src-tauri/tauri.dev.conf.json`,
after the bundle one. The Tauri CLI takes `--config` more than once and merges
in the order given, so the dev overlay carries only what differs: the product
name, the identifier and `bundle.icon` pointing at `icons/`, the black mark on
white. The release uses `icons-dev/`, the white mark on black. These asset
directory names are historical. Two identifiers mean two NSIS product
codes, so the second installer installs beside the first instead of over it.

The separate data directory is not a nicety. The shell finds its core by reading
`<dataDir>/core.json` and adopting whatever answers on the port it names: on one
shared directory a dev shell would adopt the stable core, run the beta window on
the stable journal and the stable accounts, and report nothing wrong. So the
channel rides all the way down. The shell reads it once from
`app.config().identifier` (a `.dev` suffix and nothing else decides it), uses it
for its own data directory, and appends `--channel dev` to the core's argv; the
core's `--channel` picks the same default directory and fills `CoreInfo.channel`,
which is what puts the small "Dev" tag beside the title in the title bar. The
mapping is pure on both sides and tested on both: `cargo test --lib` in
`apps/shell/src-tauri` for the identifier, `packages/core/test/core.test.ts` for
the flag and the directory name.

On Windows the WebView2 profile needs nothing: with no `BOITE_DATA_DIR` set the
shell leaves it to Tauri, which puts it under `%LOCALAPPDATA%\<identifier>`, so
the regular install and Boite Dev already have one each. Stable and nightly
share the regular WebView2 profile.

## Signed update artifacts

Release and nightly callers enable `BOITE_SIGN_UPDATES=1` and provide
`TAURI_SIGNING_PRIVATE_KEY` through the CI secret. The Tauri wrapper adds
`tauri.updater.conf.json`, which enables `createUpdaterArtifacts`, and refuses
signing without a key. Normal local builds and PR verification remain unsigned.

The public verification key is in `tauri.conf.json`. Keep the matching private
key backed up outside the repository: replacing the public key strands clients
that only trust the old one. No private key belongs in an artifact or Git.

The Windows build uploads the installer and its `.sig`. Publication creates
`latest.json` with the exact version, publication date, release notes, signature
and immutable release download URL. Stable releases remain drafts until reviewed;
nightlies publish automatically. Neither a draft nor an unsigned older release
is offered by the desktop updater.

These are Tauri updater signatures, not Windows Authenticode signatures. Public
Linux and macOS update payloads are not published by these workflows yet.

## What the installer holds

The bundle target is NSIS, the identifier is `com.boite.two` and the product
name is `Boite`. The install is per user and asks for no elevation.
`%LOCALAPPDATA%\Boite` ends up holding:

- `boite-shell.exe`, the window and the tray icon.
- `boite-core.exe`, the sidecar it starts: the Bun runtime under the core's name.
  Run by hand with no script it is `bun`, so a subcommand goes after the bundle:
  `boite-core.exe core\main.js pair --owner`.
- `core/`, the bundled core that runtime runs: `main.js` and its lazy chunks.
- `jobs-worker.js`, beside the core because that is where the core looks for it.
  Without it the trace reports `poll` instead of `events`.
- `guard-worker.js`, the focus guard and the audio mute.
- `boite` and `boite.cmd`, the CLI shims the core puts on an agent's PATH; each
  runs `boite-core cli` from beside itself ([cli.md](cli.md)).
- `ui/`, the same build a phone gets over the pairing link.

The identifier is fresh, so Boite installs beside Boite Legacy rather than over
it. To see the exact file list a build produced, read
`apps/shell/src-tauri/target/release/nsis/x64/installer.nsi` before installing
anything: it names every file and where it goes.

## How the shell finds a core

Closing the window exits the shell and its owned core by default. General settings
can keep it in the notification area instead. The choice lives in
`<dataDir>/shell-settings.json` and survives restart. The tray's Quit action always
exits. Hovering or clicking the tray icon opens a compact quota window; its Show
action restores the main window. Quota polling runs only while that popup is open.

The installed shell starts a core of its own, adopts one that already answers,
and owns the one it started through a `KILL_ON_JOB_CLOSE` Job Object, so a shell
killed hard takes its core down with it instead of leaving an orphan holding
`boite-core.exe` open, which is exactly what once made an install fail on "error
opening file for writing".

It looks for the core in this order:

1. `BOITE_CORE_COMMAND`, split on whitespace. This is the override the tests and
   the bench use.
2. `boite-core.exe` beside the shell executable, given `core/main.js` as its
   script when that file is beside it too. This is the installed case, and
   it is also what the end to end suite drives, which is why a stale staged
   sidecar is refused rather than tolerated.
3. `packages/core/dist/main.js` through bun, when a repository root is found
   above the executable. The development case with a built bundle.
4. `packages/core/src/main.ts` through bun. The development case without one.

## Icons

The app icon is one drawing, `packages/ui/public/icons/icon.svg`. The light shell
icon set and the two PWA pngs are rendered from it, the first through the Tauri CLI's
own icon command from `apps/shell`. Nothing else draws the mark, and the UI's own
copy of it is a Svelte component using `currentColor`.

The release channel gets the same drawing inverted,
`packages/ui/public/icons/icon-dev.svg`, so the two apps are told apart in the
taskbar and the tray at a glance. Its set is rendered the same way, into a
directory of its own, and the android and ios output the command also writes is
deleted, as it is for the light set:

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
date.
