---
description: Accounts, quota, watcher and sessions in one block - no API call
allowed-tools: PowerShell
argument-hint: "[fresh | --no-usage | --cached]"
---

Argument: `$ARGUMENTS`

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" status
```

Append `-Fresh` when the argument is `fresh` (queries the usage API instead of
reporting the readings already on disk). Readings under a minute old are reused
either way, so running this twice costs nothing, and the script is read-only and
safe inside a live session.

Two arguments call `list` instead, which prints the same accounts without the
watcher and session lines: `--no-usage` runs `claude-cc.ps1 list -NoUsage`
(offline, instant), `--cached` runs `claude-cc.ps1 list -CacheOnly` (the
readings already on disk, no API call).

Relay the block as printed. Run nothing else: this command exists so one call
answers "which account, how much quota, is the switch armed".

Exit `0` listed, `30` pool empty - point at `/claude-account-add`.

Two kinds of line can follow the block: `-` is a note about the state right now
(no account with headroom left, sessions still to restart) and changes nothing;
`!` is a setup problem, and only that makes the exit code `1`. On `1`, offer
`claude-cc fix`, which repairs all of it in one call.

A row can carry a flag: `UNREGISTERED` / `CHANGED` (switching refuses it;
`claude-cc-pool.ps1 -Adopt` if the user put it there themselves), `SEALED`
(saved for another Windows user or machine), `MISLABELED` / `DUPLICATE` (the
file holds another account's login: `/login` as that account, then
`/claude-account-add`). `usage n/a` only means that snapshot's token expired and
does not block a switch.
