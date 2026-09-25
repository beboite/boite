# Desktop updates

General settings contains the desktop update card. It names the installed
version and channel, the available version, its publication date and release
notes. When an update is ready, the title bar offers installation directly
from the conversation, with a confirmation before restarting. A separate
details action opens the update card.

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
in the window title, tray tooltip and title bar, and uses the violet and magenta
icon.

Keep a backup before trying nightlies: retaining files does not make a future
journal schema readable by an older release. Boite refuses a journal schema it
cannot read. The separate `build:shell:dev` build still uses `com.boite.two.dev`
and `boite2-dev`, and does not receive these updates. Older manually built
nightlies using that development identifier remain separate; their data is not
silently moved.

## Download and restart

The first automatic check starts eight seconds after the desktop UI mounts,
then repeats every six hours. A manual check is available in the card. Checks
and downloads run one at a time. A ready update is kept until installation or
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

Restarting always requires a click and an in-app confirmation. It interrupts
agents owned by that desktop. Saved conversations remain; interrupted turns
are not automatically retried. The local core is resident and outlives the
shell, so before launching the installer the shell asks it to stop through its
authenticated `POST /shutdown` and waits up to 12 seconds, then ends it. Until
the installer takes over, the shell refuses to start a core again, so the
window's reconnect cannot relaunch the old executable. If the core cannot be
stopped, nothing is installed and the card shows why; if the installer cannot
launch, the next reconnect starts the core again. A remote
core is not touched by the desktop updater.

The Windows installer stops the core of its own install too, for an update, a
manual reinstall and an uninstall. Its hooks (`windows/hooks.nsh` and
`windows/stop-core.ps1`) first close a running shell, with the installer's own
"Boite is running" question: an open window would start the core again within
seconds, from the file about to be replaced. They then find the
`boite-core.exe` processes running that install's exact file, ask the one named
in that channel's `core.json` (`boite2` or `boite2-dev`) to shut down, and end
any still running after 15 seconds. Boite Dev's core runs another file and is
left alone. No window opens. `scripts/ci/installer-hooks.test.ts` builds the
hooks into the generated installer script and runs them over a shell that
restarts its core; it needs a Windows `build:shell` first and is skipped
without one.

When the new shell starts, it reads the version the running core reports on
`/health`. A core of another version, left by an install that could not stop
it, is stopped and replaced by the core shipped with the shell.

Offline checks, missing releases, signature failures and installation failures
appear in the card with a retry action. They do not display a system dialog or
restart the application. A restart discards a previously downloaded cache and
checks again. Only the channel preference persists in `update-channel.json`.

## Scope

Automatic desktop updates currently support packaged Windows x64 builds.
Debug builds, Boite Dev, hidden test shells and browser clients cannot install
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
