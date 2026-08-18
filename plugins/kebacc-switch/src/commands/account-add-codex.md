---
description: Save the Codex login you are on into the pool
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*)
---

Run:

```
~/.claude-tools/kebacc-switch add -Provider codex
```

Report the account it saved. An API key has no email attached, so if it asks for one, ask the user for it and pass `-Email`.
