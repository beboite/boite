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

# Codex driver: background app-servers and live command output

Measured on 2026-10-15 in the Linux container (Bun 1.4.2, codex-cli 0.162.1),
`nice -n 10`, three runs per side, alternating. Before is the Codex driver of
`origin/main` at 2adac07b; after is `boite/perf-drivers`.

## MCP servers a title starts

A throwaway script called the driver's `titleTurn` against the installed
`codex`, with a temporary `CODEX_HOME` whose `config.toml` lists two stdio MCP
servers (one named with a dot) that append their PID to a file when started.
No login: the title turn itself fails with HTTP 401, after `thread/start` has
started or skipped the servers.

| Reading | Before | After |
| --- | ---: | ---: |
| MCP servers started per title | 2 | 0 |

Three runs each, identical. A per-server dotted key (`mcp_servers.<name>.enabled`)
fails `thread/start` on a name with a dot, so the driver sends the nested
table. The fork setup sends the same table with its `thread/fork`.

## Live output of a running command

```sh
nice -n 10 bun bench/codex-live-output.ts
```

A 6 s command printing a 100-character line every 5 ms (1,200 deltas). Medians:

| Reading | Before | After |
| --- | ---: | ---: |
| running parts published | 25 | 7 |
| output characters in them | 381,400 | 28,000 |
| CPU in `appendOutput` | 40.9 ms | 8.4 ms |

The CPU line leaves out the one join per redraw, which now runs in the timer.

## Not measured

- Reasoning deltas no longer report the `thinking` phase once the part is
  open: one progress call per reasoning section instead of one per delta. Work
  removed, not timed.
- Rolling rate-limit updates reach the quota store; the probe processes they
  save need the store change of the network pull request.

# Provider detection and the Codex launcher

Measured on 2026-10-15 in the Linux container (Bun 1.4.2), `nice -n 10`.
Before is the core at 2adac07b (the providers code `origin/main` had then),
extracted beside the branch with the same bench file; after is
`boite/perf-drivers`. Runs alternate.

## Listing the providers

```sh
nice -n 10 bun bench/provider-list.ts
ONLY=1 LOOPS=1000 nice -n 10 strace -f -c -e trace=%file bun bench/provider-list.ts
```

500 calls each after 20 warm-up calls, fresh temporary data directory, this
machine's PATH. Medians of five runs, microseconds per call:

| Call | Before | After |
| --- | ---: | ---: |
| `list()` | 486.0 | 377.8 |
| `summary('pi')` | 144.1 | 12.4 |
| `summary('opencode')` | 15.1 | 15.3 |

File syscalls over 1,020 calls of each (three runs, identical):

| Syscall | Before | After |
| --- | ---: | ---: |
| `access` | 54,122 | 13,322 |
| `statx` | 16,351 | 17,373 |
| `openat` | 13,469 | 5,308 |
| `readlink` | 13,281 | 5,122 |
| total | 97,336 | 41,237 |

pi's two `npm` candidates no longer walk the global npm roots on each call,
and a managed install's release record costs one `stat` instead of a read
and a parse. Thread focus and draft preparation now resolve the one provider
they need instead of listing all of them.

## Codex behind npm's Node launcher

When PATH resolves `codex` to npm's `@openai/codex/bin/codex.js`, the core now
starts the vendor binary beside it. Five alternating runs of `codex --version`
(codex-cli from `~/.local/lib/node_modules`, first launcher run cold at 823 ms
and left out of the median):

| Start | Median |
| --- | ---: |
| through the launcher | 107 ms |
| the vendor binary | 24 ms |

An idle `codex app-server` with a temporary `CODEX_HOME`, `ps -o rss` after
4 s, three runs each: the Node launcher held 46,592 to 46,636 KB on top of the
82,616 to 84,508 KB binary, which the binary alone keeps. On this machine the
`codex` first on PATH is a cgroup wrapper script, which the core keeps running,
so the saving applies to installs where PATH reaches the launcher itself.

## Not measured

- `resolveLaunch` resolves the program and its prefix once per spawn instead
  of twice: one `resolveCommand` removed per agent start, probe and login.
- ACP `session/update` is no longer parsed by the SDK's schema in the handler;
  the SDK's own session router still parses it once.
