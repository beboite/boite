---
description: Save the Codex login you are on into the pool
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" add -Provider codex
```

Report the account it saved. An API key has no email attached, so if it asks for one, ask the user for it and pass `-Email`.
