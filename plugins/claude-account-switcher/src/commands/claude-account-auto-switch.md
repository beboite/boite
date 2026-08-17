---
description: Switch account when the current one is out of quota
allowed-tools: PowerShell
argument-hint: "[now | status | on | off]"
---

Argument: `$ARGUMENTS` (empty means `now`).

`now`:

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" auto
```

`status` (reports what a switch would do, changes nothing):

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" auto status
```

Exit `0` nothing to do, `10` switched, `20` every account is at its limit,
`30` setup incomplete. Report the percentages in one or two lines. On `10`
inside Boite the thread refreshes itself a second later - nothing for the user
to do; elsewhere the running session keeps the old account until `claude
--resume`.

`on` / `off` is about the unattended watcher, not about this command:

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" watch install   # on
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" watch stop      # off, until the next logon
```

`watch install` registers the scheduled task (at logon, rechecked every 15 min)
and the `SessionStart` hook that lets a switch restart the open sessions. The
5-hour window switches at 99%, the weekly one at 99.8% (it takes days to come
back, so it is spent to the last drop).
