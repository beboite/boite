---
description: Save the Codex login you are on into the pool
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch add -Provider codex
```

Report the account it saved. An API key has no email attached, so if it asks for one, ask the user for it and pass `-Email`.
