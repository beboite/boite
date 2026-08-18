---
description: The saved Claude Code accounts and their quota
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" list -Provider claude
```

Pass `-Refresh` instead if the user wants fresh numbers from the API rather than the cache. Repeat the lines as they are; the `*` marks the account in use.
