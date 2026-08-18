---
description: The saved Claude Code accounts and their quota
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch list -Provider claude
```

Pass `-Refresh` instead if the user wants fresh numbers from the API rather than the cache. Repeat the lines as they are; the `*` marks the account in use.
