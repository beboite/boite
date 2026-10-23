# Context modes

A conversation normally starts with everything the user set up: the
instruction files (`CLAUDE.md`, `AGENTS.md`), the Boite and brain guides Boite
adds to the first message, the MCP servers, the hooks and every built-in tool.
A context mode starts it without some of that, and can give it rules of its
own. It suits a small worker that only needs its brief, a review that must not
know the house rules, or a benchmark that compares models on equal footing.

The mode is fixed when the conversation is created. A conversation with one
shows a badge in its header and on its row in the Subagents tab: the preset's
name, `+ rules` when it has rules, and a tooltip listing what it left out, its
tools and the start of its rules. A phone shows the badge's icon alone in the
header. `boite delegate list` adds `context=<label>` to the child's route.

## Presets

| Preset | Instruction files | Guides | MCP servers | Hooks | Tools |
| --- | --- | --- | --- | --- | --- |
| `full` (default) | yes | yes | yes | yes | all |
| `light` | no | no | no | yes | Bash, PowerShell, Read, Write, Edit, Glob, Grep |
| `neutral` | no | no | no | no | all |

`light` keeps the user's hooks, so their guards still run. On Windows with
Claude Haiku and a 100k compaction window, `/context` measured 34.9k at startup
with the whole setup and 12.7k with `light` (2026-10-13). `neutral` runs no
hook of the user's at all; Boite's own permission and reporting callbacks
still run.

## Asking for one

Every field is optional, and nothing at all means `full`:

| Field | Meaning |
| --- | --- |
| `preset` | `full`, `light` or `neutral` |
| `keep` | Parts kept on top of the preset: `instructions`, `guides`, `mcp`, `hooks` |
| `drop` | Parts left out on top of the preset |
| `tools` | Built-in tools to keep, by the agent's own names. Left out: the preset's |
| `rules` | Up to 4,000 characters. They open every fresh session, before anything else the agent is told, and say they take precedence |

A mode that matches a preset carries its name; anything else reads `custom`.
A bad field is refused with its name, for example
`context.drop: expected a list of instructions, guides, mcp, hooks`.

From an agent:

```sh
boite delegate spawn "Count the parser lines" --context light
boite delegate spawn "Review the diff" --context neutral --rules-file review-rules.md
boite delegate spawn "Benchmark" --context neutral --keep mcp --tools Read,Grep,Bash
boite thread new my-project "Audit the API" --context neutral --rules "No prior decisions."
```

`--keep` and `--drop` take a comma-separated list, and `--rules-file` reads
the file from where the command runs. The same object goes in
`delegation.spawn`, `threads.create`, `agent.spawn` and a workflow step's
`context` field, as an object or a preset name.

## What each provider honours

Boite writes the guides and the rules itself, so every provider takes `guides`
and `rules`. Claude also leaves out the rest: instruction files through
`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, MCP servers through `strictMcpConfig` and an
empty server list, hooks through `disableAllHooks`, tools through the SDK's
`tools` list. The user's settings still load, so a per-model compaction window
or permission rule applies. Any other provider refuses a mode that drops
instruction files, MCP servers or hooks or names tools, with the field, rather
than start with them anyway.

The core has one mode of its own that no request asks for:
`TOOL_FREE_CONTEXT`, no instruction file, guide, MCP server, hook or built-in
tool (an empty `tools` list). The memory pass of a bot runs in it
([bots](bots.md)). Claude honours all of it; Codex and pi leave out what
their command line can (see the memory pass in [bots](bots.md)), the
thread's `plan` mode restricts the rest, and any tool such a thread asks
for is denied without a card.

A conversation with a mode carries `BOITE_CONTEXT=<label>` in its environment,
and `BOITE_GUIDES=0` when it drops guides: a hook that adds a guide of its own,
such as a shared instruction set, can check it and print nothing
([hooks](hooks.md#isolated-accounts)).

For Claude, a context mode's guides and instruction-file choices override
`BOITE_GUIDES` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS` from the provider profile.
Keeping a feature unsets its flag; dropping it forces the disabling value.
Conversations without a mode keep the profile values. A `full` request without
rules resolves to no mode.
