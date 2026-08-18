---
description: Forget a saved Claude Code account
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*)
---

Run:

```
~/.claude-tools/kebacc-switch remove -Provider claude -Email <email> -Yes
```

Confirm with the user which account before running this: it is not reversible without logging in again. The live session is untouched.
