---
description: Restart every registered Claude Code thread in place, without closing Boite
allowed-tools: PowerShell
argument-hint: "[list] [--idle] [--stagger <seconds>]"
---

Argument: `$ARGUMENTS`

With `list`, say what would happen and change nothing:

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" refresh -List
```

Otherwise:

```powershell
pwsh -NoProfile -File "$HOME\.claude-tools\claude-cc.ps1" refresh all
```

Map `--idle` → `-Idle` and `--stagger <s>` → `-Stagger <s>` (spacing between two
threads coming back, 0.4 s by default).

Every session in `~/.claude-cc-accounts/.threads.state` ends and is started
again by the wrapper, this one last. The Boite app is never closed, never
restarted: only the `claude` processes inside the threads. A thread that is not
in the registry cannot be refreshed from outside itself.

**Warn the user first**: every open thread ends and comes back within a few
seconds, and each resumed thread starts a turn of its own unless `--idle`.

Exit `0` scheduled - report the per-thread lines. `2` nothing registered: point
at `claude-cc watch hook`, and note that already-open threads only register
themselves the next time they start. A per-thread `3` means the wrapper is not
in front of that session and nothing was ended there.
