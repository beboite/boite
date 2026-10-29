# The context meter

A thread's summary carries `context`, what the agent's last request held and
how much room the model gives it. The message bar draws a ring beside its send
controls; the percentage appears in the detail panel. When the agent compacts its
conversation mid-turn, the
timeline gets a divider saying how many tokens went. Both come from the agent
itself: the core never estimates a context size. The ring stays unfilled when
there is no usage reading, or when neither a model window nor a compaction
threshold is known. Hovering, focusing or tapping the ring
opens exact counts and a separate manual compaction button. The panel opens
above the message bar, using the available height, and scrolls on short screens.
Behind the
`prompt-cache` experiment the meter also carries the
[prompt cache timer](prompt-cache.md).

When automatic compaction has a token threshold, the ring, percentage, bar and
remaining capacity use that threshold, capped at the model's reported window.
The popup shows the exact usage, a bar and tokens remaining before compaction
or the model limit. Its info button reveals the model's full capacity when the
threshold replaces it, the token breakdown when reported and the reading time.
A known threshold also supplies a limit
when the agent reports no window. Disabling automatic compaction or choosing no
size condition restores the model window. The reading itself is unchanged;
compaction still waits for a selected moment, as described below.

## What is measured

`ThreadSummary.context` is `{ tokens, window, at, breakdown? }` or null:

- `tokens` is what the last API request of the last turn carried: its input
  tokens, plus what it read from the prompt cache and what it wrote there.
  That sum is the size of the conversation as the model saw it, which is what
  the next turn starts from. It is not the turn's total usage: a turn of ten
  tool calls makes ten requests, and only the last one is the reading.
- `window` is the model's context window when the agent names it, else null.
  The UI treats nonpositive windows as unknown. The ring and detail panel use
  the lower of the window and the configured compaction threshold. Without a
  window, a threshold still supplies the limit; with neither, the ring stays
  unfilled and the panel shows only the count.
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
Settings, Advanced. A phone connected as owner has an Automatic compaction row
in its machine settings and can also open the same card through a settings
link ([phone settings](phone.md#settings-on-a-phone)). Null is
the default: each agent keeps its own compaction behaviour.

`Settings.compactionByType` optionally overrides the complete policy for
`agent` (regular conversation), `subagent` (a thread with `parentThreadId`)
or `bot` (a resident thread with `agentSessionId`). A child of a bot is a
subagent. Each override contains `{ autoCompact, backgroundCompaction }`; an
absent target follows the current common settings, while `autoCompact: null`
disables Boite's automatic triggers and restores the driver's native policy
for that target. Removing a target restores live inheritance, without copying
thresholds. The override map replaces the previous map on `settings.set` and
follows the group's settings home alongside `autoCompact`. The common
`backgroundCompaction` experiment stays local to its machine.

All drivers resolve the policy at preparation and before each turn. Idle
compaction and background copies use the same resolver. A policy change
cancels a copy made under the previous policy; OpenCode 2 takes the resolved
background switch in its process environment.

`tokens` is an independent limit, between 1000 and 10 000 000, or null to leave
only the selected idle moments. Native drivers apply it at safe tool boundaries
where their protocol supports it. The core also checks the last reported
reading after a turn: reaching the limit schedules compaction after 2 s,
regardless of the selected moments. The count belongs to the owner; Boite does
not substitute a per-model threshold.

| Driver | Token limit during a turn |
|---|---|
| Claude | Measures the native output and compaction reserves locally, opens with a calibrated window and verifies the exact threshold before sending the prompt. An unsupported or clamped window keeps native policy and the between-turn fallback. |
| Codex | Sends the owner's count as `model_auto_compact_token_limit` on thread start and resume; Codex performs compaction in its own loop. |
| Muse, pi, ACP | Keep their native in-turn policy; Boite checks its limit between turns because these protocols expose no exact token-limit setter. |
| echo | Checks between turns only. |

Changing the limit during a running Claude or Codex turn applies before the
next prompt. Claude defers reopening while its native background work still
holds the query. Boite never interrupts and restarts a running turn to compact it.
Claude Code 2.1.310 accepts the live window flag without updating its active
window, so a changed limit reopens the session between turns. Its summary
context-control request is local and makes no provider token-count call.

`cache-expiry` is independent of this limit: it can compact a smaller context
before the cache lapses. The optional `turn-end` and `background` moments keep
their size condition when a token limit is set; without one, they compact at
each selected moment.

`moments` lists when the core checks. All three sit between two turns, because
the core cannot cut into a running one:

| Moment | When it fires | What it costs the user |
|---|---|---|
| `turn-end` | 2 s after an answer that left nothing running | a message sent right after waits for the compaction |
| `background` | 2 s after an answer that left a command or a monitor running | nothing: the agent was waiting anyway, and its wake opens right after |
| `cache-expiry` | 60 s before the thread's [prompt cache](prompt-cache.md) lapses, if the thread is still idle | nothing while the user answers within the cache lifetime |

`cache-expiry` tries to compact before the mapped lifetime ends, using the
current model and account. It can reduce the context a later prompt sends;
the timer does not guarantee a cache hit or a lower provider bill. A planned
compaction takes precedence over a keepalive ping, which would refresh the
cache and postpone compaction again.

A finished turn arms one timer for its thread, for the token limit or the first
chosen moment that applies. Any turn that opens before it fires disarms it, and the 2 s leave a
client's queued prompt, a wake and a held answer the time to open theirs. When
it fires the core checks again and compacts only when all of this holds:

- the turn ended `done`, and was not itself a compaction;
- the thread is idle, unarchived and on a native session, whether it is a
  regular conversation, delegated child or resident bot;
- the token limit was reached, or a selected idle moment applies;
- the agent can compact, as for the manual button;
- no goal or loop is active and no wake, held answer or delegation letter
  already waits to open the next conversation turn.

Children and workflows can keep working during an idle parent's compaction.
Their results stay in the inbox until the compaction ends; they never steer
its native command or enter a compaction tool hook as additional context.
A child's internal compaction neither sends a final result to its parent nor
replaces the last task answer. A bot's compaction does not finish routines,
create memory passes or notify other bots as a task result.

The compaction is the turn `threads.compact` schedules, with
`execution.automatic: true`. Its opening message is Boite's (`system`,
`Automatic compaction`), its divider says `auto`, and it sends no notification.
A threshold below what the agent keeps after compacting makes every turn end
compact again. The timers live in memory: a core restart drops them, and the
next finished turn arms a new one.

A thread can sit idle above its token limit: it went quiet before the owner
lowered the limit, or a restart dropped its timer. When a client shows it
(`threads.focus`), the core compacts it at once under the same checks, while
the user reads and types, instead of letting the next prompt wait for the
agent's own blocking compaction. A background copy cannot help there, since
one starts only below the limit. As after a turn, a last turn that stopped or
failed is left to the user (a cache keepalive ping does not count as the last
turn), and a compaction never chains into another: when
the last turn is one, even still over the limit, a look starts nothing. An ACP agent names its `compact` command only once its session is
prepared, so that announcement, on a shown thread, is checked the same way. A prompt that crosses the
limit by itself is compacted by the agent before it is sent, as above. The in-memory client implements `turn-end`
and the independent token limit after a turn, not when a thread is shown; it
has no background work or prompt cache.

When a merged PR moves a conversation to Done, its last prompt can finish,
but a compaction turn is stopped. If the provider announces native compaction
after Done, that turn is stopped too. The history already written is kept.

### Background compaction

`Settings.backgroundCompaction` is an experiment, off by default, that the
owner turns on under Settings, Experiments, for the machine picked above the
card, the one that runs the thread (an agent asks with
`boite settings request backgroundCompaction true --why "..."`). It works
with the token limit above and does nothing without one. Like `deviceStream`,
it stays on its machine: the group's settings do not carry it.

When a finished turn leaves the context between 85% of the limit (and at least
64 000 tokens) and the limit, the core forks the thread's native session at
the end of that turn and runs `/compact` on the fork, outside the thread
(`threads/background-compact.ts`). The thread stays free: the user and its
agents keep working on the original session meanwhile.

| Driver | The copy |
|---|---|
| Claude | Resumes at the turn's checkpoint with `resumeSessionAt` and `forkSession`, then compacts. |
| Codex | `forkSession` at the turn's checkpoint, then compacts the fork. |
| echo | Names the fork after the turn. |
| OpenCode 2 | No copy: the setting turns on OpenCode's own `experimental.background_compaction` in `OPENCODE_CONFIG_CONTENT`, for the processes started afterwards. |
| OpenCode 1, Muse, pi, other ACP | None: the compaction above runs as before. |

At the first pause after the copy finished, under the same conditions as the
timer above and after the same 2 s, the thread takes the compacted session: a
new session generation, no model call, its process released, and a divider
marked `background: true` (`in the background`). It does not wait for the
limit, because a session changes only between turns and the agents compact by
themselves, blocking, as soon as a turn crosses it. The thread's next prompt
carries what was said after the fork point in a `<recent-history>` block
before the request (`tailInput` in `continuation.ts`); the
`compaction-tail:<thread>` marker clears once a turn that carried it ends
`done`.

The copy is dropped, and the compaction above runs at the limit as usual,
when:

- the thread changed session, generation, agent, account, model or folder,
  was rewound, archived or compacted, or its context shrank because the agent
  compacted by itself;
- the thread grew by more than 30 000 tokens, or a quarter of the limit, since
  the copy started;
- background work is running at the swap, since taking the new session closes
  the process that runs it;
- the copy failed, named no new session or did not compact; after two failures
  in a row the thread stops trying until its next swap or a restart. A copy
  still running after 5 minutes is stopped;
- the effective policy changed, including turning the setting off.

A thread that reaches the limit while a matching copy still runs waits for it
rather than compacting. Regular conversations, delegated children and resident
bots use the policy for their own type. Incognito threads and a session
waiting to resume at an entry take no copy; their token limit still applies.

Limits of the experiment: copies are held in memory, so a restart forgets them
(the tail marker is persisted). A copy runs outside the scheduler's account
slots and its usage is recorded on no turn. An unused Claude copy's transcript
is removed in an account Boite isolated; Codex keeps its unused forks. The
in-memory client stores the setting but makes no copy.

## Turns a provider refused

A turn refused because the model was at capacity tries again by itself, and a
thread stopped by a usage limit can resume once the window resets (opt-in).
Both, their prompts and their guards are in
[usage](usage.md#when-a-provider-refuses-a-turn).

## Pending prompts, goals and loops

Enter during a running turn queues the message and its attachments; where the
primary pointer is coarse, Enter writes a new line instead and the send button
takes its place ([phone](phone.md)). Each pending
message shows above the composer as a user bubble with a dashed outline. Arrow Up in
an empty composer takes the newest pending message out of the queue for editing;
clicking a pending message does the same. When the core reports a completed
tool boundary, the queue tries the driver's native steering operation, even
when another conversation is open. A driver that declines it retains input
for the next turn. Enter again in the emptied composer (not where the primary
pointer is coarse), or Send now under the bubbles, submits it immediately without stopping the agent when the driver accepts it.
Permissions and blocking questions hold it until answered.
Messages already queued go together in their original order, with their
attachments and preview references. While that batch goes out its bubbles stay
drawn and cannot be removed or taken back for editing; a declined attempt
leaves them in place, editable again until the next boundary. Messages added
during that send wait for
the next delivery. A changed model or account keeps input for its next turn.
Escape stops the current turn. An Escape that closes something first (a popover, a menu, a
confirmation, the command palette, a rename field) only closes it, and the focus
goes back to where it was, or to the composer when that is gone, so a second
Escape is needed to stop. In the composer while it answers an agent's question,
Escape stops nothing: a thread waiting on a question opens with the focus there,
and stopping the turn would throw the question away. Skip and the stop button
still end it. A failed send preserves the input for an explicit retry.
An unconfirmed provider submission is never retried automatically.

Stopping a submitted message keeps its text and attachments in the next user
request's context, even if Stop landed while queued or before the native session
started. An existing native session receives stopped user messages and accepted
follow-ups in order, until a user turn completes. This survives a core restart
without adding messages to the timeline or starting work by itself. Native
commands and automatic turns do not consume this context. Historical images
beyond what the current request leaves of one turn's 50 images and 10 MB
remain available as local files, oldest first. A fresh
native session receives the conversation's journal history instead.

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
was picked while another shows. The oldest pending question opens first; new
arrivals keep the current question and its folded state. Answering or skipping
the current question brings up the oldest remaining one. The timeline keeps
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
With the Reviewed goals experiment, `/goal2` turns that marker into a claim
that a fresh reviewer conversation must pass, and keeps a checklist of the
user's requests that each turn hears ([experiments](experiments.md#the-checklist)).
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

The owning core stores unsent input and pending prompts in SQLite. Owner and
paired-device clients share new-conversation drafts and each thread's reply
through revised `composer` records. Compare-and-swap rejects stale writes;
tombstones keep a cleared record from reappearing after reconnect. Concurrent
text is retained as a separate draft instead of overwritten.

Typing sends only the changed record, coalesced over 400 ms. Attachments upload
once as content-addressed assets; records and broadcasts carry their IDs and
metadata. Other devices fetch bytes when that composer opens. The core validates
metadata and byte limits without reading attachment bodies on each text edit.

IndexedDB remains the device's offline cache and migration source, with strict
transaction durability and a synchronous text backup in `localStorage` on each
keystroke. The journal writes 800 ms after
typing pauses and at least every five seconds while it continues. Attachments,
failed backups, explicit flush, page hiding and navigation flush immediately.
A local core changing port retains the same drafts.

Accepted queues run on the core without an open client, including after restart
when delivery is known to be safe. Unconfirmed provider submissions stay held.
Provider, account, model, effort and speed stay captured; permission modes follow
the thread's current selection, including for queued input.
Queued commands retain the enqueueing app's experiments, so a reviewed goal
keeps its meaning after a restart or another device changes its preferences.
A restored ordinary queue whose previous acceptance cannot be proved stays
paused until explicitly resumed.
Input written while the core is unreachable stays on the device until a client
reconnects and synchronizes it. Incognito input stays in client memory and uses
the client delivery path; older cores retain device-local persistence.

Undoable deletion retains core input. Permanent deletion erases reply records
and linked delivery receipts, and reconnecting clients discard their stale
reply caches. Delivered draft launches retain a deduplication receipt with no
thread link or content fingerprint, so an old cache cannot launch them again.

The durable record includes attachments and page references. Storage errors
keep input in memory and show the reason. Reads and
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
size, mode, inode and nanosecond modification/change timestamps. That metadata
is kept per workspace folder, shared by the threads working in it, for at most
100000 files in total; the least recently used folder goes first. Editing restores the changes made by the removed
turns before truncating their messages. It preserves unrelated files and
refuses a conflict with outside edits before changing either files or history.
Git projects include tracked files and non-ignored untracked files; HEAD and
the index stay unchanged. Other projects use a bounded file walk, excluding
`.git`, `.boite`, `.agents`, `node_modules`, `AGENTS.md` and `.env` files.
Backups include binary content, deletions, creations, permissions and symlinks,
stored under the core data directory. Each content is stored once in
`checkpoints/objects/<first two hex digits>/<sha256>` and hard-linked into the
folder of every thread that saved it, so each thread folder can rewind on its
own. The name is the SHA-256 of the original bytes; the file holds a zstd
frame (level 3) when that saves at least a tenth, the raw bytes otherwise.
Readers hash the stored bytes first, so a raw blob, a `.zst` file kept raw
included, is never expanded; a blob that starts with the zstd magic and does
not match decodes to at most 16 MiB, the largest file a checkpoint backs, and
its result is hashed. Turn manifests (`<turn id>.json`) are zstd
frames too, and plain JSON from older cores still reads. A snapshot links a
shared frame of the expected size after checking its first four bytes; a raw
shared blob is compared byte for byte. A file system without hard links gets
a private copy per thread.

A background pass three minutes after startup moves folders saved before the
shared store or before compression to that form, in ticks of at most 500
blobs and manifests and 16 MiB read, waiting while a snapshot runs, and records its last
folder in the `checkpoints:stored-through` setting, `true` once done. A
private copy whose content is in the store becomes a link to it; one the
store lacks is checked against its name, compressed and moved in; a file
that does not hash to its name is left alone and counted. Checkpoints are
kept for the newest 50 turns of each thread (`KEEP_TURNS`) and for none of a
thread archived or done more than 7 days ago (`IDLE_THREAD_MS`): the pass
applies both every 6 hours, and the end of a turn trims a thread once it holds
60 manifests. A rewind past what is kept answers `unavailable`, "file
checkpoints are kept for the newest 50 turns of a conversation". The same
pass, and the removal of a thread's checkpoints, then deletes the shared
files no thread links to any more.
They survive restarts and leave with a permanently removed project or thread.

Each snapshot is limited to 20000 files and 128 MiB of saved content. A file
above 16 MiB is not copied: the snapshot keeps only its metadata, so a change
by the removed turns makes the whole restore unavailable and nothing is
restored; an unchanged one does not get in the way. Old turns without backups,
overlapping turns in the same workspace, a cut inside a running turn and
incomplete snapshots cannot restore code. Two folders overlap when one holds
the other and the outer snapshot would list a file of the inner one: git
lists a repository or worktree of its own (`.boite/worktrees/*`) as one
directory entry, unless the outer index tracks its files; a plain walk lists
all but the skipped folders. An edit made while another turn still works in an
overlapping folder, such as a sub-agent winding down after a Stop, rewinds the
messages and leaves every file as it is, with `busy: true`. The rewind
answers `files: { status, count, reason?, busy? }`; `status` is `restored`, `unchanged`
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
| Codex | Exact at a completed native turn boundary on the same account and session generation. A traced appserver, started without plugins or connectors, calls `thread/fork` with the retained native turn ID as an inclusive boundary and every MCP server turned off for that call only. Rewind prepares a new native session before restoring files and committing the journal cut. The source native transcript is unchanged. |
| ACP, Muse, pi and echo | Seeded. The thread drops its native session. The next turn starts a fresh one carrying the kept history as bounded excerpts, the same [context transfer](model-switching.md#context-transfer) a change of account uses. |

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

## What the agent sees

On a Claude thread the context popup has a "What the agent sees" button. It
opens the system prompt and the tool definitions of the thread's last API
request, with that request's model, effort, thinking type, output limit,
betas, Claude Code version and time. System blocks keep their order and
expand to their text; tools are sorted largest first. Sizes are characters.
The token figure is the characters of both divided by four, labelled as an
estimate: it is not the provider's count and leaves out the messages.

`threads.agentShape { threadId }` reads it, owner-only, and refuses a thread
whose provider is not on the `claude-sdk` protocol with `field: 'providerId'`.
The source is the session transcript, at
`<config dir>/projects/<cwd, every non-alphanumeric character as ->/<sessionId>.jsonl`,
the config directory being the account's isolation directory, else the
provider's default (`CLAUDE_CONFIG_DIR`, then `~/.claude`), as
[imports](../packages/core/src/imports.ts) finds it. Claude Code 2.1.300 and
later write an `api-request-shape` record per distinct system and tool set and
an `api-request` record per request naming its shape by hash
(`packages/core/src/imports/claude-shape.ts`). The core reads the file
backwards in 1 MiB chunks, decodes only lines carrying one of the two record
types, skips lines above 8 MiB, and stops at the shape the last request names.
The answer for a file is reused while its size and modification time hold.

`status` explains an empty answer: `no-session` before the first turn,
`no-transcript` when the file is gone, `unrecorded` when the CLI wrote no
request shape (versions before 2.1.300). Each system block's text is cut at
`AGENT_SHAPE_BLOCK_MAX` (32 000 characters) and all blocks together at
`AGENT_SHAPE_TEXT_BUDGET` (200 000); a cut block says so and keeps its full
size. At most `AGENT_SHAPE_ITEMS_MAX` (256) blocks and tools are listed; the
rest are counted in the totals and in `omitted`. The in-memory client answers
with a fixture shape written for it.

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
