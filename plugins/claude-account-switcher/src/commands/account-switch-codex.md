---
description: Switch Codex to another saved account
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" switch -Provider codex -Email <email>
```

Ask which account first if the user did not name one. Tell them to restart the CLI afterwards. If it answers that the account is not trusted it is waiting for a yes or no, so ask the user before answering.
