# Persistent agents

Agents is a page beside chat, behind the Resident agents switch in Settings >
Experiments ([experiments](experiments.md)). An identity keeps its instructions, memberships
and scoped memory when its provider, account or model changes. Pausing or
archiving an identity stops its current execution and prevents new work; the
stopped work item says the agent was paused or archived.

## The page

The page is a chat. Its list is the thread list's own column: both draw
`RailFrame` (width, resize handle, the title bar's fold, the foot ending on the
limits and Settings) and `RailHead` (the Threads and Agents switch and one row
of tools), so switching between them changes only the rows and the tools.
The column and the card beside it stay in place and only the card's content
fades in; the column slides in from the window's edge only when it unfolds
(`tests/e2e/agents.test.ts` reads both on every frame). Under it, one card
holds every conversation, agents and groups together, newest first. A row
shows the agent's picture, its name, an incoming unread count on the right
(or the last activity time when read), and the last thing said under it.
Interrupted work and old failures do not replace that count with "Needs you".
The avatar keeps a waiting mark for a live question or pending decision.
On desktop, the foot adds the engine settings for the owner; a phone draws no foot.

A conversation is the whole page, drawn with the thread's bubbles and the
thread's own composer (`Composer.svelte` with a `ComposerTarget`,
`lib/composer-target.ts`): attachments by the button, a paste or a drop,
dictation, ArrowUp recall, undo, the stash chord, and Stop or Escape while the
agent works, which cancels that work. Model, effort and permissions stay in
the agent's Settings pane. A group shows its recipients in the composer.
The worktree chip, the queue and the slash and mention menus
stay out: a message never queues. Each prompt is the thread's own
`UserMessage`: copy button, send time, two ticks (received, taken into a turn)
and its pictures as thumbnails that open in the viewer. A received message
keeps its receipt if execution fails, pauses or is cancelled. Paused work,
including an execution stopped at its configured time limit, shows the reason
and Resume in the conversation. Delivery failures remain visible only for
recipients that never took the message into a turn. The user asks, the
agent answers in its bubble, works (three dots in a bubble) and comes back with
the result, in words, with the pictures and files it attached under the
bubble. What the user attaches goes with `agents.message.send`: the message
keeps each file's name, type and size, the bytes wait in the core's settings
(`agents:attachments:<message>`) and reach every recipient's turn, and leave
once each delivery is processed, cancelled or over the limit. The first turn
that takes them sets each attachment's `source` (that turn's prompt in the
agent's thread and the part's index); the conversation reads the thumbnails
and originals there with `messages.attachment`, and shows names and sizes
until then. An agent's own messages carry none. The agent's own thread, where its tools and code
run, stays one step away: See its work in the header's menu opens it. A
planned task's result is labelled with the task's name. A question the agent
asks stands in the conversation with its answers to pick and a free answer. A group names who speaks and shows only deliveries that failed. The
header keeps the picture, the name and how the agent stands; its planned tasks
have a button with their count, and memory, settings, activity and missions
wait in its menu.

Opening a conversation starts at the first missed incoming message, with an
"x missed messages" divider. A bounded chronological window seeks directly
to that position; older and newer pages load as the user reads, including on
a device with no previous read mark. Only messages visible in a visible page
advance that position;
new replies leave someone reading earlier messages in place. The floating
missed-message button jumps to the next unread reply. Once caught up, a return
visit opens at the latest message. Reading positions stay on this device per
core in local storage. Sending can show the latest window without reading
skipped replies, even when both windows overlap; the missed-message button
returns to the first unread reply. Failed page requests preserve the current
position, and navigation buttons wait for the current request to finish. The
entry divider stays attached to the original first missed message and appears
only after its opening window loads successfully.
The optional read marks on `agents.snapshot` request
counts across all retained incoming messages, beyond its 50-message window;
message bodies still arrive through bounded pages. `agents.messages` seeks by
creation time and message ID, independent of later attachment updates, under
the same owner, device and execution-context policy as history.

A new agent needs a name and what it does; its robot, model and permissions
come filled in. The projects entrusted to it are picked beside its
instructions, and role, tools and the rest wait under More options. The header
says which projects it looks after.

### Robots

An agent's picture is a small robot drawn in SVG (`RobotFace.svelte`). It has
a style, a shape, one of nine colours, a face and a top. The default style is
Jelly: a blob on two small feet with a shine and rosy cheeks, in one of six
shapes (round, drop, puddle, two bumps, pear, cloud), eight faces (black or
white eyes, smiling, sleepy, surprised, singing, winking) and eight tops
(nothing, a curl, a flower, antennae, a loop, a sprout, three hairs, a bow).
Its colours are `--jelly-1` to `--jelly-9` in `app.css`, livelier than the
pastel `--robot-1` to `--robot-9` that Bubble, Capsule and Retro share.

The robot is stored in the existing `avatar` field as
`bot:<style>.<shape>.<colour>.<face>.<top>`, for example `bot:d.0.0.0.0` for a
round yellow jelly, so no record changed. An empty avatar draws the jelly the
agent's id gives, the same on every client; one or two characters (an emoji,
initials) stay text, and a code this build cannot read stays text too. Shuffle
draws a new robot in the same style; Customize opens one row per part, each
choice drawn on the robot. The face moves with the agent: it blinks at rest,
a jelly squishes on the spot while it works (the other styles glance from
side to side), and every style hops while it waits on the user. Reduced motion
stills it.

### Threads an agent runs or carries

An agent works in threads of its own (`agentSessionId`). The Threads and
Agents switch over the thread list counts the agents at work on every machine
beside Agents: every agent whose own thread runs, is queued or waits on the
user, and every entrusted thread mid-turn, each thread once. The count turns to the waiting colour while one of them needs the
user, and Threads carries the same count for the conversations at work
(`lib/work-counts.ts`). A project thread an agent runs, a mission task in a
worktree for example, wears the agent's picture in place of the provider logo,
and so does a delegated child of such a thread. Opening an agent's thread
shows, where the composer would be, whose thread it is and the way to the
agent's conversation, where the user talks to it.

### Entrusting a thread

Any kept thread of a project can be handed to an agent from its menus (row,
title, phone sheet): Entrust to an agent, then the agent. `agents.entrust`
(owner only, `packages/core/src/agents/entrust.ts`) refuses a delegated child,
an agent session, an archived thread, a thread outside a project and an agent
that is not active, naming the field. The thread keeps its own model and
session. A goal starts on it (Take over this work where it stands and carry it
to a verified result, unless another objective is given), the agent's name and
instructions join each of its turns, and the agent posts in its own
conversation that it takes the thread over, drawn as a marker across the
conversation. When the goal is met the agent posts the thread's final answer
in its bubble under a Done label and the entrustment ends; when
the thread needs the user, or a turn fails, it posts that too and the
entrustment stays, so the user's answer in the thread resumes the goal. The marker
and each label open the thread. While entrusted, the thread wears the agent's picture
in the list and an Entrusted to chip in its header, whose menu opens the agent
or takes the thread back; taking it back removes the goal without a message.
Archiving or removing the thread ends the entrustment. The snapshot carries
the list as `entrusted`, and a message about a thread carries `thread` with
its id, title and event; clients write the sentence from the event.

The thread list reads all this from the agents snapshot
(`lib/agent-directory.svelte.ts`), loaded only with the Agents experiment on
and refreshed on `agents.changed` at most every 1.5 seconds.

### Projects entrusted to an agent

An agent can be given projects (`AgentProfile.projectIds`, picked in its
settings; drafts and unknown folders are refused). Its direct conversation
then looks after every thread there, the way a person in charge of a project
would, through the `boite threads`, `boite thread` and `boite answer` commands
([CLI](cli.md)), which go through `resident.*` (`agents/projects.ts`):

- it lists and reads their threads, with their questions and last answers;
- it starts a thread in one of its projects (`boite thread new`), which codes,
  verifies and opens the pull request: an agent hands code work to threads and
  never shows code itself;
- it steers a thread with a letter marked as its own (`origin: 'resident'`,
  see [coordination](coordination.md#letters-from-the-agent-of-a-project)),
  whatever that thread's communication settings, which wakes it even when its
  last turn failed;
- it marks a thread done (`boite thread done`, the Done list, refused while a
  turn or input is pending), archives, restores, renames, stops, or moves a thread to another of its
  projects, and answers or skips a thread's question; each action leaves a
  line in that thread's timeline naming the agent.

Deleting a thread and allowing a tool permission stay the owner's. A group or
mission session of the same agent has none of this; neither has an agent that
is paused or archived.

The core tells the agent what happens there with notices, queued as one work
item in its direct conversation (`AgentWork.purpose: 'notice'`): a notice
waits 30 seconds for others to join it, and the item stops growing past 16,000
characters, dropping its oldest notices. A thread the agent started, wrote to
or answered for is followed for a week: every turn it ends comes back with its
final answer and pull request. Any thread of its projects that fails or asks a
question is reported too; a question waits three minutes first, since the user
is often there to answer it. A permission a followed thread waits on is
reported so the agent can tell the user. At most 60 notices an hour reach one
agent; the rest are dropped with a line in the log. When nothing needs the
user, the agent answers `[quiet]` and nothing is posted; otherwise its answer
lands in the conversation under an About your projects label. Taking a
project back drops what pending notices say about its threads, and cancels a
notice with nothing left, along with the agent's letters still waiting there.

### How an agent talks

Every run tells the agent to write like a colleague in a chat, in the user's
language, in short plain sentences: no code, diffs, logs or tool output in its
answers, proof given with files it attaches and markdown links. A file it
publishes with `boite attach` while it works rides with its answer
(`AgentConversationMessage.files`, at most 20): the conversation draws
pictures inline with the zoomable viewer and other files as cards, read with
`artifacts.read` on the agent's own thread and message.

### Asking to change an agent's settings

An agent's settings stay the owner's, but a thread, or the agent about itself,
can propose a change with a card: `boite settings agent request <key> <value>
--why <reason>`, the same flow as a card about a Boite setting ([CLI](cli.md)).
The keys are the projects entrusted to it, its model and reasoning effort, the
memory pass (`autoMemory`), its subagents and `maxRunMinutes`. A run tells the
agent how to ask, so one that needs a project it was not given asks for it
instead of working around it. The card is asked without stopping and outlives
its turn. In a thread it sits in the timeline; an agent's own cards, and any
other card its hidden work threads raise, show in its conversation above the
composer. Apply (`agents.settings.apply`, owner only) goes through the same
checks as the agent's settings page, and for projects the owner can untick
part of the proposal first. Any change to the agent, from the card or from
the page, settles the cards it answers; the asking thread reads the outcome as
a message, which a persistent agent receives as new work. Code:
`packages/core/src/agents/setting-cards.ts`, shared checks in
`packages/contracts/src/agent-setting-requests.ts`.

Question events from persistent agents' hidden session threads reach owner
and paired-device clients without a thread subscription. This keeps the
conversation's cards current when a setting changes or another client answers.
The session transcript and ordinary thread questions remain subscription-scoped.

## Conversations and teams

A group is a shared conversation without a required project. Each agent/group
pair has its own native provider session. Direct conversations have separate
sessions too. Agents can belong to several groups and teams.

A team records members, responsibilities and projects. It may link to a group
but does not become that group. A mission belongs to a team or to selected
agents. It has an objective, expected result, tasks, resources and limits.

Group response modes are explicit:

- Selected recipients sends only to checked members.
- One response per member sends one work item to each member.
- Take turns automatically starts with the first member and passes the reply
  to the next. Explicit recipients override the initial selection.

A new user message starts an episode. Replies and decision continuations keep
that episode. Total and per-agent turn limits apply. Messages retain recipients
and delivery states, including exchange-limit refusals. A paused group keeps
queued deliveries. Pausing a running execution requires explicit resume later.

## Tasks, results and decisions

Assignment checks revision and dependencies in one transaction. A dependency
is satisfied only after the owner accepts its result. An assignment generation
rejects obsolete submissions. Review waits until the provider has stopped.

Project missions give each agent a Git worktree, reused by its later tasks in
that mission. Preparation records the branch before Git starts. Restart checks
that exact branch and directory before adoption. Projectless work uses a
directory under the core data directory. Workspaces remain for inspection and
handoff. There is no automatic merge, publication or deployment.

The owner can accept, reject or request changes with feedback, then assign new
work explicitly. Finish mission requires terminal tasks and executions.
Cancellation stops current executions, cancels queued work and closes pending
decisions. Finished and cancelled missions can be reopened. A used mission
keeps its original project. Referenced projects cannot be removed, preserving
workspaces and shared context. Accounts referenced by profiles are protected too.

Artifacts include workspace files, an optional commit and the agent's
verification report. Files must exist inside the workspace on first submission.
A retry with the same request id returns the original artifact after completion.
The interface exposes results and the execution without requiring process logs.

An agent calls `boite agent decide` to release its slot and request a durable
human decision. The prompt and its choices stand in the conversation where the
work was asked; its avatar and header show waiting while the row keeps its
missed-message count or last activity time. An answer creates
one continuation in the same context. Native tool approvals still use the
existing permission cards and provider process.

## Memory and resources

Memory belongs to an agent, group, team, mission or project. Records have
revisions, source scopes, an optional source run and expiry. The Memory tab
supports search, editing and expiration. Expired records remain visible to the
owner but are not supplied to agents.

Personal memory is readable by its agent; group memory stays in its group.
A mission can read its team's and project's memory. Provenance further restricts
access: copying a private-group finding into personal memory does not make it
available to another group. Agents cannot strip provenance or widen scope.
The owner controls wider sharing.

Resources are instructions, HTTP/HTTPS URLs or existing absolute directories.
Directory paths are canonicalized. Own-context and personal resources are
supplied automatically. Select inherited team/project resources in the mission.
Declared writers serialize against readers and writers of the same URL or
overlapping directory. Interrupted executions keep their reservation until
reconciled or cancelled. The queue names the resource holder. This is not an OS
sandbox: provider permissions govern filesystem and network actions.

## Execution and recovery

The core owns the durable queue. Defaults are one run per agent and two
background runs globally, controlled by the background concurrency setting.
Account login checks and plugin holds still apply. Background work does not
add work ahead of queued turns. Interactive turns have no global or per-account
scheduler ceiling.

Mission turn limits count started runs and accepted reservations. The time
limit sums execution durations across agents and retries, excluding human wait
time. Token limits check reported usage between turns, not inside a provider
call. Missing usage pauses further work instead of counting it as zero. Direct
and group executions default to ten minutes, configurable per identity.

Closing the page stops rendering. Quitting the shell leaves its core running
in the user's session. Reopening adopts that core. Background settings exposes
owner-only Stop this core, which stops all work and disconnects clients. There
is no OS service. General settings can start the shell at login, which starts
the core and leaves the window in the tray. Tests and benchmarks use
`BOITE_CORE_RESIDENT=0` when they need shell-owned shutdown.

After restart, accepted work that never started is eligible again. Started
work becomes Interrupted and needs an inspection note through Review and resume.
Completed turns reconcile with their saved results. Durable decisions remain
pending; native approvals expire with their process. Arbitrary shell effects
cannot guarantee exactly-once execution and are never replayed blindly.

A command that creates something (a message, a routine run, a decision) takes a
`requestId`. The core remembers each id for 30 days: sending the same id again
returns the same record, read again as it stands now, and does nothing twice.
The receipt names the record rather than copying it, and the journal event of a
record change names its kind, id and revision, so a routine with a long prompt
does not copy that prompt into every receipt and event. Those events also leave
the journal after 30 days, all but the newest, whose id is the revision clients
compare; the records themselves stay.

## Providers and tools

Profiles use existing model probing, account selection, effort and drivers.
A newly selected model must appear in the combined provider and account-probed
catalog; examples and saved profiles do not establish availability.

Muse Code uses MSP, including approvals and session resume. Antigravity runs
its managed ACP server, with accounts of its own. See [providers](providers.md) and [accounts](accounts.md).
Collaboration uses the provider-independent [`boite agent` commands](cli.md).

## Individual brain and compaction

Each identity owns a brain folder: `agent-workspaces/<agent-id>/brain` in the
host's data directory by default. The owner can choose another folder for every
brain, a Git repository of their own for example, under Brain folder in the
engine settings (`agents.brain.root`). There each agent gets a folder named
after it (`open-source`, then `open-source-2` when that name already holds
files), kept through renames. Choosing a folder moves every existing brain
there, and the default puts them back; a folder inside the core's data
directory, or containing it, is refused, and so is a change while an agent
works or a memory pass runs. A move that fails halfway puts back what moved.
`AGENTS.md` holds its reusable instructions, `MEMORY.md` its personal
notes, and `skills/` its procedures. The Brain tab edits both text files with a
content revision check. The brain stays on the host across model changes and
client disconnects. Personal notes are supplied only in direct conversations;
shared contexts use scoped memory. Filesystem access still follows provider
permissions, not a separate OS sandbox per identity.

After each finished piece of work in the direct conversation (a message,
a planned task or notices it answered), a memory pass rewrites `MEMORY.md`
(`agents/memory.ts`). It is a subagent of the agent's thread that the core
owns, like a goal reviewer: it reads the current file, what was asked and what
the agent answered, and returns the whole file rewritten with a one-line
summary, keeping dated facts about the user, their projects, decisions and
open follow-ups and dropping what the exchange made wrong or finished. It runs
on the provider's small model (the one that titles threads) when the agent's
subagent policy allows it, else on the agent's own model. The core writes the
file, so the pass needs no tools; it keeps the old file when the owner edited
it meanwhile, when the answer is too long, or when it would drop most of a
file past 1,500 characters. The agent's next work waits up to five minutes for
the pass, so it starts from the new notes; a pass still running after ten
minutes is stopped. The pass is recorded on the work (`AgentWork.memory`), and
the conversation shows Memory updated under the answer with the summary.
Its answer never reaches the agent as mail. The agent's settings turn it off
(`autoMemory`).

Compaction runs after twelve completed turns by default, configurable from two
to one hundred, at 85% of a reported context window, or on demand from Brain.
It asks the current model for a bounded
continuation note, stores that note for this context, then drops the native
session. The next turn uses the note and bounded recent messages. Journal
history and durable memory stay intact. Empty or failed summaries retain the
old context and require review. Compaction waits for active children; managed
collaboration writes and interactive tool approvals are denied during it.
Providers without an approval channel still use their own launch permissions.

## Routines and subscription allocation

Routines belong to one identity and run in its direct context. Choose a single
date, an interval in minutes, or a daily local time with an IANA timezone. The
core wakes them without an idle model loop. One unfinished occurrence blocks
the next. After downtime, at most one overdue occurrence enters the durable
queue; missed intervals are not replayed. Daily routines run once per local
date, even when clocks move back. A skipped local time runs on the next
scheduled day. A daily routine can be limited to chosen weekdays, for example
Monday, Wednesday and Friday at 09:00; the weekday is read in its timezone.
Pausing the identity or the engine also holds its routines. A single-date
routine is done once it ran, on schedule or through Run now: the card reads
Done and offers no Resume, and only a new date schedules it again, even one
saved while the routine is paused.

Planning a task asks two things: what to do, and when, picked from Once (with
In an hour, This evening and Tomorrow morning), Every day, Some days (a toggle
per weekday) and Repeatedly (15 minutes to a day, or any number of minutes). A
sentence under the choices says what will happen and when it runs next before
anything is saved, for example "Every Monday and Friday at 6:00 PM". The time
zone is the device's and is never asked; a routine saved elsewhere names its
zone in that sentence and keeps it until its time changes. The name is
optional: it defaults to the first words of the task. The header's planned
tasks button lists them and adds one. A routine's result comes
back in the agent's conversation labelled with the routine's name. Each
routine shows its next run and how its last run went, with Run
now, Pause or Resume, Edit and the way into that run's thread.

Models and limits separates the required default route, allowed main routes,
and allowed subagent profiles. A route names a provider, account and model.
Subagents are on by default: with no profile listed, an agent's children run
on any model of an account granted to it, unless the owner turns free model
choice off; listing profiles restricts children to them, without gaining other
main routes. The subagent guide joins a fresh session while they are on. The
combined provider and account-probed catalog determines availability.
There is no silent fallback to an unapproved model.

Saving settings retains a previously approved model and unchanged effort if a
later catalog omits them, including allowed routes and subagent profiles.
New routes, changed models and changed effort still require the current
catalog. Account grants are checked on every save.

Every card of an identity's Settings tab saves by itself, with no Save button:
a pick, a switch or a menu at once, a typed name or number after a pause in
typing or when the field loses focus. The card title then reads Saving, Saved,
or Not saved with the core's reason and a Retry; a refused save never reads as
saved, and the agent keeps running on the route the core holds. Saves of one
identity run one at a time, each on the revision the previous one returned, so
the identity card and the model card never refuse each other. A value the form
cannot send, such as an empty route name, waits until it is valid again, and a
change still waiting when the tab closes is sent. Archiving still asks for the
identity's name before anything is saved. Creating an identity, a team or a
mission keeps its Create button, and so do the brain folder, an identity's
brain files, memories, routines and the first roles that make a group a team.

Account access grants each subscription to all identities or an explicit list.
These grants also apply to their children. Revocation stops affected managed
executions and pauses queued work for review. Routes are checked again just
before driver launch. This controls Boite-managed launches; it does not prevent
an unrestricted shell from invoking a provider independently.

Children reuse the existing delegation driver and scheduler. Each new request
or routine has its own delegation usage counters, with no child count, turn
count or duration quota. Completed children remain in history when a new
episode begins.
Configuration and account grants remain owner-only. A paired device can read
the brain and policy, converse and handle decisions on the selected host.

## Interface and storage

The page opens conversations, activity, scoped memory, routines, the
individual brain and model limits. With several machines, the machine button
at the bottom left of the list, where the thread list keeps its own, selects the
owning core and names it; closing this client does not stop that
core. Disconnection marks the last state as stale. Retained scene sources have
no navigation entry.

Contracts live in `packages/contracts/src/agents.ts`. The journal stores domain records,
receipts and projectless managed threads
with prompt-cache and native delegation data. Supported schema migrations
preserve their history. Records and
events commit together. Revision checks protect edits; request receipts protect
message, artifact and decision retries. Runs freeze execution and supplied
context. `agents.changed` invalidates a revision without broadcasting messages.
Agent RPC is restricted to its authenticated execution context. Paired devices
can converse, inspect and answer; configuration and shutdown remain owner-only.

History grows without bound, so `agents.snapshot` is bounded. It carries the
newest 50 messages and memories, every unfinished work item plus the newest 50
finished ones, and the deliveries, runs and decisions they point to. `more`
says, per kind, whether older records exist. `agents.history` pages one kind
newest first by last change, with an `(updatedAt, id)` cursor and at most 200
records a page; `scopes` and, for work, `agentId` narrow it. Configuration
kinds (profiles, groups, teams, missions, tasks, sessions, routines, resources,
artifacts) stay whole. An agent session pages under the same rules as its
snapshot: its own context only, and memory it may read by provenance. Runs
leave out `context.instructions`; the frozen text stays in the core record and
in the first turn of the run's thread.

The UI keeps every record a snapshot or a page brought since it connected, so a
record that leaves the snapshot window stays on screen. A view showing fewer
than 20 records loads one older page by itself; `Load earlier` fetches the
rest. The CLI pages back when `agent reply` or `agent memory` needs a record
older than the snapshot.

Targeted reads never load a whole kind. Each goes through a partial expression
index and names it with `INDEXED BY`, so a query the index cannot serve fails
instead of scanning: sessions by thread, messages by source run, work by
episode, agent or scope, deliveries, runs and decisions by work, and completed
runs of a thread. `events_agents` serves the snapshot's revision.

## Verification

Follow the relevant [development checks](development.md#checks-and-tests) and
[shell procedure](development.md#rebuilding-the-shell-executable).

Core tests cover assignments, scope isolation, receipts, decisions, resource
serialization, CLI tools, interrupted runs and workspace preparation recovery.
`agents-history.test.ts` covers bounded snapshots, paging every record once,
same-millisecond cursors, session paging, the query plan of each targeted read
and the migration from schema 15.
The UI journey creates and converses with an agent, leaves the page, edits
memory and brain files, plans a routine on chosen weekdays and reads its
sentence, inspects model limits, accepts a task, finds the Agents count in the
waiting colour over the thread list, opens the agent's thread and its conversation
from there, answers a decision in the conversation, then entrusts a thread from its
title menu and finds the take-over marker and the Done label in the agent's
conversation. `robots.test.ts`, `schedule.test.ts`, `thread-entrust.test.ts` and
`agents.test.ts` cover robot codes, schedule sentences, the entrust menu rows,
the rows an agent at work lights and the thread list's directory;
`agents-entrust.test.ts` covers the core's refusals, goal, persona, outcome
messages and clean-up. Captures are under
`tests/e2e/.artifacts`. The shell journey finishes work after shell exit,
adopts the same PID and stops it explicitly. Real-provider inference is opt-in.
