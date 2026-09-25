# The context meter

A thread's summary carries `context`, what the agent's last request held and
how much room the model gives it, and the header draws it as a ring with the
percentage beside it. When the agent compacts its conversation mid-turn, the
timeline gets a divider saying how many tokens went. Both come from the agent
itself: the core never estimates a context size, and a provider whose protocol
says nothing shows an unfilled ring. Hovering, focusing or tapping the ring
opens exact counts and a separate manual compaction button. Behind the
`prompt-cache` experiment the meter also carries the
[prompt cache timer](prompt-cache.md).

## What is measured

`ThreadSummary.context` is `{ tokens, window, at, breakdown? }` or null:

- `tokens` is what the last API request of the last turn carried: its input
  tokens, plus what it read from the prompt cache and what it wrote there.
  That sum is the size of the conversation as the model saw it, which is what
  the next turn starts from. It is not the turn's total usage: a turn of ten
  tool calls makes ten requests, and only the last one is the reading.
- `window` is the model's context window when the agent names it, else null.
  With a window the header shows a percentage and the ring; without one it
  shows the count alone.
- `at` is when the core wrote it.
- `breakdown`, when available, contains disjoint input, cached-input and output
  counts. The UI displays a single segmented bar and exact counts. Providers
  without this detail show used and available capacity only.

The core writes the meter at the end of every turn that reports one, through
`thread.updated`, and keeps it in the journal (`threads.context`, schema 7),
so a restart shows the last reading. A driver that hands a number that is not
finite or below zero writes nothing.

## Where each agent's reading comes from

| Provider | The reading | The window | The divider |
|---|---|---|---|
| Claude | `usage` on each `assistant` message of the SDK stream, the last one wins | `modelUsage[<model>].contextWindow` on the result message, the thread's model first, else the one model the turn ran on | the `compact_boundary` system message, with `pre_tokens` and `post_tokens` |
| echo | 100 plus one token per character of the prompt | 2000 | `[compact]` in the prompt draws one, 1800 to 300 tokens, and lowers the reading to 300 |
| Codex | `tokenUsage.last.totalTokens` in `thread/tokenUsage/updated` | `tokenUsage.modelContextWindow` when reported | completed `contextCompaction` items |
| Muse Code | `usedTokens` in `session/contextUsage` | `windowTokens` when reported | completed `compaction` items, with `tokensBefore` and `tokensAfter` |
| Antigravity CLI | the last `agent_response` step's `usage` in the turn, input plus cache reads plus output, once at the end | not reported | none, compaction is refused |
| OpenCode, Antigravity, Grok | `used` in the last ACP `usage_update` of the turn, once at the end | `size` when above zero | none |
| pi | none yet | | pi's manual compaction response |

Codex's count includes the last request's output. When `totalTokens` is absent,
the driver adds the reported input and output counts. Context notifications
arriving after a turn completes are retained while its session stays warm.
Cached input is a subset of input, so the segmented bar subtracts it from the
uncached input segment. Counts remain the last
reported reading, not a prediction of the next request. An ACP turn whose
agent sent no `usage_update` leaves the meter as it was; an unknown reading
never becomes a guessed percentage.

## Manual compaction

`threads.compact` creates a scheduled turn with `execution.operation: 'compact'`.
It keeps the native session and visible history, freezes the selected account,
and rejects missing sessions, busy threads and stale selection revisions.
The existing Stop action cancels the maintenance turn. Paired devices may call it.

| Driver | Native operation |
|---|---|
| Claude | `/compact` through the SDK prompt, without prompt-only reasoning suffixes |
| Codex | `thread/compact/start`, completed by normal turn notifications |
| pi | `compact` RPC, completed by its response; Stop closes the process because prompt abort does not cancel this RPC |
| ACP | `/compact` only when the session advertised that command |
| agy | none: print mode refuses the CLI's interactive-only commands, so the core refuses the call and the control stays disabled |
| echo | `[compact]`, a deterministic test operation |

The control is disabled while a turn runs, before a native session exists, or
when an ACP agent has not advertised support. Compaction can make a provider
call and incur usage. The driver does not invent a post-compaction token count.
The protocol operations follow the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)
and [pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#compact).

## The divider

A compaction is a message part, `{ type: 'compaction', trigger, preTokens,
postTokens }`, written into the assistant message at the point the agent
compacted, so it sits between the text before and the text after. `trigger`
is `auto` or `manual`; `preTokens` is null when no prior count is known,
and `postTokens` is null when the agent did not say what
was left. An imported Claude Code session does not carry its compactions:
the transcript reader keeps prompts, answers and tool calls only.

## The colours

The filled portion always uses the chosen accent, from zero to full capacity.
The smaller ring opens details; it never starts compaction. The popup uses
accent for uncached input, green for cached input, yellow for output and a
neutral remainder for free capacity. These are provider token categories,
not an estimated split between system instructions, files and tools.
