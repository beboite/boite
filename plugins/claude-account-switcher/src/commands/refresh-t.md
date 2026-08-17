---
description: Restart this Claude Code thread in place, same conversation
allowed-tools: PowerShell
argument-hint: "[--idle] [--delay <seconds>]"
---

Argument: `$ARGUMENTS`

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" refresh
```

Map `--idle` → `-Idle` (come back and wait instead of picking the work up) and
`--delay <s>` → `-Delay <s>`.

The `claude` process of this thread is ended and the wrapper on PATH starts it
again on the same conversation, in the same pane. Boite is never closed or
restarted.

**Warn the user first**: this session ends within a couple of seconds and comes
back on its own, so anything they were about to send should wait.

Exit `0` scheduled - say the thread is coming back. `2` this process was not
found. `3` the wrapper is not in front of this session, so nothing was ended:
`claude-code-shim.ps1 -Install`, then restart Boite once.
