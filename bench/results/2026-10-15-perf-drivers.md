# Claude driver: memory after a turn and MCP servers of background queries

Measured on 2026-10-15 in the Linux container (Bun 1.4.2), `nice -n 10`, three
runs per side, alternating. Before is `origin/main` at 2adac07b with the same
bench file copied in; after is `boite/perf-drivers`.

## Heap and RSS of a scripted turn

`bench/claude-turn-heap.ts` runs one scripted Claude turn on a warm session (30
minutes): 20 Write calls, each with a 256 KiB input, a 1 MiB result and its
`tool_use_summary`. Readings are taken after `Bun.gc(true)` and given as the
difference from the reading before the turn. `open` is the turn still running
with every summary landed; `idle` is after the turn finished.

```sh
nice -n 10 bun bench/claude-turn-heap.ts                         # 5 MiB image on the prompt
STEER=1 IMAGE_MIB=0 nice -n 10 bun bench/claude-turn-heap.ts     # a follow-up cuts the answer first
```

Medians in MiB:

| Scenario | Reading | Before | After |
| --- | --- | ---: | ---: |
| image turn | open heap | 50.4 | 50.4 |
| image turn | idle heap | 33.7 | 1.8 |
| image turn | idle RSS | 46.9 | 13.9 |
| follow-up cut | open heap | 26.8 | 1.6 |
| follow-up cut | open RSS | 32.8 | 7.2 |
| follow-up cut | idle heap | 27.1 | 1.8 |

The open heap of the image turn does not move: the open message holds the
same strings the driver held, so there was no second copy while it streams.

What kept the memory before, found with heap snapshots:

- `ClaudeSession.run(first)` held the session's first turn, with its tool map
  and context, for as long as the CLI ran.
- The session's context after a turn: every callback built in
  `TurnContexts.makeContext` shared one scope that captured the turn's input
  and prepared attachments.
- `PromptQueue.stream()` and the SDK's input loop held the last prompt object,
  image included, until the next prompt.

## MCP servers of a model probe

A throwaway script ran the SDK's `supportedModels()` with the options of
`models.ts` against the installed Claude Code CLI, with an isolated
`CLAUDE_CONFIG_DIR` whose `.claude.json` lists one stdio MCP server that writes
a file when started. No login and no model request.

| Options | Models | MCP server started |
| --- | ---: | --- |
| `mcpServers: {}` (before) | 5 | yes, 2 of 2 runs |
| `mcpServers: {}, strictMcpConfig: true` (after) | 5 | no, 2 of 2 runs |
