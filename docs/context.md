# The context meter

A thread's summary carries `context`, what the agent's last request held and
how much room the model gives it, and the header draws it as a ring with the
percentage beside it. When the agent compacts its conversation mid-turn, the
timeline gets a divider saying how many tokens went. Both come from the agent
itself: the core never estimates a context size, and a provider whose protocol
says nothing leaves the meter off.

## What is measured

`ThreadSummary.context` is `{ tokens, window, at }` or null:

- `tokens` is what the last API request of the last turn carried: its input
  tokens, plus what it read from the prompt cache and what it wrote there.
  That sum is the size of the conversation as the model saw it, which is what
  the next turn starts from. It is not the turn's total usage: a turn of ten
  tool calls makes ten requests, and only the last one is the reading.
- `window` is the model's context window when the agent names it, else null.
  With a window the header shows a percentage and the ring; without one it
  shows the count alone.
- `at` is when the core wrote it.

The core writes the meter at the end of every turn that reports one, through
`thread.updated`, and keeps it in the journal (`threads.context`, schema 7),
so a restart shows the last reading. A driver that hands a number that is not
finite or below zero writes nothing.

## Where each agent's reading comes from

| Provider | The reading | The window | The divider |
|---|---|---|---|
| Claude | `usage` on each `assistant` message of the SDK stream, the last one wins | `modelUsage[<model>].contextWindow` on the result message, the thread's model first, else the one model the turn ran on | the `compact_boundary` system message, with `pre_tokens` and `post_tokens` |
| echo | 100 plus one token per character of the prompt | 2000 | `[compact]` in the prompt draws one, 1800 to 300 tokens, and lowers the reading to 300 |
| Codex, OpenCode, Antigravity, Grok, pi | none yet | | |

The ACP agents send compaction updates and Codex sends token counts on its
own protocol; neither is read today, so those threads wear no meter.

## The divider

A compaction is a message part, `{ type: 'compaction', trigger, preTokens,
postTokens }`, written into the assistant message at the point the agent
compacted, so it sits between the text before and the text after. `trigger`
is `auto` or `manual`; `postTokens` is null when the agent did not say what
was left. An imported Claude Code session does not carry its compactions:
the transcript reader keeps prompts, answers and tool calls only.

## The colours

The ring is the muted foreground under three quarters of the window, the
foreground from there, and the danger colour past nine tenths, when the next
compaction is close. The tooltip has the exact counts.
