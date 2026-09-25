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
| `unknown` | never checked, the provider is not available on this machine, or no file holds its login on this OS (Claude on macOS, whose login is in the Keychain) |
| `ok` | the session file is there |
| `unauthenticated` | the directory exists and the session file does not |
| `error` | the check itself failed, with the reason |

The check runs when an account is added, when it is asked for, and after a login
process exits. A changed status reaches every client as `accounts.updated`, so a
second shell or a phone follows it without a reload. A check asked for that
finds the same status answers with the account and writes and sends nothing, so
the Accounts page checking on every focus costs no journal row and keeps the
cached model lists; a new account and a finished login are always sent. `auth.identity`, where a descriptor
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

## The guided connection

Nobody should meet "no provider" as a dead end. When the composer has nothing
to pick, its model chip becomes `Connect an AI` and opens `ConnectFlow.svelte`:
Claude and Codex first, each naming the plan it uses, the other agents below.
Choosing one walks the same steps as its row on the Providers page
(`lib/provider-setup.ts`), one at a time: the download when Boite can fetch the
agent, its own installer page otherwise, then the sign-in with the page to open
and the field for a code. An agent whose login is a menu (see below) gets the
same terminal as on the Providers page, inside the dialog. A download asked for
here goes on to the sign-in by itself. Once the account answers, `Use <provider>` moves the composer to it
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

Providers shows one row per provider and its next step. A row's chevron opens
its accounts: sign in again for an isolated one, Check (the session file, then a
model probe), Remove, quotas, `Add another account`, which names the account
after the provider and starts its sign-in, and `Use my command-line login` when
no account uses the default location. Default-location accounts keep their
external login.
Claude subscription quotas come from its OAuth usage endpoint using the account's
credentials file. Keychain-only Claude credentials are not supported. Codex quotas
come from `account/rateLimits/read`, without starting a conversation.

The tray Usage window always lists Claude, Codex, Antigravity, Grok and OpenCode
Go. Each row shows the lowest remaining limit across its monitored accounts and
the next reported reset. Open a row for individual windows, account names and
monitoring switches. Missing accounts lead to Providers.

The tray popup opens after 500 ms of continuous hover. Leaving the icon cancels
that opening; a click does not bypass the delay. On Windows it stays inside the
monitor's work area, above a bottom taskbar. Auto-hidden taskbars reserve their
full height even while sliding offscreen. The popup keeps its position when the
taskbar retracts and allows moving from the icon into the popup before closing.

Grok reads the selected account's `GROK_HOME/auth.json` and requests its credit
percentage from the Grok CLI billing endpoint. Expired logins require `grok login`.
OpenCode Go reads the `opencode-go` API login in the account's
`XDG_DATA_HOME/opencode/auth.json`; a default account can also use
`OPENCODE_API_KEY`. It requests rolling, weekly and monthly limits from the Go
usage API. It never substitutes another provider's login or local token totals.

Antigravity uses a separate, opt-in `Antigravity CLI` source. Install `agy` 1.1.11
or later and sign in once, then expand Antigravity in the tray and enable the
switch. Boite reads `agy -p /usage --output-format json` in a temporary directory,
with a version check, output limit and timeout. It does not send a model prompt.
The report belongs to the CLI login on the core's computer, not an isolated ACP
account. Its reserved quota id is `quota:antigravity-cli`; disabling monitoring
persists like any account preference. No CLI process starts while it is disabled.

The data formats follow the source notes in
[CodexBar](https://github.com/steipete/CodexBar/tree/main/docs).

Monitoring is configurable per account. Successful reads are cached for one minute,
manual refreshes are at least ten seconds apart, and failures retry after five
minutes. A failed refresh preserves the last reading and marks it stale. An
unknown percentage is unavailable, not zero. Other providers report that quotas
are unsupported rather than inventing a balance.

[Plugins](plugins.md) such as the recommended kebacc-switcher manage external CLI account pools.
There is no automatic rotation or relay.
