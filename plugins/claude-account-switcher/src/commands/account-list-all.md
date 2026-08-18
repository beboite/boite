---
description: Every saved account, across all providers
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" list -Provider all
```

One block per provider. Summarise how many accounts each has and which one is in use.
