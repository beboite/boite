---
description: Check the switcher install and the saved accounts
allowed-tools: Bash(~/.claude-tools/claude-cc:*)
---

Run:

```
~/.claude-tools/claude-cc doctor -Provider all
```

Report the `!` and `~` lines. Plain-text snapshots are fixed with `doctor -Provider <id> -Protect`, unstamped ones with `-Adopt`.
