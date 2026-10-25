# Desktop updates

## Downloading Boite

Open the [download page](https://github.com/beboite/boite/releases). New releases
list direct downloads by platform at the top of their notes: the Windows x64
installer, macOS DMGs for Apple Silicon and Intel, and Linux x64/ARM64 packages.
Choose `.deb` for Debian or Ubuntu, or AppImage for other supported distributions.
[Installation notes](portability.md#installing-a-release) cover system requirements
and macOS permissions. The Android client and Boite Server APKs appear when
attached to that release; [Android setup](android.md) and
[Android server setup](android-server.md) describe their different roles.

> [!WARNING]
> Nightly builds are unstable and may contain bugs or unfinished changes. Back up
> your Boite data before installing or switching channels. Current published
> builds are nightly prereleases; the Release channel becomes available after
> the first stable release.

## Finding updates

Settings, Machines and updates opens on one card that folds nothing: the
version this desktop app runs, the release found with its changelog on GitHub,
the channel (Nightly or Release), Check for updates and Update
([machines](machines.md#the-machines-page)). The card belongs to this
computer, even while another machine's conversation is open. Check reads the
desktop app, every server and every agent again; every other pending update is
listed under it by machine, and Update starts all of them. A release already
downloaded, with nothing else waiting, makes the button Restart, which installs
after a restart confirmation. Each machine's row below says in one word where
its updates stand (Up to date, Update available, Updating, Update failed).
Agent versions, with their own update and skip controls and the automatic
update switch, are on each machine's Providers page ([agent updates](agent-updates.md)).
Under them, **Install updates by itself when nothing runs** lets the app
install a release without a click ([installing by itself](#installing-by-itself)).

## Update everything

An update button sits in the sidebar's foot, beside the limits and Settings,
whenever something can update: this desktop app, Boite on a machine connected
with full control, or an agent there. Its card opens above the foot, bottom
left, and lists each machine with what it would install, the running version
beside the new one. A dot on the button marks a release not yet put off.

On a wide window the card opens by itself once per release, as soon as a
check finds it, and never during the tour. It takes no focus. It has two
buttons:

- Update the app downloads this desktop app's release alone. It shows only
  when the app has a release; once that release is downloaded it becomes
  Restart.
- Update all (Update when there is one thing) starts everything at once. With
  only the app to update, Update the app is the one button.

Its close button, Remind me later, puts off those releases, after a restart
too. A newer release lights the dot and opens the card again. A press
elsewhere only closes the card.

On a phone the card stays closed until the button is pressed, and opens as a
sheet. Settings, Machines and updates has the same thing as its Update button,
beside Check for updates.

Update all sends one `core.updateEverything` request to each machine, all at
once, naming the agents and the Boite release the card showed. Each core then
orders its own work, so a remote machine needs nothing more from this window
and no machine waits for another:

1. Every agent's update starts, pausing its running threads between two tool
   calls ([agent updates](agent-updates.md#turns-in-flight)).
2. Boite's own download starts beside their updaters, once each agent counts
   as updating: an update can first wait on a version check, and a quick
   download must not reach the idle gate in that gap.
3. The release installs through the idle gate, which counts an agent update as
   work under way, its pause and its registry reads included: the restart
   cannot replace the core under a half-written agent install. Any other work
   hands off at once: running turns end their tool call, 30 seconds at most,
   and resume after the restart ([server](server.md#updating-from-the-app)).

This computer's app downloads at the same moment and never restarts by
itself. Once its release is verified, the card offers Restart, disabled while
an agent of this computer's core still updates, because the restart stops
that core. Remote machines go on without it.

Each part shows its own progress in the card: download percentage, the
threads an agent waits for, Waits for work to finish, Restarting, or Failed
with the reason on hover. A part that lands keeps its row with a check and Up
to date for about a second, then the row slides away, so the list empties
one row at a time. A machine whose core is restarting keeps its row on
Restarting until it answers again. A failed part stays in the card and the
button tries it again. The card ends on Everything is up to date, which
puts itself away after a few seconds, or on "Boite is ready: restart it to
finish." with Restart. A core released before this request receives the same
updates one call each, without that ordering.

### The desktop app of another PC

Another Windows PC of the group shows its desktop app as a Boite row under
its name, and Settings, Machines and updates lists it under the app's own
update, started by the same Update button.
Only that PC's own window can run its installer, so the request goes through
its core:

1. The window reports its updater to the core its shell started, on every
   change (`core.desktopUpdateReport`). The core accepts the report only from
   that window: the core token on loopback with client `shell`. A member of
   the group, a phone, a browser tab or a plugin is refused by field. The core
   keeps the last report until that window's socket closes, and relays it to
   owner connections (`core.desktopUpdateChanged`, `core.desktopUpdateStatus`).
2. Update all, or Update on the Machines updates card, sends `core.updateEverything` with
   `app`, the version the report offered. The core starts the agents named,
   waits until none of them is updating, then sends `ui.appUpdate` to that
   window alone. Meanwhile the row reads Waits for work to finish.
3. The window checks the version against its own offer, downloads it if
   needed and installs it with no dialog there: the owner's click on the other
   machine is the consent. It shows a short notice first. The shell then does
   the restart handoff below and relaunches on the new version.

The row follows the window's download, then Restarting while that PC is out of
reach. A window that closes to install keeps its last report on the core, so
the row never reads as done before that PC answers on the new version.

With no window open on that PC (its shell quit, the core left resident), the
answer carries `appError`, "Boite is not open on <machine>", and the row shows
Failed with that reason. A window hidden in the tray still counts as open.
Only Windows PCs get the row and the button: a .deb asks for the administrator
password through `pkexec` and the macOS installer can ask too, with nobody at
that machine to answer. A core without `features.desktopUpdates` in its hello
shows no desktop row, as before.

## Installing by itself

**Install updates by itself when nothing runs** (FR "Installer les mises à
jour tout seul quand rien ne tourne"), the `autoInstallUpdates` setting of the
core this window's shell started, is off by default. The switch sits on the
updates card of an installed desktop app; a browser has no updater and no
switch. An agent proposes it with `boite settings request autoInstallUpdates
true`, whose card flips it in the chat.

When it is on, each automatic check (eight seconds after start, then every six
hours) that finds a release downloads it at once, then asks the shell to
install it quietly (`app_update_install_quietly`). The shell installs only
when both hold:

- the main window is not on screen: hidden in the tray. A window on screen may
  be in use even with nothing running, and its restart would take it away. It
  is checked again right before the core is asked, so a window restored from
  the tray while the install waited calls it off;
- the core grants `POST /shutdown-if-idle`, asked once: no turn, queued
  execution, RPC, peer request, tracked process or provider background work.
  The handoff that ends running turns, which Update uses, is never asked.

Otherwise the release stays downloaded and ready, offered as before,
and the next check tries again without downloading it a second time. An
admitted install says Installing, then runs the quiet installer as a clicked
one does. Before it runs, the shell leaves `update-quiet-restart` in its data
directory; the shell the installer starts reads and deletes it and comes back
in the tray, as a login start does, with no window and no focus taken. A file
older than 15 minutes counts for nothing.

It never touches the agents: their updates keep their own automatic switch
(`autoUpdateHarnesses`, [agent updates](agent-updates.md)). Update all, by
contrast, does cover them: it starts every agent's update before Boite's own.

The setting follows the group's default machine (`SYNCED_SETTINGS`): it is how
the owner wants Boite kept current, not something one machine can or cannot
do. A Docker server cannot update itself, but as the default machine its
value still reaches every desktop of the group, set once there from a settings
card of one of its threads. A desktop that turns it off from its own window
keeps its own value ([synchronization](machines.md#automatic-settings-synchronization)).

## Boite and Boite Nightly

Choose Release for regular releases or Nightly for checked daily builds from
`main` ([CI schedule](ci.md#boite-de-nuit)). Nightlies may contain unfinished
changes. Until the first stable release is published, Release stays disabled
(`RELEASE_PUBLISHED` in `UpdatesCard.svelte`).

Changing the channel immediately checks for its newest signed release and
offers it. Returning from nightly to Boite permits a lower version. Both
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
then repeats every six hours. The card's Check for updates button checks at
once; it stays in the card during a check, disabled, and only makes way for
the download progress and the install action. Checks and downloads run one at
a time. A release found is announced at once and downloads only when asked:
an automatic download first held the announcement back for as long as the
download took. Install and restart downloads it after the confirmation and
installs as soon as it is verified. A ready update is kept until installation
or a channel change, without downloading the same version every six hours.

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
`POST /shutdown-for-update` with the expected core PID. The [restart handoff](restart-handoff.md) gives
active tool calls up to 30 seconds before stopping. The new core resumes those
threads and queued turns.

The request commits the installation: there is nothing to cancel once it is
sent. The shell allows 60 seconds for the core to exit and never force-kills
it for an update. No installer runs if the request is refused or the exit
cannot be confirmed. The shell holds reconnects until installation takes over,
so the window cannot relaunch the old executable. An installation failure
releases that hold; the core then starts again and resumes the threads as it
would after the update. The desktop updater never installs on another
machine by itself: another PC's app installs through that PC's own window
([the desktop app of another PC](#the-desktop-app-of-another-pc)).

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
starts. Its hooks (`windows/hooks.nsh`, `windows/stop-shell.ps1` and
`windows/stop-core.ps1`) first close a running shell, with the installer's own
"Boite is running" question: an open window would start the core again within
seconds, from the file about to be replaced. Only a shell running from that
install's directory counts, under the build's binary name or the one the
previous install registered; the template's own check, which matches a file
name across the session and would close Boite Dev's window from Boite's
installer, is skipped. They then find the
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
another file and is left alone. The stop script opens no window. Once the core
is stopped, the install hook removes the install's `core/` and `ui/`
directories before the copy, and the uninstall hook removes them as well, so
no earlier build's hashed chunks remain ([releasing](releasing.md#what-the-installer-holds)).
`scripts/ci/installer-hooks.test.ts` builds the
hooks into the generated installer script and runs them over a shell that
restarts its core; it needs a Windows `build:shell` first. Local runs skip without fixtures;
desktop CI sets `BOITE_CI_INSTALLER_REQUIRED=1` and fails if they are missing.
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
through 2026-09-26 predate that guard and can remain on Checking for updates
after a release-client panic; they need one manual replacement. A restart discards a previously downloaded cache and
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
a remote machine; another machine asks it through its core, never directly. [Agent updates](agent-updates.md) are separate, as are
[server image updates](server.md).

The first version containing this updater must be installed manually. It only
offers published releases containing a signed installer and `latest.json`.
Drafts and unsigned historical builds are excluded. The native shell reads the
repository's release list, so nightly prereleases and regular beta releases do
not depend on GitHub's `latest` alias. It checks at most ten pages of 100 releases
and reports when no matching signed release can be found.

[Releasing](releasing.md) describes signature generation and the CI artifacts.
