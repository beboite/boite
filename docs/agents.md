# Persistent agents

Agents is a page beside chat, behind the Resident agents switch in Settings >
Experiments ([experiments](experiments.md)). An identity keeps its instructions, memberships
and scoped memory when its provider, account or model changes. Pausing or
archiving an identity stops its current execution and prevents new work; the
stopped work item says the agent was paused or archived.

## The page

The page is cut like the chat. Its list stands where the thread list does,
with two views on top: Agents (the agents in one card, groups and teams in
another) and Planning (every routine, grouped as today, tomorrow, this week,
later, paused and done). A row reads like a thread row: the agent's picture
where the provider logo goes, its name, and on the right the same state a
thread shows, Working with its time while its thread runs a turn, Needs you
while a decision waits, or when it last moved. The line under it says what the
agent is doing, else the last message, else its next routine. The foot holds
the engine settings, the way back to the conversations and Settings.

A conversation reads like a thread: the user's messages in bubbles, each
agent's answer as prose under its picture and name, and the thread composer at
the bottom. While an agent works, a line says so with the elapsed time and opens
the thread it works in. A decision it asked for stands in the conversation as a
question with its answers to pick and a free answer. The header names the views
in words (Chat, Planning, Memory, Settings for an agent); Activity and Missions
wait in its menu.

A new agent needs a name and what it does; its robot, model and permissions
come filled in, and role, tools and the rest wait under More options.

### Robots

An agent's picture is a small robot drawn in SVG (`RobotFace.svelte`). It has
a style (Bubble, Capsule or Retro), a shape, one of nine colours, eyes and an
accessory. The robot is stored in the existing `avatar` field as
`bot:<style>.<shape>.<colour>.<eyes>.<accessory>`, for example `bot:b.0.4.0.1`,
so no record changed. An empty avatar draws the robot the agent's id gives, the
same on every client; one or two characters (an emoji, initials) stay text, and
a code this build cannot read stays text too. Shuffle draws a new robot in the
same style; Customize opens one row per part, each choice drawn on the robot.
The colours are `--robot-1` to `--robot-9` and a few shared tones in `app.css`.
The face moves with the agent: it blinks at rest, glances from side to side
while it works and hops while it waits on the user. Reduced motion stills it.

### Threads an agent runs

An agent works in threads of its own (`agentSessionId`). The thread list shows
it: an Agents at work card above the projects lists every agent whose thread
runs, is queued or waits on the user, with the same state words as a thread
row. A row opens the thread, or the agent's conversation when it waits on an
answer given there. A project thread an agent runs, a mission task in a
worktree for example, wears the agent's picture in place of the provider
logo, and so does a delegated child of such a thread. Opening an agent's thread
shows, where the composer would be, whose thread it is and the way to the
agent's conversation, where the user talks to it.

The thread list reads this from the agents snapshot (`lib/agent-directory.svelte.ts`),
loaded only once a thread of that machine belongs to an agent and refreshed on
`agents.changed` at most every 1.5 seconds.

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
human decision. Needs attention shows the prompt and choices. An answer creates
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
A selected model must appear in the account's current probe; examples and saved
profiles do not establish availability.

Antigravity CLI uses agy stream-json and its single default login. Print mode
has no interactive tool-approval channel. Muse Code uses MSP, including
approvals and session resume. The separate Antigravity ACP integration has its
own accounts. See [providers](providers.md) and [accounts](accounts.md).

Experimental agy account management belongs to the external kebacc-switcher
plugin. The Agents experiment is off by default. It marks dependent agents and
prevents their work when disabled. It does not copy credentials, rotate logins
or implement another switcher. Collaboration uses the provider-independent
[`boite agent` commands](cli.md).

## Individual brain and compaction

Each identity owns `agent-workspaces/<agent-id>/brain` in the host's data
directory. `AGENTS.md` holds its reusable instructions, `MEMORY.md` its personal
notes, and `skills/` its procedures. The Brain tab edits both text files with a
content revision check. The brain stays on the host across model changes and
client disconnects. Personal notes are supplied only in direct conversations;
shared contexts use scoped memory. Filesystem access still follows provider
permissions, not a separate OS sandbox per identity.

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
optional: it defaults to the first words of the task. Plan, beside a direct
conversation's composer, turns what is written there into a task for that
agent. Each routine shows its next run and how its last run went, with Run
now, Pause or Resume, Edit and the way into that run's thread.

Models and limits separates the required default route, allowed main routes,
and allowed subagent profiles. A route names a provider, account and model.
An allowed main route can delegate only to configured subagent profiles,
without gaining other main routes. Provider/account probes determine availability.
There is no silent fallback to an unapproved model.

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
individual brain and model limits. With several machines, the menu at the top
of the list selects the owning core; closing this client does not stop that
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
sentence, inspects model limits, accepts a task, finds the agent waiting in the
thread list's Agents at work card, opens its thread and its conversation from
there, and answers a decision. `robots.test.ts`, `schedule.test.ts` and
`agents.test.ts` cover robot codes, schedule sentences, the rows an agent at
work lights and the thread list's directory. Captures are under
`tests/e2e/.artifacts`. The shell journey finishes work after shell exit,
adopts the same PID and stops it explicitly. Real-provider inference is opt-in.
