# Accounts

An account is a provider descriptor plus a directory. The directory is what makes
one login blind to the others, so several seats on one agent can run side by side
without either noticing the other. The code is
`packages/core/src/accounts.ts`; the descriptor fields it reads are described in
[providers.md](providers.md).

`accounts.logins` restores running login cards after reconnect. `accounts.loginCancel`
stops the login process and waits for it to exit. Removing an account does the
same before deleting its isolated directory; default CLI directories stay on
disk. Removal is refused while any thread still references the account.

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
- Grok moves with `GROK_HOME`, and files `auth.json`.
- Antigravity moves with `GEMINI_HOME`, files `antigravity-acp/acp_token.json`
  under it, and has no default account at all: its descriptor says
  `isolation.alwaysIsolated`, so `accounts.add` gives every account a directory
  of its own whatever the request asked for.

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
`CODEX_HOME` to `~/.codex`, `CLAUDE_CONFIG_DIR` to `~/.claude`, `GROK_HOME`
to `~/.grok`, and `PI_CODING_AGENT_DIR` to `.pi/agent` under the home.
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
asks for one: it prints a link and a code and never opens a browser.

The other shape is `login.acp`, for an ACP agent whose sign-in is the protocol's
own `authenticate` call rather than a command. The core starts the agent itself
under the same `login:<accountId>` thread, sends `initialize` then `authenticate`
with the descriptor's method id, refuses a method the agent does not advertise,
and gives up after five minutes. The sign-in link arrives as a line on the agent's
stdout that is not JSON, and reaches the page the same way, in `url`. The agent
holds a loopback listener for the redirect, so a browser on the core's machine
finishes the flow on its own; from a phone, the redirect URL pasted into
`accounts.loginInput` is fetched once by the core. What is accepted is narrow on
purpose: a loopback URL whose port and path are the ones the agent asked for in
the `redirect_uri` of the link it printed. A paste aimed anywhere else on the
machine is refused by name, and no redirect is followed. Antigravity is the
shipped example.

A login that insists on opening a browser window of its own is one Boite points at
a launcher that does nothing, through the profile's `BROWSER` variable, so the link
goes to the page and never to a window over the user's work.

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

## Quotas and account pools

Providers shows connection actions, account checks and model discovery. Isolated
accounts can reconnect there; default-location accounts keep their external login.
Claude subscription quotas come from its OAuth usage endpoint using the account's
credentials file. Keychain-only Claude credentials are not supported. Codex quotas
come from `account/rateLimits/read`, without starting a conversation.

Monitoring is configurable per account. Successful reads are cached for one minute,
manual refreshes are at least ten seconds apart, and failures retry after five
minutes. A failed refresh preserves the last reading and marks it stale. Other
providers report that quotas are unsupported rather than inventing a balance.

The optional [kebacc-switcher plugin](plugins.md) manages external CLI account pools.
There is no automatic rotation or relay.
