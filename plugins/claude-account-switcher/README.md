# Account switcher

Several logins for Claude Code and for Codex, saved on this machine, and one
command to move between them when one runs out of quota.

It is vendored here rather than fetched, and it is a Rust binary: the crate is
`crates/claude-cc`, built by the same `cargo build` that builds Boite, and
`install.ps1` copies what came out of that build into `~/.claude-tools`. Nothing
is downloaded, no binary is committed, and there is no third-party repository in
the trust path.

A command that a status line runs on every repaint, and a hook that runs at every
session start, is a process start the user waits for: the binary answers in a few
milliseconds where the PowerShell it replaces took most of a second to load its
own runtime first.

## What it does

- **add** — saves the login the CLI is using right now into a pool.
- **list** — the saved logins with what is known of their quota. `-Refresh`
  asks the provider's API; without it the numbers come from the cache.
- **switch** — puts another saved login in front of the CLI.
- **auto** — switches only when the one in use is out of quota, and only to one
  that is not. It does nothing on its own: something has to call it, which is
  what `install.ps1 -AutoSwitch` sets up.
- **remove** — forgets a saved login. The live session is untouched.
- **doctor** — what is installed, what is readable, what the pool thinks of
  itself. `-Protect` re-seals plain-text snapshots, `-Adopt` stamps the ones
  this machine never registered, `-Rollback` puts back the credentials from
  before the last switch, `-Clean` deletes files an earlier version left behind.

Every command takes `-Provider claude`, `-Provider codex`, or `-Provider all`
to run once per provider.

```
claude-cc list -Provider all
claude-cc auto -Provider claude
claude-cc switch -Provider codex -Email you@example.com
```

## Switching without being asked

`install.ps1 -AutoSwitch all` writes one `SessionStart` hook into
`~/.claude/settings.json`, so `auto` runs once as each Claude Code session
starts: a session that would have opened on a capped account opens on a free one
instead. `-AutoSwitch claude` or `-AutoSwitch codex` narrows it to one pool.
Installing again replaces that hook rather than adding a second one, and
`uninstall.ps1` takes it back out. Nothing runs in the background — no watcher,
no daemon; between two sessions nothing of this is running.

## The status line

`install.ps1 -StatusLine` points Claude Code's status line at `claude-cc
statusline`, which reads the payload on stdin and prints one line. It draws the account in use and its two windows, how
many saved Claude logins still have room, how many Codex logins do — Codex has
no status line of its own, and both pools are switched from here — and, when the
`SessionStart` hook is in place, what the switch is armed for:

```
you · 5h 43% / 7d 69% · 2 free · codex 1 free · auto all
```

It never asks the network: the live window comes from the payload Claude Code
hands it, the rest from the cache the switcher already wrote.

Inside Claude Code the same things are slash commands: `/account-add-claude`,
`/account-list-all`, `/account-auto-switch-all`, and so on.

## Where things are kept

| Path | What |
| --- | --- |
| `~/.claude-tools/` | the binary, and `.version` |
| `~/.claude-cc-accounts/` | saved Claude Code logins |
| `~/.codex-cc-accounts/` | saved Codex logins |
| `~/.claude/commands/account-*.md` | the slash commands |

One saved login is one `.json` file. The dotfiles beside them are the pool's own
bookkeeping.

## How the saved logins are protected

The tokens in a snapshot are sealed before they are written: DPAPI on Windows,
AES-GCM elsewhere under a key held by the macOS Keychain or by libsecret. A
sealed value is `ccx1:` followed by base64. Where no OS secret store exists the
snapshot is written in plain text and every command says so out loud.

A pool directory is just a directory, so anything able to write there could drop
a snapshot in it. Each entry is therefore stamped with an HMAC over the file
name, the account, and a hash of the tokens, under a key only this user can
read. `list`, `switch` and `doctor` report an entry that does not verify;
`switch` asks before using one.

## Requirements

Nothing at run time: the binary carries what it needs, and it talks to DPAPI, to
the Keychain or to libsecret through whatever the platform already has.
PowerShell 7 (`pwsh`) is needed to run `install.ps1` and `uninstall.ps1`, and a
Rust toolchain to build the crate.

## Layout

```
install.ps1 / uninstall.ps1     put it down, take it back
src/commands/*.md               the slash commands
crates/claude-cc/src/main.rs    the entry point, and `-Provider all`
crates/claude-cc/src/provider.rs   what each CLI keeps on disk
crates/claude-cc/src/pool.rs    the trust stamps
crates/claude-cc/src/seal.rs    DPAPI, Keychain, libsecret
crates/claude-cc/src/usage.rs   the quota windows and their cache
crates/claude-cc/src/live.rs    the credentials the CLI is holding
crates/claude-cc/src/cmd/       one file per command, status line included
```

The crate lives in the workspace at the repository root rather than under
`plugins/`, because that is where `cargo build` looks for it.
