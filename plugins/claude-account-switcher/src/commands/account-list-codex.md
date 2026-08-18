---
description: The saved Codex accounts and their quota
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" list -Provider codex
```

Pass `-Refresh` instead if the user wants fresh numbers from the API rather than the cache.
