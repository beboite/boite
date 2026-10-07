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

Settings, Machines and updates lists each machine's agents under that
machine's details, with their installed and available versions, Update and
Skip. A machine with a release waiting for one of its agents says Update
available on its row before the details are opened; a skipped release does
not. Updates create no pinned chat notice.

- Update releases the provider's warm processes and runs the update in the
  background. The row shows progress, or how many tool calls the update still
  waits for while turns of that agent run ([Turns in flight](#turns-in-flight));
  the next turn starts the new version.
- Skip stops offering that version. A later version is offered again.
  The same row in Machines and updates offers a skipped version again.
- A failed update keeps the updater's error and Try
  again. Standard error takes priority over progress on standard output; an
  explicit error takes priority over npm's final log-file location.
- When the agent that runs is the user's own install (the `self` route), its
  update row offers no Update for a copy Boite downloaded earlier: that copy
  is not what runs, and the version shown is the one the update reads.

`Automatic updates` under each machine's agents makes that core update by
itself, pausing running turns the same way. It is off by default. `Check for updates` reads its versions again.
Providers keeps sign-ins and installation controls and names no version: an
agent's version is on its machine's card and nowhere else.

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
`<dataDir>/harness-versions.json`, so a restart shows the last reading without
running any agent. At start the core reads each managed agent
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
offer at once, without waiting for the next check.

## Turns in flight

An update asked for while turns of that agent run does not refuse them and
does not cut them. Each running turn goes on until its tool calls end: at the
first moment no tool of the turn runs and no permission card or blocking
question waits for the user, the core stops the agent's run. The turn itself
stays open, and the thread shows `Paused while <agent> updates`. A turn that
starts meanwhile pauses at its own first tool boundary; a turn that ends
without one simply finishes. The updater starts once no turn of the agent runs
unpaused, and the provider's warm processes, the paused turns' included, are
released first.

When the updater is done, each paused turn goes on in the same turn and the
same native session: the core sends the agent a note that it was paused
between two tool calls for the update, and the thread shows
`Resumed after the <agent> <version> update`, or `Resumed: the <agent> update
failed` when it failed. An agent with no session to resume gets the thread's
history, this turn's work included. The turn finishes once, so a delegated
agent reports to its parent, a workflow step completes and a notification goes
out only for the real end. Prompts sent while the updater runs are accepted and
wait in the queue; they start on the new version.

A paused turn waits at most 15 minutes for the agent's other turns to reach
their own pause. Past that, the paused turns go on with `Resumed: the <agent>
update waits for other turns`, no turn is paused again, and the update runs at
the first moment no turn of the agent runs. This covers a turn whose tool call
waits on another turn of the same agent, such as `boite agents send --wait`,
which would otherwise never let the update start.

Stop during a pause ends the turn as stopped and the update goes on. A core
that restarts during a pause hands the turn over ([Restarts](#restarts)). Work
the agent left running in the background, such as a background shell, ends
with its process when the update releases it.

## Restarts

This is the same rule a Boite restart follows: the [restart handoff](restart-handoff.md)
also stops a turn between two tool calls and resumes it afterwards. The
handoff gives a running tool call 30 seconds, since the core must exit; an
agent update has no such deadline and waits for the tool call to end. A Boite
restart during a pause stops the paused turn, which the handoff then resumes
on the next core like any turn it cut.

## Rules

- An update asked for while a turn of that provider runs pauses that turn as
  described above. The accepted turn's provider counts after the picker selects
  another account. Closing the core cancels update processes, stops the paused
  turns and prevents an updater waiting on a version check from
  starting later.
- A turn sent while its provider's updater runs waits in the queue, and an
  update asked for during a version check starts once that check has landed.
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
the owning core ([machines](machines.md)). Each agent row stays under its own
machine's card, including when provider IDs match on different machines.

With `autoUpdateHarnesses` enabled, a headless core checks ten minutes after
startup and every six hours, postponing checks while work is active, and
updates an agent by pausing its turns in flight between two tool calls. Enable it
under that machine's agents in Settings, Machines and updates. Providers
without a managed release use the self route as the core user. An unwritable
npm prefix fails before the
updater starts and names the directory; other updater permission failures
appear on the update row.

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
copy selected. A remote core owns these installations even when its update
controls are displayed by a desktop client.

A core older than this feature answers `MethodNotFound` to `providers.updates`.
The client treats that machine as having no updates and shows no error.

## RPC

- `providers.updates { refresh? }`: the list, answered from the last reading
  without running any agent. `refresh: true` reads every agent first. On a core
  with no reading yet the list is empty; Settings, Machines and updates asks
  for a refresh
  when it opens on an empty list.
- `providers.update { providerId }`: start one update. While turns of the
  agent still run a tool call, its entry is `updating` with `waitingFor` set
  to their number.
- `providers.updateSkip { providerId, version }`: skip a version, `null`
  forgets the skip.
- `providers.updatesChanged`: the whole list, after each check, update or skip.

Tests: `packages/core/test/updates.test.ts` runs a fixture agent with a real
updater, and turns on the echo driver for pauses (`[tool:<ms>]` is a tool call
that runs that long); `tests/e2e/agent-update-pause.test.ts` captures a paused
and a resumed turn on a real core; `tests/e2e/harness-updates.test.ts` checks machine ownership and captures
the update controls at desktop and phone widths on the fake client
(`?fake=1&updates=1`).
