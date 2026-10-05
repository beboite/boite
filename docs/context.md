# The context meter

A thread's summary carries `context`, what the agent's last request held and
how much room the model gives it. The message bar draws a ring beside its send
controls; the percentage appears in the detail panel. When the agent compacts its
conversation mid-turn, the
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
| Muse | `session/compact`; a `noop` fails with the host's reason |
| pi | `compact` RPC, completed by its response, whose `estimatedTokensAfter` is pi's own estimate of what is left; Stop closes the process because prompt abort does not cancel this RPC |
| ACP | `/compact` only when the session advertised that command |
| agy | none: print mode refuses the CLI's interactive-only commands, so the core refuses the call and the control stays disabled |
| echo | `[compact]`, a deterministic test operation; the divider it draws says `manual`, while `[compact]` inside a prompt draws an `auto` one |

The control is disabled while a turn runs, before a native session exists, or
when the driver cannot compact. ACP must advertise the command. Compaction can make a provider
call and incur usage. The driver does not invent a post-compaction token count.
The protocol operations follow the [Codex app-server
documentation](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)
and [pi RPC
documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#compact).

`threads.capabilities` reports both implementation support and current
availability for steering, compaction, images, plans, pending approvals and
questions, native or seeded branching, session preparation and task observations.
It reads runtime metadata without starting a provider. The compaction menu
refreshes that answer when opened and when its session changes; older cores
retain the existing local checks. Mutation methods still validate availability
again when invoked.

## Automatic compaction

`Settings.autoCompact` is `{ tokens, moments }` or null, set by the owner under
Settings, Advanced, or on a phone under Settings, Automatic compaction. Null is
the default: the core never compacts by itself, and each
agent keeps its own mid-turn compaction, which this setting does not change.

`tokens` is the size the meter must read, between 1000 and 10 000 000, or null
for no size condition. It is a count and not a share of the window, so one
number covers every model: a model that never reaches it is never compacted,
and neither is an agent that reports no reading.

`moments` lists when the core checks. All three sit between two turns, because
the core cannot cut into a running one:

| Moment | When it fires | What it costs the user |
|---|---|---|
| `turn-end` | 2 s after an answer that left nothing running | a message sent right after waits for the compaction |
| `background` | 2 s after an answer that left a command or a monitor running | nothing: the agent was waiting anyway, and its wake opens right after |
| `cache-expiry` | 60 s before the thread's [prompt cache](prompt-cache.md) lapses, if the thread is still idle | nothing while the user answers within the cache lifetime |

`cache-expiry` tries to compact before the mapped lifetime ends, using the
current model and account. It can reduce the context a later prompt sends;
the timer does not guarantee a cache hit or a lower provider bill.

A finished turn arms one timer for its thread, at the first chosen moment that
applies. Any turn that opens before it fires disarms it, and the 2 s leave a
client's queued prompt, a wake and a held answer the time to open theirs. When
it fires the core checks again and compacts only when all of this holds:

- the turn ended `done`, and was not itself a compaction;
- the thread is idle, not archived, has a native session, and is neither a
  delegated agent's nor a resident agent's (those compact by `compactAfterTurns`);
- the reading is at or above `tokens`;
- the agent can compact, as for the manual button;
- no goal or loop is active, no delegated agent or workflow of the thread is
  at work, and no wake or held answer waits: each of those opens a turn by
  itself, and a compaction in flight would refuse it.

The compaction is the turn `threads.compact` schedules, with
`execution.automatic: true`. Its opening message is Boite's (`system`,
`Automatic compaction`), its divider says `auto`, and it sends no notification.
A threshold below what the agent keeps after compacting makes every turn end
compact again. The timers live in memory: a core restart drops them, and the
next finished turn arms a new one. The in-memory client implements `turn-end`
and the threshold only; it has no background work and no cache to wait on.

## Pending prompts, goals and loops

Enter during a running turn queues the message and its attachments. Each pending
message shows above the composer as a user bubble with a dashed outline. Arrow Up in
an empty composer takes the newest pending message out of the queue for editing;
clicking a pending message does the same. When the core reports a completed
tool boundary, the queue tries the driver's native steering operation, even
when another conversation is open. A driver that declines it retains input
for the next turn. Enter again in the emptied composer, or Send now under the bubbles,
submits it immediately without stopping the agent when the driver accepts it.
Permissions and blocking questions hold it until answered.
Messages already queued go together in their original order, with their
attachments and preview references. Messages added during that send wait for
the next delivery. A changed model or account keeps input for its next turn.
Escape stops the current turn. An Escape that closes something first (a popover, a menu, a
confirmation, the command palette, a rename field) only closes it, and the focus
goes back to where it was, or to the composer when that is gone, so a second
Escape is needed to stop. A failed send preserves the input for an explicit retry.
An unconfirmed provider submission is never retried automatically.
Edits and forks with live follow-ups use the fresh-session transfer rules below.

The core can open a turn by itself as the previous one ends: answers to an
asynchronous question that could not be steered in, or an agent resuming on its
own. A prompt that reaches the core in that moment, sent from the box or from
the queue, is refused with `reason: 'turn-in-flight'` and the thread's row
(`TurnInFlightData`). That is not a failure: the composer applies the row, puts
the prompt back at the head of the queue without pausing it or showing an error,
and sends it once that turn is over.

`/goal <objective>` starts work toward an objective. `/loop 2 <prompt>` runs two
consecutive iterations and stops. Counts range from 1 to 1000. A count written
as "2 iterations" or "2 itérations" in the prompt is also recognized.
`/loop 5m <prompt>` explicitly schedules repetition, with the delay counted
after each finished turn. Intervals use `s`, `m` or `h`, from one second to
24 hours. A loop without a count or interval is refused; there is no default timer.
Both commands belong to Boite and work with every driver. They carry
images and files on their first turn, subject to the provider's usual
attachment limits. Later iterations use the conversation history without
resending the uploads. Pending attachments survive a pause or core restart
before the first turn; replacing or removing the activity discards them.
Goals and loops can coexist with the agent's task list above the composer.
The compact overlay shows
the current task and progress. Only a click expands it; updates and disclosure
do not resize the timeline. An asynchronous question (`boite ask`, or Codex's
`delivery: "async"`) waits on top of that overlay with the same answer controls
as a blocking one. Several stack behind a pager ("2 of 3"), each keeping what
was picked while another shows, and a new one comes up open. The timeline keeps
one line where it was asked, and a click on it brings that question up. While
a question is open there, the timeline's bottom margin grows to the overlay's
height so the last answer stays above it; `tests/e2e/composer-activity.test.ts`
checks that at desktop and phone widths. Completed tasks and goals fade out on the next user
prompt, and newly reported work brings the task list back. Loop details show
the latest 50 iterations with their outcome and up to 4000 characters of result.

The core owns this work, so switching threads or closing a client does not
cancel it. A goal continues through scheduled turns until the agent emits
`[BOITE_GOAL_COMPLETE]` on its own line. The prompt requests that marker only
after verification. `[BOITE_GOAL_BLOCKED]`, an error or Escape pauses it.
A blocked goal is marked `blocked`: the bar asks for an answer, and the user's
next message, other than a native `/command`, resumes the goal once that reply's
turn ends. Escape also pauses a loop between runs. The activity bar has pause, resume,
remove and manual goal completion controls. A restarted core preserves the
activity but requires an explicit resume.

Goal instructions are assembled only when invoking a driver. The journal stores
the visible `/goal` or `/loop` message with its kind and iteration in the text
part. The UI also cleans up goal prompts saved by older cores and hides standalone
completion/blocker markers, including partial markers during streaming.

Tasks come from ACP plans, Codex plan notifications or successful task tools
such as Claude's TodoWrite and TaskCreate/TaskUpdate. An agent that reports no
tasks gets no invented task list. Pi uses the same successful-tool observation.
Task tracking is optional, including for goals. The agent guide and goal
instructions suggest a task list only when laying out steps helps the agent
and the user follow the work.

## Durable drafts

Unsent input is device-local, scoped to each core and data directory. New
conversations keep a draft per project; existing conversations keep their own
reply. IndexedDB uses strict transaction durability, with a synchronous text
backup in `localStorage` on each keystroke. The journal writes 800 ms after
typing pauses and at least every five seconds while it continues. Attachments,
failed backups, explicit flush, page hiding and navigation flush immediately.
A local core changing port retains the same drafts.

Queued input restores paused. The durable record includes attachments and page
references. Storage errors keep input in memory and show the reason. Reads and
writes have a three-second deadline; a failed read cannot overwrite unread
durable drafts. Once readable, the text backup merges with them. Missing
attachment bytes keep removable placeholders and their IDs through text edits;
removed IDs stay removed after recovery. Send waits for unreadable attachments
to become available or be explicitly removed.

Asynchronous creation and send retain the original core, thread and draft
identity. Accepted work does not select a thread after newer navigation or
consume the newer draft. Automatic merged-PR archive preserves local input and
pauses retained queues; manual archive and deletion clear input as requested.
See [archive boundaries](development.md#merged-pull-request-archives).

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

Retry receipts follow individual input messages: an edit preserves receipts for
kept prompts and invalidates those for removed prompts. An older receipt whose
input cannot be identified reports uncertain delivery instead of replaying it.

Sending an edit or a retry changes the screen before any round trip: the
replaced message and what follows it are hidden (`Threads.rewinding`), and the
new prompt shows in their place as a prompt on its way, while the core rewinds
the thread and restores files (`lib/composer-edit.ts`). The composer keeps an
edit if a turn starts before it is sent: the rewind refusal brings the hidden
messages back and returns the text to the box, still in edit mode, instead of
queuing a duplicate. Navigating while the rewind is pending still sends the
replacement to the original thread on its owning machine.

The core saves private file checkpoints before and after each conversation
turn, for every driver. Unchanged files reuse their saved hashes after checking
size, mode, inode and nanosecond modification/change timestamps, with metadata
retained for at most four thread folders. Editing restores the changes made by the removed
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

Every new fork retains its original thread and message boundary in `forkOrigin`,
including whether it preserved native context or copied visible history. The
fork shows that distinction and links back to its source on desktop and phone.
Send conclusions back submits an explicit summary of at most 4000 characters
through `threads.mergeBack`. It creates a coordination letter under the existing
permissions, not a file merge. A stable request ID returns the same receipt on
retry within the coordination retention period; a changed body is refused.
Deleted or archived sources cannot receive a return.

The agent must forget the removed part too. Each driver does it in one of two
ways, and the rewind result's `session` field says which one applied:

| Driver | Behaviour |
|---|---|
| Claude | Exact. Each turn records `checkpoint: { sessionId, entry }`, the uuid of the last transcript entry it wrote. The next turn resumes that session with `resumeSessionAt: entry` and `forkSession: true`, so the CLI keeps the transcript up to the cut under a new session id and the original transcript is never shortened. A rewind closes the warm process first. |
| Codex | Exact at a completed native turn boundary on the same account and session generation. A traced appserver calls `thread/fork` with the retained native turn ID as an inclusive boundary. Rewind prepares a new native session before restoring files and committing the journal cut. The source native transcript is unchanged. |
| ACP, Muse, pi, agy and echo | Seeded. The thread drops its native session. The next turn starts a fresh one carrying the kept history as bounded excerpts, the same [context transfer](model-switching.md#context-transfer) a change of account uses. |

Claude falls back to the seeded path in four cases: the kept turn left no
checkpoint (it ran before checkpoints existed, failed early, or was stopped
before the agent wrote anything), it ran on another account or provider, the
fork is placed in a worktree (the CLI files transcripts by folder), or the CLI
refuses the cut before writing anything, in which case the core retries the
turn once on a fresh seeded session. A fork cut in the middle of a turn is
also seeded, because the transcript has no entry at that point. No driver
resumes the whole old session after a rewind. Codex uses seeded history when no
matching completed checkpoint exists, including cuts inside a turn. Native fork
setup rechecks source ownership after asynchronous work and discards the new
native session on failure; failed setup cannot truncate the source. A successful
rewind keeps the newly forked Codex session, Claude's bounded resume checkpoint,
or no native session for the seeded path.

Codex native setup verifies the fork's last turn with a one-item, summary-only
`thread/turns/list` request. An older appserver that explicitly lacks this API
uses seeded history only after the temporary native fork is archived and its
setup process has exited. An incorrect boundary or uncertain cleanup refuses
the operation instead of adopting unverified context.

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

## Side questions

In an existing Claude conversation, `/btw <question>` asks a temporary question
while the main turn continues, including while it waits for a permission. The
answer appears beneath `/btw` and the question above the composer, and closes
with Escape or its close button.
Closing it or leaving the chat cancels an unfinished request. It works from
paired phones too. Attachments, preview references and message edits must be
finished or removed first. Offline side questions are refused rather than queued.

A fresh Claude SDK query uses the thread's account, model and supported effort,
with tools, MCP servers, settings loading and session persistence disabled. It
receives a snapshot of the journal's text and observed tool inputs and outputs,
including streamed output; private reasoning and image payloads stay out.
The snapshot also includes a tool's status and its input JSON while that input is
still streaming, so a request sees the latest observed call before it finishes.
The snapshot retains up to 512 messages and the most recent 120,000 characters,
and says when earlier context was omitted. This is a separate request, so native prompt cache reuse
is not guaranteed. Neither the question nor its answer enters the conversation,
changes its native session or updates the main context meter.

The echo driver supplies offline test answers. Other protocols currently refuse
side questions by provider name, and their slash menu omits `/btw`. Merely
forwarding `/btw` to a provider would queue it as a normal turn instead of
providing a temporary answer.

`threads.btw` returns admission immediately; `thread.btw` delivers the answer or
error to subscribed clients with its request ID. Inference must not occupy the
serialized WebSocket request queue. One side request runs per thread; dismissal
cancels only its request ID. Archive and core shutdown cancel pending requests.

After a successful answer, the compact "Fork" button creates and opens
an idle fork. It carries exactly the bounded text snapshot sent to the side
request, followed by its question and answer. Later output from the original
thread stays there. The fork uses a fresh native session, the original selection
and folder, and normal tool permissions on its next turn. It does not create a
worktree or automatically run another turn. Copied usage and checkpoints are
cleared. Closing the answer, replacing it or leaving the chat discards its fork
context. Completed answers expire after ten minutes, and the core keeps at most
64 of them in memory; nothing is persisted until the user forks.
