# Agent updates

This page covers agent executables. Updating Boite itself and selecting
Boite Nightly are described in [Desktop updates](updates.md).

Each core checks and updates the agent executables on its own machine. Clients
show those readings and send Update or Skip to that core.

An agent with an updater but no readable latest-version source, such as the
Antigravity CLI, shows Checks by itself and Run its updater. A successful run
records its resulting version as current until the next check. If a newer
version was known but the installed version stays unchanged, or the command
fails, the row retains its update action and error. Automatic updates exclude
agents without a readable latest version.

## What the user sees

A newer version is a notice pinned under the title bar, top right. It carries
the agent, the new version, the installed one, and two buttons. It does not
time out. It leaves on Update, on Skip, or when the core reports the agent
current. Three notices show at most; a phone shows one at a time and only on
the conversation screen, below the conversation's header row so its title and
buttons stay in reach.

- Update releases the provider's warm processes and runs the update in the
  background: the notice leaves at once. The threads stay; the next turn starts
  the new version. Settings, Providers shows the agent as updating meanwhile.
- Skip stops offering that version. A later version is offered again.
  In Settings, Providers, each provider's row shows its agent's version, the
  newer one when there is one, and offers a skipped version again.
- A failed update brings its notice back with the updater's error and Try
  again. Standard error takes priority over progress on standard output; an
  explicit error takes priority over npm's final log-file location.
- When the agent that runs is the user's own install (the `self` route), its
  provider row offers no Update for a copy Boite downloaded earlier: that copy
  is not what runs, and the version shown is the one the update reads.

`Automatic updates` at the top of Settings, Providers makes the core update by
itself. It is off by default. `Check for updates` beside it reads every
version again.

## Two routes

| Route | Applies to | Installed version | Newest version | Update |
| --- | --- | --- | --- | --- |
| `managed` | a release Boite downloaded into its agents directory | the release record | the version the shipped descriptor pins | `providers.install`, checksum included |
| `self` | the user's own install, found on PATH or at a known path | the agent's `--version` | the npm `latest` tag, or the agent's own check | the agent's own updater |

A managed release only moves with a Boite release, because its URL and SHA-256
are pinned in the descriptor. The self route invokes the installed program with
its descriptor's updater arguments; the program owns the download.

A profile opts in with an `update` block:

```json
"update": { "args": ["update"], "latestNpm": "@openai/codex" }
```

- `args`: the updater's arguments, required.
- `versionArgs`: arguments that print the version, `--version` by default. The
  first `x.y.z` in the output is read.
- `latestNpm`: an npm package whose `latest` tag names the newest release.
- `latestArgs`: arguments that print JSON carrying `latestVersion`, for an
  agent that checks by itself. Grok uses `update --check --json`.

An executable candidate can carry `updateEnv`, set only when the updater runs
from that candidate. It stands in for a launcher Boite skips: Codex's npm
package starts its binary through a Node script that sets
`CODEX_MANAGED_BY_NPM`, and `codex update` refuses with `Could not detect the
Codex installation method` without it. The Windows descriptor runs that binary
directly, so its two npm candidates set the variable themselves.

An agent installed by npm on Linux or macOS updates through `npm install -g`,
which writes under npm's configured prefix. That prefix is not always the one
holding the copy Boite runs: Codex under `/opt/boite` with a system npm whose
prefix is `/usr` would install a second copy in `/usr/lib/node_modules` and
leave the old one first on PATH. When the program resolves into
`<prefix>/lib/node_modules`, the core runs its updater with `npm_config_prefix`
set to that prefix. Before it runs, the core checks that its user can write the
package's parent directory and `<prefix>/bin`. When it cannot, the update fails
at once with the prefix and the directory it cannot write, without running the
updater.

`latestNpm` and `latestArgs` exclude each other. With neither, the installed
version is listed, no update is announced and `Run its updater` stays on the
row. Claude, Codex, OpenCode, Grok and pi ship with a block that names its
newest release. The Antigravity CLI ships with its updater alone, having no
newest release Boite can read. Muse Code has no updater, so it is not listed.

Every run of an agent goes through the process registry under the synthetic
thread `update:<provider id>`, so it is traced and capped like any other agent
process. A version read has 20 seconds, an agent's own updater 15 minutes. At
the limit the registry stops the run with Windows Job Objects or POSIX process
groups ([trace](trace.md#platform-boundary)). A descendant that leaves its
POSIX group can survive. Output draining ends two seconds later even if a
descendant still holds the pipe. Only the last 256 KB of each stream is kept.

A check reads two agents at a time. Its readings land in
`<dataDir>/harness-versions.json`, so a restart shows the last reading and its
notices without running any agent. At start the core reads each managed agent
again, which spawns nothing, so a Boite build that pins a newer release offers
it at once; a kept row whose agent is gone, changed route or now resolves to
another program is dropped. An agent that updates itself keeps its kept reading until
the next check. The first automatic check comes ten minutes after start, or six
hours after the kept reading when that is later, unless a row was dropped
because its program moved, which brings the check back to ten minutes, and waits
ten more minutes while any turn is queued, running or waiting. A check started
from the card counts: the timer does not read again within six hours of it.

A managed update has no time limit: it waits for its download, which retries a
dropped connection by itself and fails once the retries run out
([providers](providers.md#managed-installs)). Update pressed while the install
card is already downloading that release joins that download instead of
failing. A download cancelled from the install card fails the update with
`the download was cancelled`, and a release the install card lands clears the
notice at once, without waiting for the next check.

## Rules

- An update is refused while a turn of that provider is queued, running or
  waiting. The automatic update waits and looks again ten minutes later.
  The accepted turn's provider still counts after the picker selects another
  account. Closing the core cancels update processes and prevents an updater
  waiting on a version check from starting later.
- A turn is refused while its provider is updating, and an update asked for
  during a version check starts once that check has landed.
- Versions compare by their numbers; a pre-release is older than its release.
  The self route offers only a newer version. The managed route offers whatever
  the descriptor pins, since a Boite release may pin an older, working one.
- An updater that exits with zero and leaves the version unchanged while a
  newer release is known is reported as failed, with the version it still
  reports and the last line of its output that names a failure or a skip.
  `opencode upgrade` exits with zero on every failure, so that line is the
  only reason it gives. With no newer release known, the same run reads
  `Up to date`.
- Skips live in `<dataDir>/harness-updates.json`. An unreadable file skips
  nothing and says so in the core log.
- The methods are owner-only. A paired phone neither sees nor starts an update.

## Remote machines

A multi-machine client keeps separate update lists and routes each action to
the owning core ([machines](machines.md)). Notices name the machine when more
than one is connected.

With `autoUpdateHarnesses` enabled, a headless core checks ten minutes after
startup and every six hours, postponing checks while work is active. Enable it
in Settings, Providers on that machine. Providers without a managed release
use the self route as the core user. An unwritable npm prefix fails before the
updater starts and names the directory; other updater permission failures
appear in the notice.

To fix that, install the agent under the core user's own prefix. Run these
commands as that user, then place `$HOME/.local/bin` before the system agent directory in the core service's
`PATH`:

```sh
npm config set prefix "$HOME/.local" --location=user
npm install -g @anthropic-ai/claude-code @openai/codex
"$HOME/.local/bin/claude" --version
"$HOME/.local/bin/codex" --version
```

Restart the core after its active turns finish. The reading kept from the old
copy is dropped, since the program moved, and the check runs ten minutes after
start; `Check for updates` reads at once.
Installing a second copy without changing the service's `PATH` leaves the old
copy selected. A remote core owns these installations even when the notice is
displayed by a desktop client.

A core older than this feature answers `MethodNotFound` to `providers.updates`.
The client treats that machine as having no updates and shows no error.

## RPC

- `providers.updates { refresh? }`: the list, answered from the last reading
  without running any agent. `refresh: true` reads every agent first. On a core
  with no reading yet the list is empty; Settings, Providers asks for a refresh
  when it opens on an empty list.
- `providers.update { providerId }`: start one update.
- `providers.updateSkip { providerId, version }`: skip a version, `null`
  forgets the skip.
- `providers.updatesChanged`: the whole list, after each check, update or skip.

Tests: `packages/core/test/updates.test.ts` runs a fixture agent with a real
updater; `tests/e2e/harness-updates.test.ts` captures the notices and the
settings card at desktop and phone widths on the fake client
(`?fake=1&updates=1`).
