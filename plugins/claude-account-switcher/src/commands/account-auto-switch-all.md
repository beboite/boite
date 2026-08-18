---
description: Run the quota check for every provider at once
allowed-tools: Bash(pwsh:*)
---

Run:

```
pwsh -NoProfile -File "$HOME/.claude-tools/claude-cc.ps1" auto -Provider all
```

One block per provider. The exit code is the loudest of them, so read the blocks rather than the code.
