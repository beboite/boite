# Accounts

An account is a provider descriptor plus a directory. The directory is what makes
one login blind to the others, so several seats on one agent can run side by side
without either noticing the other. The code is
`packages/core/src/accounts.ts`; the descriptor fields it reads are described in
[providers.md](providers.md).

## The isolation directory

Every account Boite creates gets `<dataDir>/accounts/<id>/`, and the descriptor's
`isolation` map decides what that directory means to the agent. The map is
environment variables, with `{isolationDir}` substituted at spawn:

- OpenCode moves with the XDG pair, `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, and
  files its login at `opencode/auth.json` under the data one.
- Codex moves with `CODEX_HOME`, and files `auth.json` directly under it.
- pi moves with `PI_CODING_AGENT_DIR`, which is the whole config directory, so
  one variable is enough and the session file is `auth.json` under it.
- Claude moves with `CLAUDE_CONFIG_DIR`, and files `.credentials.json`.

The same environment goes to every process of that account: a turn, a probe, a
login. That is why the map lives on the OS profile rather than in a driver, and
why a new provider needs no code to get isolation.

## The default account

An account whose `isolationDir` is null runs on the provider's own default
location, which is the user's real CLI login. It is not a lesser account: it is
usually the one with the subscription, and reading it is the point.

Reading it correctly needs one thing the descriptor does not say, which is what
the isolation variable means when nobody sets it. The core carries those
defaults: the XDG pair resolve under `~/.local/share` and `~/.config`,
`CODEX_HOME` to `~/.codex`, `PI_CODING_AGENT_DIR` to `.pi/agent` under the home.
A variable the core does not know falls back to `~/.<id>`. Without that table a
default account is looked for in the wrong place, finds no session file, and
reports `unauthenticated` while the user is perfectly logged in. That failure is
silent by nature, so a new isolation variable means a new entry in that table, in
the same change.

## What the core checks

`accounts.check` reads the files `auth.session` names, inside the account's
directory or inside the provider's own location, and answers with one of four
statuses:

| Status | Meaning |
|---|---|
| `unknown` | never checked, or the provider is not available on this machine |
| `ok` | the session file is there |
| `unauthenticated` | the directory exists and the session file does not |
| `error` | the check itself failed, with the reason |

The check runs when an account is added, when it is asked for, and after a login
process exits. Its result reaches every client as `accounts.updated`, so a second
shell or a phone follows it without a reload. `auth.identity`, where a descriptor
provides it, is what turns a status into a name the picker can show.

## The login flow

For an isolated account, the descriptor's `login` block is the argv of the
provider's own login command, and the core runs it rather than asking the user to
open a terminal:

1. `accounts.login` spawns it through `procs.spawnPiped` under the synthetic
   thread `login:<accountId>`, so it sits in a Job Object and in the trace like
   any agent process. It runs with the account's environment, the isolation
   directory as its working directory, and stdin open.
2. Its output comes back line by line as `account.login`, `state: "running"`. The
   first `https://` link it prints is carried separately in `url`, so the UI can
   offer it as something to click rather than as text to find.
3. A CLI that asks for a code takes it through `accounts.loginInput`, one line
   into the running process's stdin.
4. On exit the event carries `done` or `failed` with the exit code, the core
   rechecks the account, and `accounts.updated` follows.

A device-code flow fits that shape exactly, which is why the Codex login block
asks for one: it prints a link and a code and never opens a browser. A login that
insists on opening a browser is a login Boite cannot run for the user.

## What the core refuses, and why

- The provider has no `login` block. Nothing to run, so the answer is a refusal
  naming the provider rather than a spinner. pi is the shipped example: its login
  is a slash command inside its own interface, with no command-line equivalent.
- A login is already running for that account. One at a time, or two processes
  race on one credentials file.
- The account uses the provider's own default location. That login is the user's
  own CLI, outside Boite, and running it from here would write into the real
  configuration directory the user is logged into. The refusal says so.
- The login command is empty, or its executable does not resolve. Refused at the
  spawn, naming what was tried.

Every one of those is a loud refusal carrying the reason, never a silent
no-operation. The Accounts page shows the reason in its error banner.

## Removing an account

`accounts.remove` deletes the account and emits `accounts.removed`, which also
drops every probe cached for it, since a probe's answer belongs to one login. The
descriptor's `close.processes` names what to close first, which matters for an
agent that keeps a background process on its configuration directory. An account
that runs under `node` names nothing there, because the process in the job is
`node` and killing every `node` on the machine is not a thing Boite will ever do.

## What is not here yet

No account pools, no relay, no automatic rotation between seats. Those belong to
a plugin, out of process, and the plugin host is not written.
