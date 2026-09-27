# Agent hooks

A hook is a command or a plugin an agent runs around its own events: before a
tool call, when a prompt is submitted, when a turn ends. Hooks belong to the
agent. Boite never runs one itself; it makes sure the agent finds the user's
hooks on every account, and says what they did. The code is
`packages/core/src/hooks.ts` for the ledger, `profile-share.ts` for isolated
accounts, and the Claude and Codex drivers for the reports.

## Where each agent keeps them

| Agent | Hooks | Format | Per-run report |
|---|---|---|---|
| Claude | `hooks` in `settings.json` under `CLAUDE_CONFIG_DIR`, plus plugin hooks | events | yes |
| Codex | `hooks.json` under `CODEX_HOME`, each hook trusted in `config.toml` | events | yes |
| Grok | `hooks/*.json` under `GROK_HOME`, and Claude's `~/.claude/settings.json` | events | no |
| pi | extensions under `PI_CODING_AGENT_DIR/extensions` | modules | no |
| OpenCode | plugins under `XDG_CONFIG_HOME/opencode/plugins` | modules | no |

The descriptor's `hookSources` names these places
([providers.md](providers.md#hooks-and-shared-configuration)), and Settings reads
them to count what is configured. An `events` source is a JSON file, or a
directory of them, shaped `{ "hooks": { "<Event>": [{ "matcher": "...",
"hooks": [...] }] } }`; each inner entry counts as one hook. A `modules` source
is a directory of scripts, where each `.js`, `.ts`, `.mjs` or `.cjs` file and
each package directory counts as one.

## Isolated accounts

An isolated account moves the agent's whole configuration directory into
`<dataDir>/accounts/<id>/`. Before this change that left the user's hooks,
settings, skills and instructions behind: a second Claude seat ran with no hooks
at all. The descriptor's `shared` block now names what an isolated account takes
from the user's own directory, at every spawn. Directories are linked, files are
copied, and a login file is never shared
([accounts.md](accounts.md#what-an-isolated-account-shares)).

Codex keeps the trust of each hook in `config.toml`, keyed by the absolute path
of `hooks.json`. The copy of `config.toml` an account gets has that path
rewritten to the account's own `hooks.json`, so a hook the user reviewed stays
reviewed there. A hook reviewed nowhere yet has to be reviewed in Codex, on the
user's own login; the next spawn copies the new trust to every account.

## What Boite reports

Claude runs with the SDK's `includeHookEvents`, which sends a `hook_response`
message after each hook. Exit code 2 reads as `blocked`; any other failure or
a cancellation reads as `failed`. A hook that exits 0 can still
decide: `continue: false` reads as `stopped`, and `decision: "block"` or a
`permissionDecision` of `deny` read as `blocked`. The reason comes from that
decision, else from stderr.

Codex sends `hook/completed` with the run's status (`completed`, `failed`,
`blocked`, `stopped`) and the hook's own feedback lines. When its process starts,
Boite also asks `hooks/list`: an enabled hook Codex skips because nobody
reviewed it, or because it changed since, counts as `skipped`, once per account
and event.

Grok, pi and OpenCode run their hooks, but their protocols say nothing about a
run. Settings shows their sources and whether each isolated account has them,
and says there is no report.

## Where it shows

In a thread, only a hook that ended the turn shows: a prompt a
`UserPromptSubmit` hook refused, or a turn a hook stopped. It is one quiet line
with the event and the reason, where the reply would have been. Without it a
blocked prompt read as an empty reply.

Everything else goes to Settings > Brain > Hooks, a card that shows with or
without a brain folder. Each agent that runs hooks has one row: what it found
("13 hooks", "2 modules") and, for Claude and Codex, the counts since the core
started (runs, blocked, failed, skipped). Opening the row lists each source
path. A source Boite cannot read, or a path an isolated account did not get,
shows under the row without opening it. Below the rows, the most recent runs
that did not pass, newest first, each with its agent, event, hook and reason:
five open, the rest of the last 50 folded.

`hooks.status` returns that view and `hooks.changed` tells the clients a run was
recorded. Reading it lays out each isolated account's share again, the way a
spawn does, so the problems it lists are the ones the next turn would meet. Both are owner-only: a hook's reason can quote a path or a command.
The ledger lives in memory and starts again with the core; a run that passed
only adds to its count.

## The models probe

The Claude probe sets `settings.disableAllHooks`, so listing models fires no
`SessionStart` hook. Before, every probe ran the user's session hooks as if a
conversation had started.

## Limits

- A shared file goes to every account whole. An API key the user put in the
  `env` block of `~/.claude/settings.json`, or in a provider block of a shared
  `config.toml`, applies to every account of that agent, the same way it applies
  to their own CLI.
- Grok, pi and OpenCode hooks run on every account but leave no trace in Boite.
- A hook blocking a tool call does not end the turn, so it shows in Settings
  only; the agent's own reply usually says it was refused.
- A test core (`BOITE_HOST_AGENTS=0`) never shares or reads the developer's own
  profile: sources show their path with no count.

## Verification

- `bun test packages/core/test/profile-share.test.ts`: links, copies, the three
  spellings of a retargeted path, an account's own file set aside once, removal
  when the source goes, and removal of an account leaving the source alone.
- `bun test packages/core/test/hooks.test.ts`: descriptor refusals, source
  counting and the ledger (dedupe of skips, the 50-run cap, the 500-character
  reason).
- `bun test packages/core/test/claude.hooks.test.ts` and `-t "codex hooks"` in
  `codex.test.ts`: a blocked prompt draws the line in the thread and counts in
  `hooks.status`, on a fake SDK and a fake app-server.

These do not run a live agent. The message shapes were read from Claude Code
2.1.267 and Codex 0.157.1 with a real hook that exits 2.
