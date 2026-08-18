---
description: Forget a saved Codex account
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" remove -Provider codex -Email <email> -Yes
```

Confirm with the user which account before running this: it is not reversible without logging in again.
