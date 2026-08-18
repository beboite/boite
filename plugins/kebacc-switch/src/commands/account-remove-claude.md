---
description: Forget a saved Claude Code account
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch remove -Provider claude -Email <email> -Yes
```

Confirm with the user which account before running this: it is not reversible without logging in again. The live session is untouched.
