---
description: Switch Claude Code to another saved account, on this conversation
allowed-tools: PowerShell
argument-hint: "<email | index | next> [--no-resume] [--window] [--close]"
---

Argument: `$ARGUMENTS`

With no argument, or `list`, show the pool and ask which one:

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" switch list
```

Otherwise pass the argument straight through - an email, a fragment of one, an
index, or `next` (the account with the most 5h headroom):

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" switch <argument>
```

The session restarts on the same conversation by default, because a running
process read its credentials once at startup and cannot adopt the new login.
Map the flags: `--no-resume` → `-NoRefresh` (swap the credentials, leave the
session running on the old account), `--window` → `-NewWindow`, `--close` →
`-CloseCurrent`.

**Warn the user before running it**: this session ends and comes back within a
few seconds, so anything they were about to send should wait. Inside Boite it
comes back in the same pane; the app itself is never closed.

Exit `0` switched (or already there), `30` nothing saved → `/claude-account-add`,
`40` no such account or several matched (show the emails, ask which),
`41` that snapshot holds a different account's login → `/login` as that account,
then `/claude-account-add`.
