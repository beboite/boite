---
description: Check the switcher install and the saved accounts
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch doctor -Provider all
```

Report the `!` and `~` lines. Plain-text snapshots are fixed with `doctor -Provider <id> -Protect`, unstamped ones with `-Adopt`.
