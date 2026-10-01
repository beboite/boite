# Desktop updates

The sidebar footer shows an update icon when the app or a remote server has
an update available or in progress. Its popup
names the release and how long ago it was published, links to its changelog on
GitHub, and offers installation with a restart confirmation. Release channel
options show the installed version and let you switch channels.

A dot marks an update ready to install. Hide reminder clears that dot for the
version and channel, including after restarting the app. The icon stays
available for installation; a different release lights the dot again.
The settings navigation keeps the same icon at its foot.
When the app is current, the icon is hidden. Settings, General keeps the manual
check and channel controls available. Remote server entries open the owning
machine's update card; see [server updates](server.md#updating-from-the-app).

## Boite and Boite Nightly

Choose Boite for regular releases, including the current beta, or Boite Nightly
for the daily build from `main`. A nightly publishes only when that commit has
not already shipped and its CI checks pass. Nightlies may contain unfinished
changes.

Changing the channel immediately checks for its newest signed release and
downloads it. Returning from nightly to Boite permits a lower version. Both
channels use the same install location, bundle identifier and `boite2` data
directory. Projects, accounts and journal files stay in place. The Windows
installer retains the name Boite. A nightly build calls itself boite (de nuit)
in the window title and tray tooltip, and uses the violet and magenta icon. The
title bar inside the window never shows the app's name: its room goes to the
project, the thread or settings.

Keep a backup before trying nightlies: retaining files does not make a future
journal schema readable by an older release. Boite refuses a journal schema it
cannot read: the core names the file and both schema versions on stderr, leaves
the file untouched and exits with code 1. Cores built before this check open a
newer journal anyway, so restore the backup before going back to one. The
separate `build:shell:dev` build still uses `com.boite.two.dev` and `boite2-dev`, and does not receive these updates. Older manually built
nightlies using that development identifier remain separate; their data is not
silently moved.

## Download and restart

The first automatic check starts eight seconds after the desktop UI mounts,
then repeats every six hours. The popup's Check for updates button checks at
once; it stays in the popup during a check, disabled, and only makes way for
the download progress and the install action. Checks and downloads run one at
a time. A ready update is kept until installation or
a channel change, without downloading the same version every six hours.

No request has a total deadline, because an installer on a slow link may take
minutes. Each one gets 15 seconds to connect and fails after 30 seconds without
receiving a byte, so a link that stops sending gives the updater back instead of
holding it until the app restarts. The release listing is requested gzipped.

Downloads show bytes received and a percentage when a total is known. The shell
checks the updater signature before offering installation, writes the verified
payload to disk and releases the download buffer. Progress events are limited
to ten per second. Installation checks the payload against its retained digest
before handing those bytes to Tauri's installer.

Installing requires a click and an in-app confirmation. Boite does not wait
for the threads to finish. The shell sends the owner-authenticated
`POST /shutdown-for-update` with the expected core PID, and the core starts a
[restart handoff](restart-handoff.md): each running turn ends the tool call it
is in, 30 seconds at most, then stops. Queued turns stay queued. The core that
starts after the installation resumes those threads and runs the queued turns.

The request commits the installation: there is nothing to cancel once it is
sent. The shell allows 60 seconds for the core to exit and never force-kills
it for an update. No installer runs if the request is refused or the exit
cannot be confirmed. The shell holds reconnects until installation takes over,
so the window cannot relaunch the old executable. An installation failure
releases that hold; the core then starts again and resumes the threads as it
would after the update. Remote cores are not touched by the desktop updater.

A core released before the handoff answers 404 to that request. The shell then
falls back to the earlier rule, once, for that update: it polls
`POST /shutdown-if-idle` and the core refuses while a turn, queued execution,
RPC, signed peer request or tracked process is active, or while a provider
reports background work, terminals and warm provider sessions included. The
app stays usable, new work extends the wait, and Cancel restores the downloaded
update without downloading it again. Once admitted, the core drains and exits
within 12 seconds. Peer bodies awaiting authentication do not block that
admission; they are limited to 262144 bytes and five seconds, and a peer
authenticated after admission is refused.

The Windows installer run by hand, for an update or a reinstall, still requires
idle admission: the in-app update has stopped the core before the installer
starts. Its hooks (`windows/hooks.nsh` and
`windows/stop-core.ps1`) first close a running shell, with the installer's own
"Boite is running" question: an open window would start the core again within
seconds, from the file about to be replaced. They then find the
`boite-core.exe` processes running that install's exact file, plus a core
hosted by `bun.exe` when its PID matches `core.json` and its parsed arguments
name that install's `core/main.js` and data directory. Other Bun processes
are left alone. Accepting the interactive Kill prompt also authorizes stopping
that resident core, including an older core without idle admission. Silent
and passive installations still require idle admission. In those modes a busy,
unreachable or older core without idle admission aborts installation before
files are replaced. An admitted core that has not exited after 15 seconds also
aborts installation. Explicit uninstall still requests ordinary shutdown and
ends any core of that install left after 15 seconds. Boite Dev's core runs
another file and is left alone. The stop script opens no window.
`scripts/ci/installer-hooks.test.ts` builds the
hooks into the generated installer script and runs them over a shell that
restarts its core; it needs a Windows `build:shell` first and is skipped
without one.
`scripts/ci/stop-core.test.ts` also runs the stop script directly, without a
packaged shell, and checks that busy and legacy cores remain running.

The first silent upgrade from a core without idle admission needs an explicit
stop after its work finishes, followed by a manual installer. An older in-app
updater retains its previous interrupting behavior until it is replaced.
An update replaces the whole application; it does not load a new core or UI
alongside agents executing on the old version.

Both in-app updates and downloaded Windows installers replace an existing
installation in place. They keep its Start menu and desktop shortcuts intact
when the executable path is unchanged, preserving the shortcuts used by pinned
entries. Switching between stable and nightly uses that same path. Removing
Boite through Windows' installed apps still removes its shortcuts and pins.
The custom NSIS template and its upstream version are documented in
`apps/shell/src-tauri/windows/VENDOR.md`.

Linux and macOS have no installer hook. A .deb, AppImage or application
replaced by hand while its core runs leaves that core running the deleted file
until the next shell starts, which then replaces it as described below.

When the new shell starts, it reads the version the running core reports on
`/health`. For Windows split bundles it also compares the entry file's SHA-256
with the hash captured by the core at startup. A previous bundle is replaced
even when a reinstall keeps the same version number. A legacy core without a
hash is also replaced when this install has a split bundle. Compiled sidecars
and source runs continue to compare versions.

Offline checks, missing releases, signature failures and installation failures
appear in the card with a retry action. They do not display a system dialog or
restart the application. A panic inside a check or a download ends the same
way: an async Tauri command that panics never answers the window, so each one
runs its work under `catch_unwind` and reports the panic as an error. Nightlies
up to 2026-09-26 predate that guard and panic on every check while building
the release client, so their card stays on "Checking for updates": replace
them once with a manual install. A restart discards a previously downloaded cache and
checks again. Only the channel preference persists in `update-channel.json`.

## Scope

Automatic desktop updates support the packages a release publishes: the
Windows x64 installer, the macOS application bundle on Intel and Apple Silicon,
and the Linux .deb and AppImage on x64 and ARM64. The Linux bundler stamps the
package type into the executable, and `latest.json` names one payload per type
(`linux-x86_64-deb`, `linux-x86_64-appimage` and their ARM64 twins), so an
AppImage never downloads a .deb. A Linux executable with no stamped type, such
as a bare `cargo build`, is not updatable. A .deb installs through `pkexec`,
which asks for the administrator password; an AppImage replaces its own file,
which must stay writable. The macOS update replaces the application bundle in
place, so a copy still running from the mounted DMG cannot update. Debug builds, Boite Dev, hidden test shells and browser clients cannot install
an update. The updater belongs to the local desktop, even while the UI displays
a remote machine. [Agent updates](agent-updates.md) are separate, as are
[server image updates](server.md).

The first version containing this updater must be installed manually. It only
offers published releases containing a signed installer and `latest.json`.
Drafts and unsigned historical builds are excluded. The native shell reads the
repository's release list, so nightly prereleases and regular beta releases do
not depend on GitHub's `latest` alias. It checks at most ten pages of 100 releases
and reports when no matching signed release can be found.

[Releasing](releasing.md) describes signature generation and the CI artifacts.
