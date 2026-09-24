# Agent updates

This page covers agent executables. Updating Boite itself and selecting
boite de nuit are described in [Desktop updates](updates.md).

Boite keeps the agents of a machine current. The core of that machine does the
work: it reads each agent's version, reads the newest one, and runs the update.
A client only shows what the core found and sends Update or Skip back.

An agent with an updater and no way to name its newest release, the Antigravity
CLI being one, announces nothing: its row reads `Checks by itself` and carries
`Run its updater`, which runs the updater on request and reads the version again.
The automatic switch leaves it alone, such an agent updates itself.

## What the user sees

A newer version is a notice pinned under the title bar, top right. It carries
the agent, the new version, the installed one, and two buttons. It does not
time out. It leaves on Update, on Skip, or when the core reports the agent
current. Three notices show at most; a phone shows one at a time and only on
the conversation screen.

- Update releases the provider's warm processes and runs the update in the
  background: the notice leaves at once. The threads stay; the next turn starts
  the new version. Settings, Providers shows the agent as updating meanwhile.
- Skip stops offering that version. A later version is offered again.
  Settings, Providers, Agent updates lists every agent with its versions and
  offers a skipped version again.
- A failed update brings its notice back with the updater's last line and Try
  again.

`Update agents automatically` in the same card makes the core update by
itself. It is off by default.

## Two routes

| Route | Applies to | Installed version | Newest version | Update |
| --- | --- | --- | --- | --- |
| `managed` | a release Boite downloaded into its agents directory | the release record | the version the shipped descriptor pins | `providers.install`, checksum included |
| `self` | the user's own install, found on PATH or at a known path | the agent's `--version` | the npm `latest` tag, or the agent's own check | the agent's own updater |

A managed release only moves with a Boite release, because its URL and SHA-256
are pinned in the descriptor. The self route never downloads anything itself:
it runs the program the user installed with the arguments its descriptor names.

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

`latestNpm` and `latestArgs` exclude each other. With neither, the installed
version is listed, no update is announced and `Run its updater` stays on the
row. Claude, Codex, OpenCode, Grok and pi ship with a block that names its
newest release. The Antigravity CLI ships with its updater alone, having no
newest release Boite can read. Muse Code has no updater, so it is not listed.

Every run of an agent goes through the process registry under the synthetic
thread `update:<provider id>`, so it is traced and capped like any other agent
process. A version read has 20 seconds, an update 15 minutes.

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
- An updater that exits with zero and leaves the version unchanged is reported
  as failed, with the version it still reports.
- Skips live in `<dataDir>/harness-updates.json`. An unreadable file skips
  nothing and says so in the core log.
- The methods are owner-only. A paired phone neither sees nor starts an update.

## Remote machines

Each core owns its agents, so a client connected to several machines gets one
list per machine and sends Update to the machine that owns the agent. The
notice names the machine when more than one is connected.

A server with no window needs no client at all: with
`autoUpdateHarnesses` on, its core checks a minute after start and every six
hours, and updates each agent whose newest release it can read once none of
its turns is in flight. Turn it on
from Settings, Providers while that machine is the selected one. On Linux and
macOS the shipped agents have no managed release, so they update through the
self route, as the user the core runs as: an agent installed system-wide by
root fails with its updater's own permission error, which the notice shows.

A core older than this feature answers `MethodNotFound` to `providers.updates`.
The client treats that machine as having no updates and shows no error.

## RPC

- `providers.updates { refresh? }`: the list. The first call reads, later calls
  answer from memory unless `refresh` is true.
- `providers.update { providerId }`: start one update.
- `providers.updateSkip { providerId, version }`: skip a version, `null`
  forgets the skip.
- `providers.updatesChanged`: the whole list, after each check, update or skip.

Tests: `packages/core/test/updates.test.ts` runs a fixture agent with a real
updater; `tests/e2e/harness-updates.test.ts` captures the notices and the
settings card at desktop and phone widths on the fake client
(`?fake=1&updates=1`).
