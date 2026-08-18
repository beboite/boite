---
description: Switch Claude Code to another saved account
allowed-tools: Bash(~/.claude-tools/kebacc-switch:*), Bash(~/.claude-tools/kebacc-switch.exe:*)
---

Run `~/.claude-tools/kebacc-switch`, or `~/.claude-tools/kebacc-switch.exe` on Windows:

```
~/.claude-tools/kebacc-switch switch -Provider claude -Email <email>
```

Ask which account first if the user did not name one — run the list command to show the choices. Tell them to restart the CLI afterwards. If it answers that the account is not trusted it is waiting for a yes or no, so ask the user before answering.
