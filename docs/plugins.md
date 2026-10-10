# Plugins

A plugin is one native executable. Boite downloads it over https, checks it
against the SHA-256 its manifest publishes, and runs it for the features the
manifest names. There are two features today: account pools, which save and
switch the default login of an agent CLI, and desktop apps, which Boite starts
beside itself with the owner's access ([Desktop apps](#desktop-apps)).

Settings > Plugins has three sections:

- Installed: every plugin on this core, with its version, the commit it came
  from, its pools and its errors.
- Recommended: the plugins Boite ships a manifest for and that are not
  installed yet. Today that is
  [kebacc-switcher](https://github.com/kebab1337420/kebacc-switch).
- Add from a git URL: any repository with a `boite-plugin.json` at its root.

Plugins are administration of the machine that hosts the core, so every
`plugins.*` method is owner only and the phone settings leave the page to the
desktop app ([phone](phone.md)).

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
| `provides` | An object naming at least one feature, among `accountPools` and `desktopApp`. `accountPools` is `{ "providers": [...] }`: a non-empty list of distinct provider ids among `antigravity`, `antigravity-cli`, `claude`, `codex`, `grok`, `muse`, `opencode` and `pi`. `desktopApp` is `{}`, an object with no field ([Desktop apps](#desktop-apps)). A plugin may provide both. |

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
such as [Bots](https://github.com/beboite/bots). Boite starts it and keeps it
running; the app then talks to the core like any client.

```json
{
  "schema": 1,
  "id": "bots",
  "name": "Bots",
  "version": "0.1.0",
  "description": "Little robots on your desktop, one for each agent at work.",
  "homepage": "https://github.com/beboite/bots",
  "executable": "bots",
  "artifacts": {
    "win32-x64": { "url": "https://github.com/beboite/bots/releases/download/v0.1.0/bots.exe", "sha256": "…" }
  },
  "provides": { "desktopApp": {} }
}
```

`desktopApp` takes no field; any key in it is refused. The artifact is the
app's single release executable.

The core starts an installed, enabled app:

- when the core starts;
- right after its install or an update finishes;
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
browser's host.

Exits and stops:

- An exit with code 0 leaves the app stopped. It starts again on the next core
  start or when the owner starts it.
- Any other exit, or a signal, starts it again after 2 seconds, then 10, then
  30. A fourth crash within five minutes leaves it crashed, with the exit code
  and a message on its row, until the owner starts it.
- Stop kills the app's process tree and turns it off: it does not start with
  the core again until the owner starts it. Start and Restart turn it back on.
- Uninstall kills it first. An update kills it before the new executable
  replaces the old one, and starts the new one after.
- Core shutdown kills it.

Whether the app is on is kept in `<dataDir>/plugins/<id>/app.json`, across core
restarts and updates. A first install turns it on.

A Linux core with neither `DISPLAY` nor `WAYLAND_DISPLAY` set has no desktop to
show a window on: it does not start the app, and the row says so.

The plugin's row shows the app's state (running, starting again, stopped,
crashed with its exit code, or unavailable with the reason) with Start, Stop
and Restart. `plugins.app` answers with the plugin's state, and every change is
announced by `plugins.updated`. The state is `PluginState.app`:

```ts
{ enabled: boolean; status: 'stopped' | 'starting' | 'running' | 'crashed' | 'unavailable';
  pid: number | null; exitCode: number | null; error: string | null; startedAt: number | null }
```

### Showing Boite

An app that wants the owner to look at something calls
`ui.reveal {target}`, where `target` is `{ "kind": "thread", "threadId": "…" }`
or `{ "kind": "agent", "agentId": "…" }`. A thread must exist on the core. The
core sends the `ui.reveal` event to every owner connection and answers
`{delivered}`, the number of connections it reached.

The desktop shell connected to the core it started on the same computer
answers it: it unminimizes and focuses its window, then opens the thread, or the
Agents page on that agent (switching the Resident agents experiment on if it was
off). Browser tabs, paired devices and windows following another machine do
nothing.

`ui.reveal` is owner-only, as is the event: a paired device or an agent that
calls it is refused, and neither receives it.

## Install and run

A recommended plugin installs from its row. A plugin from a URL takes two
steps:

1. The owner pastes the repository URL and, optionally, a branch, tag or commit
   (the default branch otherwise), then clicks Read manifest. The core fetches
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
  app.json             a desktop app only: whether it is on, once changed
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

- A recommended plugin shows Update when Boite ships a newer version of its
  manifest.
- A URL plugin updates when the owner reads the same URL again at a newer ref;
  the preview names the version it replaces.
- An id already installed from another URL is refused, so one repository cannot
  take over another's install.
- Reinstall downloads again from the manifest recorded in `installed.json`,
  without fetching the repository.

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
bun test test/plugins.test.ts test/plugin-manifest.test.ts
```

## Getting recommended

The recommended plugins are `packages/core/src/plugins/recommended.json`, an
array of manifests in the format above. Adding one is a pull request with one
entry:

- the artifact URLs pinned to a tagged release, not a moving `latest`;
- the SHA-256 of each artifact, which the reviewer checks against the download;
- a `homepage` where the source is public.

The core parses the list when it loads, and `plugin-manifest.test.ts` fails on
an entry the reader refuses. Once recommended, the id is reserved: nobody can
add a plugin with that id from a URL.

Updating a recommended plugin is the same pull request with a new `version`,
URLs and digests. Installed copies then show Update.
`BOITE_E2E_KEBACC_INSTALL=1` runs the real download of kebacc-switcher and its
uninstall in a temporary data directory ([development](development.md)).
