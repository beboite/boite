---
description: Switch Claude Code to another saved account
allowed-tools: Bash(~/.claude-tools/claude-cc:*)
---

Run:

```
~/.claude-tools/claude-cc switch -Provider claude -Email <email>
```

Ask which account first if the user did not name one — run the list command to show the choices. Tell them to restart the CLI afterwards. If it answers that the account is not trusted it is waiting for a yes or no, so ask the user before answering.
