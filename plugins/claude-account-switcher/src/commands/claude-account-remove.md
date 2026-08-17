---
description: Remove a saved account from the pool
allowed-tools: PowerShell
argument-hint: "<email | part of it | row number> [--purge]"
---

Argument: `$ARGUMENTS`

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" remove <who> -Force
```

`<who>` is an address, any unambiguous part of one, or the row number shown by
`/claude-account-list`. Run the list first when the user named the account
loosely, and say which address you are about to remove before running this.

The snapshot is archived to `~/.claude-cc-accounts/.backups/removed-*.json.bak`
and its entry is dropped from the pool manifest. `--purge` adds `-Purge`, which
deletes the file instead - that copy of the login is then gone for good, so only
pass it when the user asked for it in those terms.

Nothing about the running session changes: the credentials in use live in Claude
Code's own config, and the pool holds copies. Removing the account currently
logged in only means the switcher can no longer come back to it, so that one is
refused unless `-AllowCurrent` is added as well - only add it after saying so
and getting the user's answer.

`-Force` skips the console confirmation, which cannot be answered from here; do
not pass it before the user has named the account they want gone. It does not
cover the live account: that is `-AllowCurrent`, on purpose.

Exit `0` removed, `1` no account matched, `30` the pool is empty, `64` the
argument matched several accounts (the script prints them - ask which one), none
was given, or the target is the live account and `-AllowCurrent` was not passed.
