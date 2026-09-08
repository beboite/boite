# Releasing

From a clean tree to an installer. Every command below exists in the workspace
`package.json` files and runs from the repository root.

## The order

```bash
bun run check
bun run test
bun run build:ui
bun run build:core
bun run build:core:exe
bun run stage:core
bun run build:shell
bun run e2e
```

Each step feeds the next, and skipping one shows up as something stale rather
than as an error. `bun run build:shell` runs `stage:core` itself, and `stage:core`
runs `build:core:exe` itself, so the short version of that list is check, test,
`build:shell`, `e2e`. The long version is what to run when a step has failed and
you want to see which.

## What each step produces

- `build:ui` writes `packages/ui/dist`. That directory is what the core serves at
  `/` and what the shell bundles as its frontend. The Tauri config also runs it
  as its own before-build command, so a shell build never ships a UI older than
  the sources.
- `build:core` writes `packages/core/dist`: `main.js`, `jobs-worker.js`,
  `guard-worker.js`, and the split chunk holding the agent SDKs, which is what
  keeps them off the start path. `bun run core` and the shell both prefer this
  bundle over the sources when it is there.
- `build:core:exe` compiles `packages/core/dist/boite-core.exe`. The two worker
  files are not compiled into it: the core loads them by name from beside its own
  executable, so they travel with it.
- `stage:core` puts that executable and both workers where the two things that
  run them look. The bundler wants
  `apps/shell/src-tauri/binaries/boite-core-<target triple>.exe` for
  `bundle.externalBin`, plus the workers in that same directory for the resource
  entries that land them beside the installed sidecar. The end to end suite wants
  the same files beside `apps/shell/src-tauri/target/release/boite-shell.exe`,
  which is the shell executable it drives, so the script copies there too
  whenever that executable exists. Without the staged workers the trace degrades
  from exact events to polling and the focus guard never starts.
- `build:shell` runs the Tauri build with the bundle overlay and produces the
  NSIS installer.

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

## What the installer holds

The bundle target is NSIS, the identifier is `com.boite.two` and the product
name is `Boite`. The install is per user and asks for no elevation.
`%LOCALAPPDATA%\Boite` ends up holding:

- `boite-shell.exe`, the window and the tray icon.
- `boite-core.exe`, the sidecar it starts.
- `jobs-worker.js`, beside the core because that is where the core looks for it.
  Without it the trace reports `poll` instead of `events`.
- `guard-worker.js`, the focus guard and the audio mute.
- `ui/`, the same build a phone gets over the pairing link.

The identifier is fresh, so Boite 2 installs beside a version 1 rather than over
it. To see the exact file list a build produced, read
`apps/shell/src-tauri/target/release/nsis/x64/installer.nsi` before installing
anything: it names every file and where it goes.

## How the shell finds a core

The installed shell starts a core of its own, adopts one that already answers,
and owns the one it started through a `KILL_ON_JOB_CLOSE` Job Object, so a shell
killed hard takes its core down with it instead of leaving an orphan holding
`boite-core.exe` open, which is exactly what once made an install fail on "error
opening file for writing".

It looks for the core in this order:

1. `BOITE_CORE_COMMAND`, split on whitespace. This is the override the tests and
   the bench use.
2. `boite-core.exe` beside the shell executable. This is the installed case, and
   it is also what the end to end suite drives, which is why a stale staged
   sidecar is refused rather than tolerated.
3. `packages/core/dist/main.js` through bun, when a repository root is found
   above the executable. The development case with a built bundle.
4. `packages/core/src/main.ts` through bun. The development case without one.

## Icons

The app icon is one drawing, `packages/ui/public/icons/icon.svg`. The shell icon
set and the two PWA pngs are rendered from it, the first through the Tauri CLI's
own icon command from `apps/shell`. Nothing else draws the mark, and the UI's own
copy of it is a Svelte component using `currentColor`.

## Version numbers

The version lives in the root `package.json`, in each workspace package, and in
`apps/shell/src-tauri/tauri.conf.json`, which is the one the installer and the
window title read. Bump them together, in the same commit as the release.

## Before handing a build to anyone

Run `bun run e2e` on the staged build, not on the sources alone: it is the only
thing that drives the real shell executable over its debugging port, hidden.
Then run `bun run bench` and `bun run bench/idle-rss.ts` fresh, so the resource
figures in the release notes come from the build being released and carry its
date.
