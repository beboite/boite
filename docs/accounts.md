# Accounts

An account combines a provider descriptor and a login directory. Isolated
accounts keep separate configuration and credentials. `packages/core/src/accounts.ts`
owns their lifecycle; [providers](providers.md) defines descriptor fields.

`accounts.logins` restores running login cards after reconnect. `accounts.loginCancel`
stops the login process and waits for it to exit. Removing an account does the
same before deleting its isolated directory; default CLI directories stay on
disk. Removal also stops connection checks and model discovery before deleting
the directory, and blocks new account operations while it runs. Removal is
refused while any thread still references the account.

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
- Muse Code moves with the three XDG homes, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`
  and `XDG_STATE_HOME`, and files its login at `muse/auth.json` under the config
  one, which is `~/.config/muse/auth.json` for the default account.
- Antigravity moves with `GEMINI_HOME`, files `antigravity-acp/acp_token.json`
  under it, and has no default account at all: its descriptor says
  `isolation.alwaysIsolated`, so `accounts.add` gives every account a directory
  of its own whatever the request asked for.
- The Antigravity CLI moves with nothing. `agy` keeps its token in the system
  keyring and its settings under `~/.gemini/antigravity-cli`, and no variable
  points either elsewhere, so its descriptor declares an empty map and only the
  default account exists. Its `auth.kind` is `none`: there is no session file to
  read, and a signed-out agy shows up in the model probe instead.

The same environment goes to every process of that account: a turn, a probe, a
login. The OS profile owns the map; drivers use the resolved account environment.

## What an isolated account shares

Isolation moves the whole configuration directory, so without more an isolated
account runs with none of the user's settings, hooks, skills or instructions.
The descriptor's `shared` block ([providers.md](providers.md#hooks-and-shared-configuration))
names what it takes from the user's own directory, and the core lays it out
before every spawn (`packages/core/src/profile-share.ts`):

- A directory is linked: a junction on Windows, a symlink elsewhere. The account
  sees the user's `skills` or `plugins` as they are now, and an edit through the
  link lands in the user's own directory.
- A file is copied, so an agent that rewrites its settings writes its own copy.
  The next spawn replaces a copy that differs from the source; the user's file
  wins over the agent's edit. A copy listed under `retarget` has the source's
  paths rewritten to the account's own.
- Something already there that Boite did not put there is set aside once as
  `<name>.own-<date>`, never deleted. A file or directory the user removed from
  their own directory goes from the account too, as long as it is still what
  Boite put there.
- A path with a link between it and the account directory is not shared, since
  whatever went through the link would land outside the account.
- `.boite-shared.json` in the account directory records the links and the hash
  of each copy, which is how Boite tells its own work from the account's.

A path that fails is logged once and shown under the account in Settings >
Brain > Hooks; the spawn goes on without it. The login files never move: a
share that would cover one is refused when the descriptor loads. The default
account needs none of this, since it runs on the user's own directory. A test
core (`BOITE_HOST_AGENTS=0`) shares nothing.

| Provider | Shared configuration paths |
| --- | --- |
| Claude | `settings.json`, `CLAUDE.md`, `skills`, `plugins`, `agents`, `commands`, `hooks`, `output-styles` |
| Codex | `config.toml`, `hooks.json`, `AGENTS.md`, `skills`, `rules`, `prompts`, `plugins` |
| Grok | `config.toml`, `hooks`, `AGENTS.md`, `AGENT.md`, `skills`, `trusted_folders.toml`, `installed-plugins` |
| pi | `settings.json`, `AGENTS.md`, `extensions`, `skills`, `prompts`, `themes` |
| OpenCode | `opencode/opencode.json`, `opencode/opencode.jsonc`, `opencode/AGENTS.md`, `opencode/package.json`, plugin/agent/command/skill directories and `opencode/node_modules` |

These are whole-file copies or linked directories. An API setting or key inside
a shared settings file applies to every account using that file, as in the
user's CLI. Dedicated login/session files remain excluded. The shipped
descriptors are the authority for each provider's current path list;
[hooks](hooks.md) owns source discovery and reporting.

## The default account

An account whose `isolationDir` is null runs on the provider's own default
location, which is the user's real CLI login. Boite reads its existing authentication
without moving the configuration.

Startup, provider reloads and managed installs adopt that account when a CLI
login exists. If its session files are absent and Boite can run a piped login,
they leave account creation to guided sign-in, which creates one isolated
account named after the provider. No signed-out `Default` account is added
beside it. Terminal logins retain the default account, and a provider whose
login can live outside session files retains its account with unknown status.

Removing a default account opts that provider out of automatic adoption on this
core. Reloads, managed installs and core restarts respect that choice, even if
the CLI remains signed in or changes its login. The CLI's own files stay intact,
and other providers are unaffected. Guided sign-in can still create a new
isolated account. "Use my command-line login" explicitly restores the CLI
account and permits automatic adoption again, through an account added with
`useDefaultLocation: true`.

The core resolves unset isolation variables to provider defaults: the XDG pair resolve
under `~/.local/share` and `~/.config`,
`CODEX_HOME` to `~/.codex`, `CLAUDE_CONFIG_DIR` to `~/.claude`, `GROK_HOME`
to `~/.grok`, and `PI_CODING_AGENT_DIR` to `.pi/agent` under the home.
A variable the core does not know falls back to `~/.<id>`. A new isolation variable must
add its default location to that table in the
same change, or passive checks can report a signed-in account as unauthenticated.

## What the core checks

`accounts.check` reads the files `auth.session` names. A passive check answers
`ok` when the files exist, `unauthenticated` when they are absent, `unknown`
when the provider can store its login elsewhere, or `error` when the check fails.

The Check connection button requests a fresh login check, without listing
models or sending a prompt. Codex reads its account through the app-server with
`refreshToken: true`; Claude asks its CLI for `auth status --json`, including
Keychain accounts. Both return the signed-in email. Other providers retain their
session-file check. A failed check displays its reason instead of reporting a
model count. Passive checks do not launch an agent process.

A native Claude authentication refusal marks the account signed out, including
when it happens during preparation before the first prompt. Boite remembers
the refusal across restarts: a session file alone cannot restore the connected
status. A successful fresh CLI check or completed sign-in clears it. Billing,
rate limits and failures inside subagents do not invalidate the account.

Changed account statuses and identities reach every client as `accounts.updated`.
An unchanged passive check writes no journal row and sends no event.
`accounts.rename` changes the label of any account, including a default CLI
account, while keeping its ID, login directory and thread references.

Settings shows the chosen account label and its email separately. Emails stay
blurred until hovered, focused from the keyboard or tapped on a phone.
The model picker's account chips and their tooltips show the chosen label only.

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

Codex uses the app-server's `account/login/start` with `chatgptDeviceCode`.
The core carries its verification URL and code directly to the client, keeps
both visible until `account/login/completed`, then checks the resulting account.
The user enters the code on the sign-in page, with no code field to send it back
to Boite. Cancellation closes the process; expired codes show a retryable error.
Piped login output from other agents has terminal control sequences removed
before the core extracts links or displays text.

Failed sign-ins have a Close button. Cancelling stops an ongoing post-login
connection check as well as the login process; a refused login command reports
its failure immediately without starting that check. The account can then be
retried or removed from its row.

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

## The guided connection

When the composer has no usable provider, its model chip becomes `Connect an AI` and
opens `ConnectFlow.svelte`:
Claude and Codex first, each naming the plan it uses, the other agents below.
Choosing one walks the same steps as its row on the Providers page
(`lib/provider-setup.ts`), one at a time: the download when Boite can fetch the
agent, its own installer page otherwise, then the sign-in with the page to open
and the field for a code. An agent whose login is a menu (see below) gets the
same terminal as on the Providers page, inside the dialog. A download asked for
here goes on to the sign-in by itself. Once the account answers, `Use <provider>` moves
the composer to it
through `store.useProvider`, the same remembered choice a pick in the model
picker writes, and the text being typed stays where it was.

Each step replaces the button that led to it, so the dialog moves the keyboard
to the new step's first control whenever focus has fallen out of it: a
keyboard user goes from `Install` to `Cancel`, to the sign-in link, then to
`Use <provider>` without reaching for the mouse. On a phone the dialog is a
sheet at the bottom of the screen, and its last button stays above the home
indicator.

An account that answered `unauthenticated` gets a `Sign in again` chip beside
the model chip, and an error in its thread carries the same button. Both open
the dialog on that account, so the login lands on it instead of creating a
second one; a default-location account, which Boite never logs in, is told to
sign in from the agent's own window and check again, unless its login runs in a
terminal, which is then the user's own CLI answering. A paired phone gets
neither button and reads `No AI connected` on the chip: `accounts.*` and
`providers.install` are the owner's.

## Signing in from a terminal

Some login commands are a menu drawn in the terminal: `opencode auth login`
asks which provider to add, with arrow keys, a search field and a key to paste.
Piped output turns that into escape codes and gives the user nothing to answer
with. A descriptor that sets `login.terminal: true` gets a real shell instead,
the same one as the thread terminal ([terminal.md](terminal.md)):

1. `accounts.loginTerminal` starts the shell in a pseudo-terminal under
   `login:<accountId>`, with the account's environment and the isolation
   directory (or the home directory for the default account) as its working
   directory. Calling it again attaches to the running one.
2. Once the prompt goes quiet, the core types the login command into it, as the
   user would have: `& 'C:\path\opencode.exe' auth login` in PowerShell.
3. The Providers page draws the shell under the provider's row. The user
   answers the CLI there and closes the terminal once signed in, or types `exit`.
4. When the shell exits, the core rechecks the account and `accounts.updated`
   follows. `accounts.loginCancel` closes the shell too.

The default account may sign in this way, unlike a piped login: the command runs
in plain view, in the user's own CLI, which is what they would have typed in a
terminal of their own. A sign-in from a row goes to the default account first
when it is not signed in, then to an isolated account nobody is signed into,
then to a new one. OpenCode and Grok use it; the phone has no Providers page
and no terminal.

## What the core refuses, and why

- The provider has no `login` block. Nothing to run, so the answer is a refusal
  naming the provider rather than a spinner. pi is the shipped example: its login
  is a slash command inside its own interface, with no command-line equivalent.
- A login is already running for that account. One at a time, or two processes
  race on one credentials file.
- The account uses the provider's own default location and the login is piped.
  That login is the user's own CLI, outside Boite, and running it unseen would
  write into the real configuration directory the user is logged into. The
  refusal says so. A terminal login is the exception above.
- `accounts.loginTerminal` for a provider without `login.terminal`, or while a
  piped login runs for that account. Refused by name, with the field.
- The login command is empty, or its executable does not resolve. Refused at the
  spawn, naming what was tried.
- An account of its own, for a provider whose profile has no isolation variable
  and no login block. Such an account would run on the user's own login anyway,
  so `accounts.add` refuses it, names the profile's `isolation` field and says to
  use the default account. The Antigravity CLI is the shipped example.

The account controls display each refusal with its field and reason.

## Removing an account

`accounts.remove` deletes the account and emits `accounts.removed`, which also
drops every probe cached for it, since a probe's answer belongs to one login. The
descriptor's `close.processes` names what to close first, which matters for an
agent that keeps a background process on its configuration directory. An account
that runs under `node` names nothing there, because the process in the job is
`node` and killing every `node` on the machine is not a thing Boite will ever do.
The shared links are removed before the directory, so deleting the account
never walks into the user's own `skills` or `plugins`.

## Provider controls and account pools

Settings > Providers shows installation and sign-in steps, account labels and
identities, Check connection, Rename, Remove, Add another account and Use my
command-line login. Default-location accounts keep their external login.
The provider's default model and effort are device preferences. This page shows
no usage or quotas; [Usage and Limits](usage.md) owns quota sources, freshness,
credit balances, monitoring and the tray window.
Empty subscription usage keeps the last known limits marked stale and retries
after five minutes. A disabled paid-usage flag alone does not report quota data.

[Plugins](plugins.md) can manage external CLI account pools. Boite does not
rotate accounts automatically or relay provider requests.
