---
description: Check the switcher install and the saved accounts
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" doctor -Provider all
```

Report the `!` and `~` lines. Plain-text snapshots are fixed with `doctor -Provider <id> -Protect`, unstamped ones with `-Adopt`.
