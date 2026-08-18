---
description: Save the Claude Code login you are on into the pool
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" add -Provider claude
```

Report the account it saved. If it says you are not logged in, say so and stop.
