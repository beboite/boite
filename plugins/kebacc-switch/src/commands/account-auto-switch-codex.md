---
description: Switch Codex accounts only if this one is out of quota
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch auto -Provider codex
```

Exit 0 means there was room and nothing changed, 10 means it switched, 20 means every saved account is capped, 30 means fewer than two accounts are saved.
