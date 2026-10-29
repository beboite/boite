# Plugins

A plugin is one native executable. Boite downloads it over https, checks it
against the SHA-256 its manifest publishes, and runs it for the features the
manifest names. There are three features today: account pools, which save and
switch the default login of an agent CLI, desktop apps, which Boite starts
beside itself with the owner's access ([Desktop apps](#desktop-apps)), and
gateways, which Boite runs in the background for the subscription proxy
([Gateways](#gateways)).

Settings > Plugins has three sections. Installed and Recommended are drawn
only when they hold a plugin:

- Installed: every plugin on this core, with its version, the commit it came
  from, its pools and its errors.
- Recommended: the plugins Boite ships a manifest for and that are not
  installed yet, in the order Boite lists them. Today that is
  [Bots](https://github.com/Skollheim/bots), the desktop companion, and
  [Douane](https://github.com/mtsu-dev/douane), the subscription gateway. A row there
  carries the name, version, a link to the source, the description and
  Install, with no state line.
- Add from a git URL: any repository with a `boite-plugin.json` at its root.

A plugin installed as recommended that a later Boite no longer lists, such as
kebacc-switcher before 2026-10-16, stays under Installed with its pools until
the owner uninstalls it; it no longer receives updates.

Plugins are administration of the machine that hosts the core, so every
`plugins.*` method is owner only and the phone settings leave the page to the
desktop app ([phone](phone.md)).

Each core has its own plugins. The page opens on this PC when the window has
one, since a desktop app shows its window there, whichever machine the open
conversation runs on. With several machines connected, a menu beside the
heading names the machine shown and switches to another one this window owns.

## The manifest

Put `boite-plugin.json` at the root of the repository:

```json
{
  "schema": 1,
  "id": "seat-pool",
  "name": "Seat pool",
  "version": "1.4.0",
  "description": "Keeps several OpenCode logins and switches the active one.",
  "homepage": "https://github.com/example/seat-pool",
  "executable": "seat-pool",
  "artifacts": {
    "win32-x64": {
      "url": "https://github.com/example/seat-pool/releases/download/v1.4.0/seat-pool-win32-x64.exe",
      "sha256": "c41e9b0a7d3f5e2b8a6c4d1f0e9b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a"
    },
    "linux-x64": {
      "url": "https://github.com/example/seat-pool/releases/download/v1.4.0/seat-pool-linux-x64",
      "sha256": "0d2f4b6a8c1e3f5a7b9c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b5c7d9e2f4a"
    }
  },
  "provides": {
    "accountPools": { "providers": ["opencode"] }
  }
}
```

| Field | What Boite accepts |
| --- | --- |
| `schema` | `1`. |
| `id` | Lowercase letters, digits and inner hyphens, 1 to 64 characters. It names the install directory and must not be a recommended plugin's id. |
| `name` | 1 to 60 characters, no control characters. |
| `version` | `MAJOR.MINOR.PATCH`, optionally followed by `-` or `+` and a suffix: `1.2.0`, `1.2.0-beta.1`. |
| `description` | 1 to 300 characters, no control characters. |
| `homepage` | An https URL with a host and no user or password, at most 2048 characters. The page links to it as the source code. |
| `executable` | The file name Boite saves the download as: a letter or digit, then letters, digits, `_` and `-`, 64 characters at most, no extension. Boite adds `.exe` on Windows. |
| `artifacts` | An object keyed by platform, at least one of `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`. Each value is `{ "url", "sha256" }`: an https URL as for `homepage`, and the file's SHA-256 as 64 lowercase hexadecimal characters. |
| `provides` | An object naming at least one feature, among `accountPools`, `desktopApp` and `gateway`. `accountPools` is `{ "providers": [...] }`: a non-empty list of distinct provider ids among `antigravity`, `claude`, `codex`, `grok`, `muse`, `opencode`, `opencode-v2` and `pi`; a retired provider id (`antigravity-cli`) is accepted and dropped, so a plugin installed under an older Boite keeps loading. `desktopApp` and `gateway` are `{}`, objects with no field ([Desktop apps](#desktop-apps), [Gateways](#gateways)). A plugin may provide several. |

The platform key is `process.platform` and `process.arch` of the machine that
runs the core, joined by a hyphen. A core on a Linux server downloads the
`linux-x64` artifact even when the owner clicks from Windows.

All fields are required; unknown fields at any depth are refused. Errors name
the file, field and expected value:

```
boite-plugin.json: artifacts.win32-x64.sha256 must be 64 lowercase hexadecimal characters, found "ABC123"
```

The page shows the same three parts, and installs nothing.

## Account pools

A plugin that provides `accountPools` answers five command lines. Boite runs
nothing else, and the page lists these lines before the owner installs:

```
seat-pool list -<pool> -Json
seat-pool list -<pool> -Json -Refresh
seat-pool add -<pool>
seat-pool switch -<pool> -Email <email> -Yes
seat-pool remove -<pool> -Email <email> -Yes
```

`<pool>` is one of the provider ids the manifest lists. `add` saves the login
the CLI uses now into the pool, `switch` makes a saved login the CLI's default
again, `remove` forgets a saved login. `-Refresh` asks for fresh quota readings
instead of cached ones. These three change nothing Boite reads on stdout; they
succeed with exit code 0.

`list` prints one JSON object on stdout:

```json
{
  "accounts": [
    { "email": "team@example.com", "live": true, "checkedSecondsAgo": 42, "fiveHour": 18, "sevenDay": 51 },
    { "email": "side@example.com" }
  ]
}
```

- `email` is required, a non-empty string.
- `live: true` marks the login the CLI uses now.
- `checkedSecondsAgo` is how old the quota reading is.
- `fiveHour` and `sevenDay` are the percentage used of the five-hour and weekly
  windows. Boite clamps them to 0 to 100.
- A reading that is absent is shown as unavailable, never as zero. Other fields
  are ignored.

Each run:

- starts through the core's process launcher, traced as `plugin:<id>:<n>`, in
  the plugin's directory with the core's environment;
- has a 60-second deadline and registry cleanup on exit. Windows Job Objects
  track its descendants; POSIX cleanup signals its process group and cannot
  catch descendants that leave it ([trace](trace.md#platform-boundary));
- may write at most 4 MB on stdout and on stderr.

A nonzero exit is reported as `seat-pool switch -opencode failed with exit code 1.`
Boite never forwards the program's stdout or stderr to a client, because a
login tool may print tokens. Write your diagnostics to your own log.

Readings are cached for a minute, and a refresh runs the program again only
when the last reading is older than ten seconds.

Pools change the CLI's default login. [Isolated Boite accounts](accounts.md)
keep their own credentials. Before `add`, `switch` or `remove`, Boite refuses
while a turn on that provider's default login is running, queued or waiting,
releases any warm agent on that login, and holds new turns on it until the
command exits. One login change runs at a time across all plugins.

## Desktop apps

A plugin that provides `desktopApp` is a program with a window of its own,
such as [Bots](https://github.com/Skollheim/bots). Boite starts it and keeps it
running; the app then talks to the core like any client.

```json
{
  "schema": 1,
  "id": "bots",
  "name": "Bots",
  "version": "0.1.0",
  "description": "Little robots on your desktop, one for each agent at work.",
  "homepage": "https://github.com/Skollheim/bots",
  "executable": "bots",
  "artifacts": {
    "win32-x64": { "url": "https://github.com/Skollheim/bots/releases/download/v0.1.0/bots.exe", "sha256": "…" }
  },
  "provides": { "desktopApp": {} }
}
```

`desktopApp` takes no field; any key in it is refused. The artifact is the
app's single release executable.

The core starts an installed app:

- when the core starts, if Start with Boite is on (`autostart`);
- right after its install or an update finishes, if it is on (`enabled`);
- when the owner clicks Start or Restart in Settings > Plugins
  (`plugins.app {id, action: "start" | "stop" | "restart"}`).

It runs the executable with no argument, from the plugin's directory, through
the core's process launcher as `plugin:<id>:app`. On Windows its window is not
hidden. Its stdout and stderr are read and dropped; no client ever sees them.

The environment is the core's, minus every variable the core gives an agent
(`BOITE_THREAD_ID`, `BOITE_AGENT_TOKEN` and any other `BOITE_AGENT_*`), plus:

| Variable | Value |
| --- | --- |
| `BOITE_CORE_URL` | The core's address, `http://<host>:<port>`, in the form the `boite` CLI reads. |
| `BOITE_TOKEN` | The owner token. |
| `BOITE_PLUGIN_ID` | The plugin's id. |

The app connects to `BOITE_CORE_URL` with `BOITE_TOKEN` as an owner client.
Its `hello` names the client `plugin`, not `shell`: the core then adds no
"sent from the desktop app" note to its prompts and refuses it as the agent
browser's host. A thread it subscribes to is not on anyone's screen: a turn
that ends there still marks the thread unread, and `panel.open` still answers
`shown: false` when no window has it open.

Exits and stops:

- An exit with code 0 leaves the app stopped. It starts again on the next core
  start while Start with Boite is on, or when the owner starts it.
- Any other exit, or a signal, starts it again after 2 seconds, then 10, then
  30. A fourth crash within five minutes leaves it crashed, with the exit code
  and a message on its row, until the owner starts it.
- Stop kills the app's process tree and turns it off until the next core
  start, or for good while Start with Boite is off. Start and Restart turn it
  back on.
- Uninstall kills it first. An update kills it before the new executable
  replaces the old one, and starts the new one after.
- Core shutdown kills it.

Start with Boite is the switch under the app's state on its row
(`plugins.autostart {id, autostart}`). It decides only what the next core
start does: nothing running starts or stops when it changes.

Both choices are kept in `<dataDir>/plugins/<id>/app.json`
(`{"enabled": true, "autostart": true}`), across core restarts and updates. A
first install turns both on. A file written before `autostart` existed starts
with the core when it was left on, as that core did.

A Linux core with neither `DISPLAY` nor `WAYLAND_DISPLAY` set has no desktop to
show a window on: it does not start the app, and the row says so.

The plugin's row shows the app's state (running, starting again, stopped,
crashed with its exit code, or unavailable with the reason) with Start, Stop
and Restart. `plugins.app` answers with the plugin's state, and every change is
announced by `plugins.updated`. The state is `PluginState.app`:

```ts
{ enabled: boolean; autostart: boolean; status: 'stopped' | 'starting' | 'running' | 'crashed' | 'unavailable';
  pid: number | null; exitCode: number | null; error: string | null; startedAt: number | null }
```

A core older than `plugins.autostart` sends no `autostart`, and the row shows
no switch.

### Showing Boite

An app that wants the owner to look at something calls
`ui.reveal {target}`, where `target` is `{ "kind": "thread", "threadId": "…" }`,
`{ "kind": "agent", "agentId": "…" }` or `{ "kind": "update" }`, the app updates
a newer Boite is installed from. A thread must exist on the core; an
agent id is 1 to 200 characters. The core sends the `ui.reveal` event to every
owner connection except desktop-app plugins, the caller included, and answers
`{delivered}`, the number of connections it reached.

A thread or an agent on another machine of the user's Boite takes that
machine's core id as `coreId`, on a thread target as on an agent one:
`{ "kind": "thread", "threadId", "coreId" }`. The id is the 64 hex character
fingerprint `collaboration.peers` and `group.get` list. The core accepts it
when it is a member of its group or a machine trusted for coordination, and
refuses any other with `target.coreId`; it cannot see that machine's journal,
so the thread id there is only checked for length (1 to 200). The core's own
id means the core itself and is dropped from the event, so a target on this
core reads the same with or without it. A core that understands `coreId` says
so in its `hello` answer, `core.features.revealMachines`. An older core drops
the field, refuses a thread it does not have and opens its own agent page, so
an app checks the flag before it names a machine.

The desktop shell connected to the core it started on the same computer
answers it: it unminimizes and focuses its window, then opens the thread, the
Bots page on that bot (switching the Bots experiment on if it was
off), or the app updates in Settings, Machines. A target with `coreId` opens on
the window's machine whose core has that id; when the window has no such
machine, or has it but not connected, it says so on the page it shows and opens
nothing. Browser tabs, paired devices and windows following another machine do
nothing.

`ui.reveal` is owner-only, as is the event: a paired device or an agent that
calls it is refused, and neither receives it.

## Gateways

A plugin that provides `gateway` is a subscription gateway speaking Douane's
runtime contract, such as [Douane](https://github.com/mtsu-dev/douane). Boite
runs it in the background; the subscription proxy's local mode points at it
([providers](providers.md#douane-on-this-machine)).

```json
"provides": { "gateway": {} }
```

`gateway` takes no field; any key in it is refused. The executable answers:

- `<executable> --config <file>`: it reads the TOML file Boite wrote, whose
  relative paths resolve from the file's folder.
- `GET /health` with `{"status":"ok","version":"<version>"}` once it serves.
- `GET /admin/api/summary` with `in_flight`, the requests it is serving, open
  on loopback without a token.

Its data lives outside the plugin directory, so an uninstall keeps it:
`<dataDir>/douane/` for Douane, `<dataDir>/gateways/<id>/` for any other. Boite
writes `<executable>.toml` there once:

```toml
[server]
listen = "127.0.0.1:8787"
auth_dir = "auth"
database = "douane.sqlite"
```

and afterwards only moves its `listen` line, because the gateway saves its own
settings into the same file. The port is the one remembered for the plugin
(journal setting `gateway-port:<id>`) when it is free, 8787 otherwise, any free
port last; a new port is remembered and, for Douane, written into the proxy's
URLs.

The core runs it:

- when the core starts while Start with Boite is on, after its install or an
  update while it is on, and on Start or Restart
  (`plugins.gateway {id, action: "start" | "stop" | "restart"}`);
- from its data directory, through the core's process launcher as
  `plugin:<id>:gateway`, with no window and no `DISPLAY` requirement;
- with the core's environment minus every agent variable, `BOITE_TOKEN` and
  `BOITE_CORE_URL`: a gateway never talks to the core. `NO_COLOR=1` is added.

Its stdout and stderr go to the core log line by line (`source: plugins`,
`event: gateway.output`), never to a client. It counts as started once
`/health` answers, within 30 seconds; one that stays silent is stopped and
treated as a crash. Crashes, Stop, uninstall and core shutdown follow the
[desktop apps](#desktop-apps)' rules: 2, 10 and 30 seconds, then `crashed`
after a fourth exit within five minutes; whether it is on and whether it
starts with Boite are kept in `<dataDir>/plugins/<id>/gateway.json`, and the
same switch sits on its row.

An update waits until `in_flight` reads 0 (five minutes at most, then it goes
ahead), stops the gateway, keeps the old executable as `<executable>.previous`
and starts the new one. The old one is deleted once the new one answers
`/health`. When it does not, the old one goes back and starts again, and the
update fails with the reason, keeping the version that worked.

On Linux, a gateway a dead core left running is stopped at the next start when
its command line still names this configuration (`gateway.pid` in its data
directory). Elsewhere the core's Job Object (Windows) or service manager takes
it down with the core.

`PluginState.gateway` carries its state:

```ts
{ enabled: boolean; autostart: boolean; status: 'stopped' | 'starting' | 'running' | 'updating' | 'crashed';
  port: number; version: string | null; pid: number | null; exitCode: number | null;
  error: string | null; startedAt: number | null; dataDir: string }
```

Douane's row in Settings > Plugins shows it with Start, Stop and Restart, Open
Douane (its dashboard, beside the core only) and Move my connections to Douane,
which moves this machine's sign-ins into the plugin (`subscriptionProxy.move`
with `target: "plugin"`, [providers](providers.md#moving-connections-to-douane)).
Its uninstall confirmation says where the sign-ins stay.
`BOITE_DOUANE_BINARY=<path>` runs that executable for Douane instead of the
installed one; a `.ts` or `.js` path runs with the core's Bun, which is how the
tests' fake Douane starts.

## Install and run

A recommended plugin installs from its row. A plugin from a URL takes two
steps:

1. The owner pastes the repository URL and, optionally, a branch, tag or commit
   (the default branch otherwise), then clicks Preview. The core fetches
   that one commit and reads the manifest (`plugins.inspect`). The page shows
   the name, version, source commit, download URL, SHA-256, the command lines
   and the pools. Nothing is downloaded or run yet.
2. Install (`plugins.add`) installs exactly the manifest the preview showed, at
   the commit it showed. A push to the repository in between changes nothing.
   A preview is valid for ten minutes and is used once.

The download:

- is the artifact for the core's platform, over https, redirects included;
- takes at most 64 MB, and stops after 30 seconds without a byte or after 30
  minutes in all, so a slow link that keeps sending still finishes;
- shows its progress and can be cancelled.

The SHA-256 is checked before anything is written as the executable. The core
then records the install:

```
<dataDir>/plugins/seat-pool/
  seat-pool.exe        the executable (no extension off Windows)
  installed.json       what was installed, from where, when
  app.json             a desktop app only: whether it is on and starts with Boite, once changed
  gateway.json         a gateway only: whether it is on and starts with Boite, once changed
```

```json
{
  "schema": 1,
  "origin": "url",
  "source": {
    "url": "https://github.com/example/seat-pool",
    "ref": "v1.4.0",
    "commit": "3f9c2a7e5b1d4c6a8e0f2b4d6c8a0e2f4b6d8c0a"
  },
  "installedAt": 1789816835477,
  "manifest": { "schema": 1, "id": "seat-pool" }
}
```

`manifest` is the whole manifest as read; it is cut short above. A recommended
plugin records `"origin": "recommended"` and `"source": null`. Both files are
written under a `.part` name and renamed into place.

A first install that fails or is cancelled deletes the directory. An update that
fails keeps the version that worked.

Updating:

- A recommended plugin shows Update to X.Y.Z when a newer version is
  available: either Boite ships a newer entry, or the plugin's update source
  publishes a newer release (see [Updates from the source](#updates-from-the-source)).
  The newest of the two wins, and the version installed is never replaced by
  an older one. The row shows the download's progress, Cancel and any error.
- A URL plugin updates when the owner reads the same URL again at a newer ref;
  the preview names the version it replaces.
- An id already installed from another URL is refused, so one repository cannot
  take over another's install.
- Reinstall downloads again from the manifest recorded in `installed.json`,
  without fetching the repository.

### Updates from the source

A recommended entry may name an update source, so a plugin release reaches
installed copies without a Boite release:

```json
"updates": { "repository": "https://github.com/Skollheim/bots", "ref": "main" }
```

The field sits in Boite's reviewed list only. A plugin's own
`boite-plugin.json` refuses it like any unknown field, so a plugin cannot point
Boite anywhere else.

When the core checks:

- a minute after it starts, then every six hours, for the recommended plugins
  that are installed. A core whose owner never installed one sends nothing.
- when the owner clicks Check for updates on the plugin's row
  (`plugins.checkUpdates {id?}`), whether it is installed or not. A check
  finished less than ten seconds before answers instead of a new read.
- when the owner opens Settings > Plugins, for recommendations not installed
  yet. The list appears immediately and the available versions refresh as
  their sources answer. Their rows also offer Check for updates and show
  checking or failure notes before installation.
- when the owner installs or updates the plugin, before the download: a first
  install brings the release the source names, not a pinned entry several
  releases behind. A source that fails or takes more than 15 seconds leaves
  the newest version already known.
- A read that fails waits 15 minutes, then twice as long each time, up to six
  hours. The row shows the failure as a quiet note, never as an install error.

The core reads `boite-plugin.json` at the ref through the same git path,
limits and rules as `plugins.inspect`. It offers the manifest found only when:

- it passes every manifest rule: every artifact https, with a SHA-256;
- its `id`, `name`, `homepage`, `executable` and `provides` are those of the
  reviewed entry;
- its version is strictly newer, by semver, than both the entry and the
  version installed;
- it has an artifact for the core's platform.

Otherwise it is not offered, and the row says why under the plugin. A release
taken back at the source stops being offered at the next check. Installing
what was found is the owner's click. It takes the usual path: download, SHA-256
check, and a desktop app stopped before the binary is replaced and started
after. `installed.json` records the manifest that was installed, as for any
install, with no new field, so an older core still reads it.

`PluginState.updates` carries the source, whether a check is running, when the
last one finished and the next is due, the release on offer (version, commit,
time), and the reason a release was ignored or the check failed. Every change is
announced by `plugins.updated`. An older core sends no `updates` field, and the
UI then shows no check.

When a check finds a release, the owner's conversation view shows a notice in
its top right corner: « B.O.T.S 0.1.10 est disponible », with Plus tard and
Mettre à jour. It waits while Settings are open, where the Plugins page shows
the same update. It
shows once per version and machine: either answer holds until a newer version.
The answers are kept in the window's local storage. A paired device sees no
notice and cannot call `plugins.checkUpdates`.

Uninstall deletes `<dataDir>/plugins/<id>/`, which is everything an install
wrote. Whatever the program itself saved elsewhere, such as the logins in its
pools, stays where it put it. Say in your README where that is.

When `installed.json` cannot be read, the row reports the file and offers a
reinstall. When it reads but breaks a rule above, the row says the plugin was
refused, with the file, the field and the expected value, and offers only
Uninstall.

## Security model

Plugins run with the core user's permissions. Manifest validation and SHA-256
checks establish which bytes run; they do not sandbox the executable. The
preview states this before installation. Every `plugins.*` method is owner-only;
a paired device receives `plugins.list is for the owner only`.

Reading the repository:

- The URL must be https, with a host, no user or password, no query and no
  fragment.
- git runs through the core's process launcher, traced as `plugin:fetch:<n>`.
  It runs with `protocol.allow=never` and https as the one allowed transport,
  so `ext::`, `file://`, ssh and plain http are refused by git itself.
- Credential helpers and askpass are emptied and `GIT_TERMINAL_PROMPT=0` is
  set. A private or missing repository fails at once and never opens a
  sign-in.
- The core fetches the one commit with `--depth 1 --no-tags` into a
  temporary bare repository under `<dataDir>/plugins/` and reads
  `boite-plugin.json` out of it as a blob. There is no checkout, no hook, no
  submodule and no LFS, and the directory is deleted afterwards.
- Each git call has 60 seconds. git must be on the core's PATH.
- A ref is letters, digits, `.`, `_`, `/` and `-`, at most 200 characters. It
  must not start with `-`, contain `..`, or end with `/` or `.lock`.

Refused before anything installs:

- a missing `boite-plugin.json`, one over 64 KB, or one that is not valid JSON;
- any field outside the table above, or a value that breaks its rule;
- an http URL, or one carrying credentials, anywhere in the manifest;
- no artifact for the core's platform;
- the id of a recommended plugin;
- an id already installed from another URL;
- the id of a broken install, until the owner removes it;
- a download that redirects off https, is larger than 64 MB, or does not match
  its SHA-256;
- a plugin directory that is a symbolic link.

At run time Boite passes only the arguments above, checks the email is an
address, parses stdout only for `list`, and never shows a client the program's
output.

A desktop app holds the owner token. With it the app can do anything the owner
can: read every thread, start turns, change settings, install other plugins.
That is the price of a companion app that follows and drives your agents, and
why the preview says so before installation. It never receives an agent's
token or thread, so an agent cannot borrow the app's access, and an app is no
more trusted than any other executable you install: install one only from a
publisher you trust.

An update source moves part of that trust from the Boite review to the
plugin's repository. Whoever can push to its ref can offer new binaries, and
the SHA-256 then only proves the download is the one the manifest names. They
cannot:

- offer anything until the owner clicks Update;
- change the id, name, homepage, executable or features: a plugin that wants
  the owner token or an account pool it did not have needs a Boite pull
  request;
- send an older version, an http download or a download without a digest;
- point Boite at another repository, since the source sits in Boite's list.

A recommended entry should name a source only when its publisher guards that
ref like a release.

## Test a plugin locally

1. Build the release binaries and take their digests:
   `sha256sum seat-pool-linux-x64`, or in PowerShell
   `(Get-FileHash seat-pool-win32-x64.exe -Algorithm SHA256).Hash.ToLower()`.
2. Run the command lines by hand. `seat-pool list -opencode -Json` must print
   the JSON above and exit 0.
3. Publish the artifacts at https URLs, for example a pre-release, and push
   the manifest to a branch of a public repository.
4. Start a core on a throwaway data directory and the UI beside it:
   `bun run dev:core --data-dir <empty directory>` and `bun run dev:ui`.
   In Settings > Plugins, paste the repository URL and the branch name, read
   the manifest and install.

`add`, `switch` and `remove` act on the real CLI logins of the machine
whatever data directory the core uses. Try `list` first.

The core tests show a whole install without the network:

- `packages/core/test/plugins.test.ts` builds a repository with `git init`
  in a temporary directory.
- It sets `allowLocalSources` on the plugin store, which lets
  `plugins.inspect` read that repository by its path. It is a tests-only field
  no client can reach.
- It serves the artifact from a mocked `fetch`.

Run them from `packages/core`:

```sh
bun test test/plugins.test.ts test/plugin-manifest.test.ts test/plugin-updates.test.ts
```

`plugin-updates.test.ts` swaps the source read for a published manifest, and
its clock for one the test moves, to cover the checks, the backoff and every
refusal without waiting hours.

## Getting recommended

The recommended plugins are `packages/core/src/plugins/recommended.json`, an
array of manifests in the format above. Adding one is a pull request with one
entry:

- the artifact URLs pinned to a tagged release, not a moving `latest`;
- the SHA-256 of each artifact, which the reviewer checks against the download;
- a `homepage` where the source is public;
- optionally `updates`, the repository and ref where the plugin's
  `boite-plugin.json` describes its latest release. Name a branch only you can
  push to, and keep that manifest's id, name, homepage, executable and
  features as reviewed.

The core parses the list when it loads, and `plugin-manifest.test.ts` fails on
an entry the reader refuses. Once recommended, the id is reserved: nobody can
add a plugin with that id from a URL.

With an update source, a release is a push of the new `boite-plugin.json` to
that ref, after its artifacts are published. Installed copies find it within
six hours or at the owner's Check for updates. Without one, updating is the
same pull request with a new `version`, URLs and digests. A pinned entry newer
than what the source offers wins. Bump the entry now and then anyway: a fresh
install never reads the source by itself until the plugin is installed.
`BOITE_E2E_PLUGIN_INSTALL=1` runs the real download of Bots and its
uninstall in a temporary data directory ([development](development.md)).
