# Agent updates

This page covers agent executables. Updating Boite itself and selecting
Boite Nightly are described in [Desktop updates](updates.md).

Each core checks and updates the agent executables on its own machine. Clients
show those readings and send Update or Skip to that core.

An agent with an updater but no readable latest-version source shows Checks by
itself and Run its updater. A successful run
records its resulting version as current until the next check. If a newer
version was known but the installed version stays unchanged, or the command
fails, the row retains its update action and error. Automatic updates exclude
agents without a readable latest version.

## What the user sees

Each machine's Providers page (the machine picked above the page) lists its
agents with their installed and available versions, Update and Skip. A machine
with a release waiting for one of its agents says Update available on its row
in Settings, Machines and updates, whose updates card lists that release; a
skipped release does not. Updates create no pinned chat notice: the sidebar's update button and
its card list them with the rest, and Update all starts every agent of every
machine at once ([update everything](updates.md#update-everything)).

- Update releases the provider's warm processes and runs the update in the
  background. The row shows progress, or how many running threads of that
  agent the update still waits for to pause ([Turns in flight](#turns-in-flight));
  the next turn starts the new version.
- Skip stops offering that version. A later version is offered again.
  The same row on Providers offers a skipped version again.
- A failed update keeps the updater's error and Try
  again. Standard error takes priority over progress on standard output; an
  explicit error takes priority over npm's final log-file location. OpenCode's
  installation-method error takes priority over its closing `Failed` line.
- When the agent that runs is the user's own install (the `self` route), its
  update row offers no Update for a copy Boite downloaded earlier: that copy
  is not what runs, and the version shown is the one the update reads.

`Automatic updates` under each machine's agents makes that core update by
itself, pausing running turns the same way and also waiting for the work
agents left running in the background ([Background work](#background-work)).
It is off by default. `Check for updates` reads its versions again.
A provider's own row keeps its sign-ins and installation controls and names no
version: the agent's version, Update and Skip sit in the Agent updates card
lower on the same Providers page.

## Two routes

| Route | Applies to | Installed version | Newest version | Update |
| --- | --- | --- | --- | --- |
| `managed` | a release Boite downloaded into its agents directory | the release record | the version the shipped descriptor pins, or the one its publisher names | `providers.install`, checksum included |
| `self` | the user's own install, found on PATH or at a known path | the agent's `--version` | the npm `latest` tag, or the agent's own check | `npm install -g` for a global npm install of the `latestNpm` package, else the agent's own updater |

A managed release only moves with a Boite release, because its URL and SHA-256
are pinned in the descriptor, unless its install block names a publisher
(`latest`, [providers](providers.md#managed-installs)). Claude on Windows does:
each check reads Anthropic's release bucket, and the update downloads the
release it names with the digest from its manifest. The old binary is never
run to update itself, so a crash of an old release's own updater cannot stop
it. Such a release only moves forward: after a restart, before the publisher is
read again, the pin may be older than what is on disk, and it is not offered.
The self route invokes the installed program with its descriptor's updater
arguments; the program owns the download. The exception is a global npm
install of the very package `latestNpm` names: Boite already read the version
from the registry, so it runs npm's own CLI with Node,
`npm install -g --allow-scripts=<package> <package>@<version>`, and never asks
the agent to look the version up again. npm 12 skips install scripts unless
they are allowed, and Claude's script puts its native binary in place. `claude update` gives its own `npm view` five seconds; a cold
npm on a slow laptop took longer, and every first update there failed while the
second passed (2026-10-15).

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
directly, so its two npm candidates set the variable themselves. On Linux and
macOS sessions and probes run the binary directly when PATH reaches the
launcher itself, but the updater still runs the launcher: it names the package
manager that owns the install (npm, Bun, pnpm or Vite+) and the package root,
which a fixed variable cannot.

An agent installed by npm updates through `npm install -g`, which writes under
npm's configured prefix. That prefix is not always the one holding the copy
Boite runs: Codex under `/opt/boite` with a system npm whose prefix is `/usr`
would install a second copy in `/usr/lib/node_modules` and leave the old one
first on PATH. When the program resolves into `<prefix>/lib/node_modules`, or on
Windows into `<prefix>\node_modules` with npm's `.cmd` shim for one of the
package's commands in `<prefix>`, the core runs npm or the agent's updater with
`npm_config_prefix` set to that prefix. Before it runs, the core checks that its
user can write the package's parent directory and `<prefix>/bin` (`<prefix>` on
Windows). When it cannot, the update fails at once with the prefix and the
directory it cannot write, without running anything.

When a separate npm prefix keeps two agent versions side by side, a PATH alias
must be a symbolic link to its package executable. A hard link hides the npm
path and stays on the old file when npm replaces it. With a symbolic link,
Boite can identify the package and update its own prefix directly, including on
Windows, without asking the agent to guess its installation method.

An agent a Termux package installed updates through Termux's apt. Termux builds
its own `codex` package, and `codex update` refuses that copy with `Could not
detect the Codex installation method`. When the program sits under a prefix
holding its own dpkg database and `bin/apt-get`, the system's `/` excluded, and
a `var/lib/dpkg/info/*.list` of that prefix names it, the core reads and updates
it through apt whatever the descriptor's `update` block says:

- Newest release: `apt-get update`, then the `Candidate` of `apt-cache policy
  <package>`, epoch and Debian revision removed. The Termux repository can
  trail the npm `latest` tag by a few days, and only its release is offered.
  `apt-get update` exits with zero when a mirror cannot be reached and keeps
  the old index, so its `W: Failed to fetch` or `E:` line fails the check.
- Update: the index is fetched again, then `apt-get install --only-upgrade -y
  <package>` keeps changed configuration files and upgrades nothing else.

`latestNpm` and `latestArgs` exclude each other. With neither, the installed
version is listed, no update is announced and `Run its updater` stays on the
row. Claude, Codex, OpenCode, Grok and pi ship with a block that names its
newest release. Muse Code has no updater, so it is not listed.

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
An owner client also checks when it connects or its window is shown again and
the newest reading is more than 15 minutes old, unless a row is checking,
updating or shows a failure.

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
`Resumed after the <agent> <version> update`, `Resumed after the <agent>
update` when the version did not move, or `Resumed: the <agent> update failed`
when it failed. `Resumed: the <agent> update no longer waits` is the guard for
an update that ended before the pause registered; a pause asked for by an
update that is gone is dropped before it stops the agent. An agent with no session to resume gets the thread's
history, this turn's work included. The turn finishes once, so a delegated
agent reports to its parent, a workflow step completes and a notification goes
out only for the real end. Prompts sent while the updater runs are accepted and
wait in the queue; they start on the new version.

The first pause starts a 15 minute limit for the agent's other turns to reach
their own pause. Before any turn has paused, the update waits for the current
tool calls with no deadline. Past the limit, the paused turns go on with
`Resumed: the <agent> update waits for other turns`, no turn is paused again,
and the update runs at the first moment no turn of the agent runs. This covers a turn whose tool call
waits on another turn of the same agent, such as `boite threads send --wait`,
which would otherwise never let the update start.

Stop during a pause ends the turn as stopped and the update goes on. A core
that restarts during a pause hands the turn over ([Restarts](#restarts)).

## Background work

A turn may end on a checkpoint while work its agent started in the background
goes on: a CI loop under `run_in_background`, a dev server, a monitor. That
work lives in the agent's process, so releasing the agent for an update ends
it. On 2026-10-19 an automatic Claude update released four delegated agents
waiting on their CI loops; each parent only learned it from an interruption
notice.

An automatic update counts such an agent like a running turn. While one of
its agents at rest still runs background work, the update waits and pauses
no turn: turns start and end as usual. Once that work ends, the update goes
on as in [Turns in flight](#turns-in-flight). Work an agent starts later, a
turn woken by its own background task included, holds the update the same
way, and so does the background work of a turn paused for the update. The
row's waiting count includes these agents.

The wait is bounded: two hours after the update was asked, background work
stops holding it. A background task lives two hours at most, so only work
started after the update was asked is cut. An update asked by hand (Update,
Update all) does not wait for background work and goes on at once; asked
while an automatic update waits, it makes that one go on.

Either way, an agent whose background work the release ended is picked up
again on the new version. The resume is planned as the release ends the
work, not when the updater is done, and its turn waits in the queue for the
updater: a Stop meanwhile cancels it like any queued turn or planned resume,
and a crash of the core keeps it. The thread shows `Background work ended by
the <agent> update`, and the agent is told which work ended. A delegated
agent gets the continuation `boite delegate resume` sends, unless its owner
paused the team; its parent still hears the interruption. A conversation of
the user's own resumes like background work that ended without waking it
([auto-continue](restart-handoff.md#turns-that-stop-before-their-answer)). A
turn paused for the update reads it in its resume note. A bot's
thread resumes like a conversation of the user's.

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
- An automatic update also waits, two hours at most, for the background work
  of the provider's agents at rest; an update asked by hand does not. Either
  way the agents whose work the release ended are resumed after it
  ([Background work](#background-work)).
- A turn sent while its provider's updater runs waits in the queue, and an
  update asked for during a version check starts once that check has landed.
- Versions compare by their numbers; a pre-release is older than its release.
  The self route offers only a newer version. The managed route offers whatever
  the descriptor pins, since a Boite release may pin an older, working one; a
  release that follows its publisher offers only a newer one.
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
the owning core ([machines](machines.md)). The Agent updates card shows the
agents of the machine picked above the Providers page, including when provider
IDs match on different machines.

With `autoUpdateHarnesses` enabled, a headless core checks ten minutes after
startup and every six hours, postponing checks while work is active, and
updates an agent by pausing its turns in flight between two tool calls. Enable it
on that machine's Providers page, under its agents. Providers
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
  with no reading yet the list is empty; the Providers page asks for a refresh
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
