# Account switcher

Several logins for Claude Code and for Codex, saved on this machine, and one
command to move between them when one runs out of quota.

It is vendored here rather than fetched: Boite writes these files into
`~/.claude-tools` and runs `install.ps1` there. Nothing is downloaded, and there
is no third-party repository in the trust path.

## What it does

- **add** — saves the login the CLI is using right now into a pool.
- **list** — the saved logins with what is known of their quota. `-Refresh`
  asks the provider's API; without it the numbers come from the cache.
- **switch** — puts another saved login in front of the CLI.
- **auto** — switches only when the one in use is out of quota, and only to one
  that is not. This is the command worth wiring to a key or a hook.
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

The status line reads the Claude Code pool only; Codex has no status line to
put a segment in.

Inside Claude Code the same things are slash commands: `/account-add-claude`,
`/account-list-all`, `/account-auto-switch-all`, and so on.

## Where things are kept

| Path | What |
| --- | --- |
| `~/.claude-tools/` | the scripts, and `.version` |
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

PowerShell 7 (`pwsh`) on Windows, macOS or Linux. The status line additionally
wants `node` on the PATH; it is off unless `install.ps1 -StatusLine` is passed.

## Layout

```
install.ps1 / uninstall.ps1     put it down, take it back
src/cc-providers.ps1            what each CLI keeps on disk
src/cc-pool.ps1                 the trust stamps
src/claude-cc-common.ps1        crypto, snapshots, usage
src/claude-cc.ps1               the entry point, and `-Provider all`
src/claude-code-*.ps1           one file per command
src/claude-cc-statusline.js     the Claude Code status line
src/commands/*.md               the slash commands
```
