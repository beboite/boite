# The context meter

A thread's summary carries `context`, what the agent's last request held and
how much room the model gives it. The message bar draws a ring beside its send
controls; the percentage appears in the detail panel. When the agent compacts its conversation mid-turn, the
timeline gets a divider saying how many tokens went. Both come from the agent
itself: the core never estimates a context size, and a provider whose protocol
says nothing shows an unfilled ring. Hovering, focusing or tapping the ring
opens exact counts and a separate manual compaction button. The panel opens
above the message bar, using the available height, and scrolls on short screens.
Behind the
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
  With a window the ring shows how full it is and the detail panel includes a
  percentage; without one the ring stays unfilled and the panel shows the count.
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
| pi | `contextUsage.tokens` of `get_session_stats`, read once after each turn; nothing right after a compaction, where pi reports null until its next answer | `contextUsage.contextWindow` | `compaction_end` of an automatic compaction (`threshold` or `overflow`), with `tokensBefore` and `estimatedTokensAfter`; the manual `compact` response, with the same two |
| OpenCode, Antigravity, Grok | `used` in the last ACP `usage_update` of the turn, once at the end | `size` when above zero | none |

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
| pi | `compact` RPC, completed by its response, whose `estimatedTokensAfter` is pi's own estimate of what is left; Stop closes the process because prompt abort does not cancel this RPC |
| ACP | `/compact` only when the session advertised that command |
| agy | none: print mode refuses the CLI's interactive-only commands, so the core refuses the call and the control stays disabled |
| echo | `[compact]`, a deterministic test operation; the divider it draws says `manual`, while `[compact]` inside a prompt draws an `auto` one |

The control is disabled while a turn runs, before a native session exists, or
when an ACP agent has not advertised support. Compaction can make a provider
call and incur usage. The driver does not invent a post-compaction token count.
The protocol operations follow the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)
and [pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#compact).

## Editing a message and forking

`threads.rewind { threadId, messageId }` removes a user message and everything
after it, then returns the new thread with the removed prompt, attachments and
element references for the composer. It refuses a thread with a turn running or
queued (`reason: 'turn-in-flight'`) and any message that is not a user message
of that thread (`field: 'messageId'`). The journal keeps a `thread.rewound`
event naming every removed message and turn. The projection drops those
messages, so `threads.get` and `messages.list` no longer return them. The turn
rows stay, so the usage history still counts what they spent. Every subscribed
client gets `message.truncated` and drops the message and what follows it.

The composer keeps an edit if a turn starts before it is sent: the rewind
refusal leaves its text intact instead of queuing a duplicate. Navigating while
the rewind is pending still sends the replacement to the original thread on
its owning machine.

The core saves private file checkpoints before and after each conversation
turn, for every driver. Editing restores the changes made by the removed
turns before truncating their messages. It preserves unrelated files and
refuses a conflict with outside edits before changing either files or history.
Git projects include tracked files and non-ignored untracked files; HEAD and
the index stay unchanged. Other projects use a bounded file walk, excluding
`.git`, `.boite`, `.agents`, `node_modules`, `AGENTS.md` and `.env` files.
Backups include binary content, deletions, creations, permissions and symlinks,
stored under the core data directory with content deduplicated per thread.
They survive restarts and leave with a permanently removed project or thread.

Each snapshot is limited to 20000 files, 16 MiB per file and 128 MiB total.
Old turns without backups, overlapping turns in the same workspace, a cut
inside a running turn and incomplete snapshots cannot restore code. The rewind
answers `files: { status, count, reason? }`; `status` is `restored`, `unchanged`
or `unavailable`. The client shows a warning for unavailable backups rather
than claiming that the code was restored.

`threads.fork { threadId, messageId, worktree? }` copies the history up to and
including any finished message into a new thread titled after the source with
` (fork)`. The source is left as it was. `worktree: true` makes the worktree
the way `threads.create` does, from the project's HEAD. The source thread's
branch and uncommitted changes are not copied.

The agent must forget the removed part too. Each driver does it in one of two
ways, and the rewind result's `session` field says which one applied:

| Driver | Behaviour |
|---|---|
| Claude | Exact. Each turn records `checkpoint: { sessionId, entry }`, the uuid of the last transcript entry it wrote. The next turn resumes that session with `resumeSessionAt: entry` and `forkSession: true`, so the CLI keeps the transcript up to the cut under a new session id and the original transcript is never shortened. A rewind closes the warm process first. |
| Every other driver (Codex, ACP agents, pi, agy, grok, echo and the rest) | Seeded. The thread drops its native session. The next turn starts a fresh one carrying the kept history as bounded excerpts, the same [context transfer](model-switching.md#context-transfer) a change of account uses. |

Claude falls back to the seeded path in four cases: the kept turn left no
checkpoint (it ran before checkpoints existed, failed early, or was stopped
before the agent wrote anything), it ran on another account or provider, the
fork is placed in a worktree (the CLI files transcripts by folder), or the CLI
refuses the cut before writing anything, in which case the core retries the
turn once on a fresh seeded session. A fork cut in the middle of a turn is
also seeded, because the transcript has no entry at that point. No driver
resumes the whole old session after a rewind: the session id the thread keeps
is either the checkpoint's own, always resumed with `forkSession`, or none.

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
