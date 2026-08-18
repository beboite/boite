---
description: Run the quota check for every provider at once
allowed-tools: Bash(~/.claude-tools/claude-cc:*)
---

Run:

```
~/.claude-tools/claude-cc auto -Provider all
```

One block per provider. The exit code is the loudest of them, so read the blocks rather than the code.
