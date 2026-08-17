---
description: Save the currently logged-in Claude Code account into the pool
allowed-tools: PowerShell
argument-hint: "[email] [--clear]"
---

Argument: `$ARGUMENTS` (an email overrides the detected one; `--clear` clears the
local login afterwards, without logging the account out, so the next `/login`
can add a second one).

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" add -Yes
```

`-Yes` is what makes this runnable from here: it takes the account Claude Code
reports and asks nothing, and this session has no stdin. Add `-Email "<arg>"`
when an email was given, and `-Clear` on `--clear`.

Exit `0` saved - report the email and that the login is encrypted for this
Windows user; `1` not logged in → `/login` first; `2` the detected login is not
the email that was asked for - say which account is actually logged in, and that
re-running with just `-Yes` saves it under its own name.

Two accounts are the minimum for a switch to have anywhere to go:
`/claude-account-add --clear`, `/login` as the other account, then
`/claude-account-add` again.
