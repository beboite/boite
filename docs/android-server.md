# Boite on an Android phone

This is the server, separate from the [Android client app](android.md).
Installing the client alone does not install Termux, a core or agent CLIs.

`apps/android-server` turns a phone into a Boite machine: the core and the
agents run on it, and the person's other devices open it like any
[headless server](server.md). It has two parts:

- `termux/`: `install.sh` and the `boite-server` command, which run in
  [Termux](https://termux.dev), the Linux environment for Android.
- `app/`: the Boite Server app (`com.boite.server`), a native screen that
  drives `boite-server` through Termux. It installs nothing itself and holds no
  data.

The app's version is its own (`apps/android-server/VERSION`), apart from
Boite's: the core it runs updates itself.

## What a phone needs

- A 64-bit ARM processor (`aarch64`). `install.sh` refuses any other.
- Android 7 (API 24) or later, the app's `minSdk`.
- Termux from F-Droid or from its GitHub releases. The Google Play build is a
  separate, experimental one that Boite Server is not tested with.
- Several hundred megabytes for the first install: Termux packages, Bun,
  the release and Claude Code.

## Installing

The app opens on the step the phone is at: install Termux, allow the app to
run commands in it (the `com.termux.permission.RUN_COMMAND` permission, asked
once), then run the install command it shows, for the stable or nightly
channel:

```sh
curl -fsSL https://raw.githubusercontent.com/mtsu-dev/boite/main/apps/android-server/termux/install.sh | bash -s -- --channel stable
```

`install.sh`:

1. Upgrades Termux (it supports no partial upgrade) and installs `git`,
   `ripgrep`, `curl`, `unzip` and `glibc-runner`, then `codex` where the
   repository has it.
2. Downloads Bun's Android build, `bun-linux-aarch64-android.zip`, at the
   version pinned in the script, and refuses it unless its SHA-256 matches.
3. Writes the `boite-server` command on Termux's `PATH` and sets
   `allow-external-apps = true` in `~/.termux/termux.properties`, without
   which Termux refuses the app's commands.
4. Runs `boite-server install`: the signed release, Claude Code, then the
   core.

Running it again updates everything and keeps the conversations. `--bundle
<zip>` installs a local `boite-server_<version>_android.zip` instead of
downloading one.

Everything lives in `~/.boite-server`: `config.json`, the supervisor's
`server.json`, `core.log` (moved to `core.log.1` past 8 MB), `releases/` with
`current` pointing at one (the previous one is kept), `runtime/` for Bun,
`agents/`, `cli/` and `data/`, the core's `BOITE_DATA_DIR`.

## The `boite-server` command

| Command | What it does |
| --- | --- |
| `install [--channel stable\|nightly] [--bundle <zip>] [--no-claude]` | First install, also run by `install.sh`. |
| `start`, `stop`, `restart` | `stop` asks the core to end and kills it after 60 s. |
| `status [--quick]` | `--quick` leaves out the agents' versions, which take seconds to read. |
| `pair [--owner]` | A one-time link for a phone or browser, or with `--owner` for a desktop app. |
| `update [--check] [--force] [--bundle <zip>]` | The newest release of the channel. |
| `agents` | Installs or updates Claude Code. |
| `sign-in claude\|codex` | Runs the agent's own sign-in in this terminal, then has the core read the accounts again. |
| `config [<key> <value>]` | `channel stable\|nightly`, `host lan\|tailscale\|local`, `port <n>`, `autostart on\|off`, `name <text>`. |
| `logs [<lines>]` | The end of `core.log`. |
| `uninstall [--purge]` | `--purge` also deletes `data/`. |

Each takes `--json`, which is what the app reads: one JSON line on stdout,
with `ok` and, when false, `error`.

`host` decides where the core listens: `lan` on every interface, so the
Wi-Fi and Tailscale addresses both answer; `tailscale` on the tailnet address
alone, waiting until the phone joins it; `local` on this phone only. A change
to `host` or `port` applies on the next start.

While the Tailscale app is connected, the core finds the tailnet address on
the `tun` interface the app opens. Unless `host` is `local`, the group's roster
then gives the phone's MagicDNS name and tailnet address before the Wi-Fi one,
so the other machines still reach the phone away from that Wi-Fi.

`name` is what the other machines of a group and every client call the phone.
Android gives every app the host name `localhost`, and the name set in the
phone's own settings is out of Termux's reach, so without one the core goes by
the maker and model from `getprop` (`OnePlus GM1913`). `boite-server` passes it
to the core as `BOITE_MACHINE_NAME`; `config name ""` returns to the maker and
model. A change applies on the next start, and the group's roster then carries
it to the other machines.

## Releases and updates

`desktop.yml` builds `boite-server_<version>_android.zip` on its Linux x64 job
(`scripts/ci/android-server-bundle.ts`, `androidServerBundle` in
`packages/core/bin/server-bundle.ts`): the core's scripts, the UI,
`boite-server.ts` and `server-release.json`, which names the Bun build the
release runs on.
`updater-manifest.ts` lists it in the release's `latest.json` under the
`android-aarch64-server` target, signed with the key the desktop updater
trusts.

`update` picks the newest GitHub release of its channel whose `latest.json`
carries that target, checks the Minisign signature against the same public
key and unpacks it beside the running release, which keeps serving meanwhile.
It then stops the core, switches `current` and starts it again; a new core
that never answers puts the previous release back. Until a stable release carries
the target, the stable channel answers that none does and names the nightly
one.

## Running and starting with the phone

`start` launches a supervisor detached from Termux, which takes Termux's wake
lock (CPU and Wi-Fi stay up with the screen off) and starts the core again
when it exits, waiting 1 s, then 2, 5, 10, 30 and 60 s while it keeps exiting
within a minute.

The app's `BootReceiver` answers `BOOT_COMPLETED` and the `QUICKBOOT_POWERON`
broadcasts some makers send instead. It runs `boite-server boot`, which starts
the core when `autostart` is on and a release is installed. It does not wait
for the network: with `host` set to `tailscale`, the core listens once the
phone joins the tailnet.

Many makers stop that broadcast or the processes it starts. The app's "Keep it
running" section asks for:

- Termux's battery use set to Unrestricted.
- Boite Server allowed to start with the phone, where the phone has a switch
  for it. OxygenOS 12 has it in the app's settings, Battery usage, Allow auto
  launch; without it the app receives no `BOOT_COMPLETED`.
- On Android 12 and later, Developer options › Disable child process
  restrictions where the phone offers it: Android 12's phantom process killer
  otherwise stops background child processes past 32 across all apps.
- The [dontkillmyapp.com](https://dontkillmyapp.com) guide for the phone's
  maker.

## Agents in Termux

Claude Code's Linux build expects glibc, which Android lacks. `boite-server`
installs it under `agents/` and runs it through the loader `glibc-runner`
provides. Termux's `termux-exec` preload would break that loader, so the
`claude` wrapper moves `LD_PRELOAD` to `BOITE_TERMUX_PRELOAD` and Claude's
commands run through `~/.boite-server/shell/bash` (its `SHELL` and
`CLAUDE_CODE_SHELL`), which puts the preload back: `#!/usr/bin/env` scripts
then work in its commands. Claude's own updater is off (`DISABLE_AUTOUPDATER`);
the app's "Update Claude Code" runs `boite-server agents`.

Codex comes from Termux's package, updated with `pkg upgrade codex`.

The core sees `process.platform === 'android'` under Bun's Android build and
treats it as Linux through `currentOs()`.

## Signing an agent in

A conversation gets no answer until its agent is signed in. `status` reports
`signIns`, each agent's best account status from `boite-core accounts --json`
(`ok`, `unknown`, `error` or `unauthenticated`); `status --quick` leaves it
out. The app's "Agents" section shows it while the core runs.

Its "Sign in" button runs `boite-server sign-in <agent>` in a new Termux
terminal, which Termux brings forward: `claude auth login` through the
`claude` wrapper, or `codex login --device-auth`. Each prints a link to open
and, for Claude, asks for the code the page gives back. The command then runs
`boite-core accounts --refresh`: the core reloads its providers, which adopts
the CLI's login as a default account, and checks every account. Coming back to
the app reads the status again.

A paired desktop app can sign the phone's agents in from its Settings ›
Providers instead.

## Pairing

`pair` asks the running core for a one-time link. The core may build it on a
mobile data address, so `boite-server` rewrites it onto the addresses
`status` lists (Wi-Fi, then Tailscale) and returns them all as `urls`. The app
draws the chosen one as a QR code under `FLAG_SECURE`, which keeps it out of
screenshots and the recent apps view, and copies it marked sensitive. The
logs the app shows replace any `grant` or `token` value with `…`.

## The app

`app/` is Kotlin with Jetpack Compose, colors from Boite's dark palette
(`Theme.kt`), strings in `res/values/strings.xml` with the French in
`res/values-fr/`. `Termux.kt` sends `com.termux.RUN_COMMAND` with a
`PendingIntent` that brings the command's stdout, stderr and exit code back;
`Model.kt` polls `status --quick` every 5 s while the screen is visible.

Building it needs JDK 17 and the Android SDK (platform 37):

```sh
cd apps/android-server
./gradlew assembleDebug
./gradlew assembleRelease -PboiteVersion=1.0.3 -PboiteVersionCode=1000003
```

Without the properties, the version is `VERSION` with patch 0. A release APK
comes out unsigned; `apksigner` signs it.

`bun test ./apps/android-server` runs the controller's tests and
`bun run check:android-server` type-checks it.

## Publishing the app

`ci.yml` builds the APK unsigned, the `Android server / apk` check, when
`apps/android-server` outside `termux/`, `android-server.yml`,
`scripts/ci/android-server-apk.ts` or `scripts/ci/android-apk.ts` change.
`termux/` is not in the APK but in the release bundle, so a change there runs
the core suite, which packs it, the type checks and the desktop jobs, which
build it.

The nightly runs `android-server.yml` with `release` on, and the release
attaches `boite-server-android-<MAJOR.MINOR.PATCH>.apk` beside the Boite app's
APK and lists it in `SHA256SUMS.txt`. `android-server-apk.ts reuse` takes back
the newest published one when its tag is in the checkout, nothing under
`apps/android-server` outside `termux/` changed since that tag, and its
certificate is still the one `assetlinks.json` publishes. Otherwise the job
builds the next patch and signs it with the Boite app's key (`ANDROID_KEYSTORE`,
alias `boite`), then checks that certificate the same way: Android refuses an
update signed with another key.

The version counts like the Boite app's ([Android](android.md#the-app-version)):
`VERSION` holds MAJOR.MINOR, raised by hand and never below the published one,
and the patch grows only when the APK is rebuilt.
