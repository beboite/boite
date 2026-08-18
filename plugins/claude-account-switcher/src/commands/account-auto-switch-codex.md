---
description: Switch Codex accounts only if this one is out of quota
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" auto -Provider codex
```

Exit 0 means there was room and nothing changed, 10 means it switched, 20 means every saved account is capped, 30 means fewer than two accounts are saved.
