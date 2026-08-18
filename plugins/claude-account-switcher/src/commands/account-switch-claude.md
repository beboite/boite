---
description: Switch Claude Code to another saved account
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" switch -Provider claude -Email <email>
```

Ask which account first if the user did not name one — run the list command to show the choices. Tell them to restart the CLI afterwards.
