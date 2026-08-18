---
description: Switch Codex to another saved account
allowed-tools: Bash(~/.claude-tools/claude-cc:*)
---

Run:

```
~/.claude-tools/claude-cc switch -Provider codex -Email <email>
```

Ask which account first if the user did not name one. Tell them to restart the CLI afterwards. If it answers that the account is not trusted it is waiting for a yes or no, so ask the user before answering.
