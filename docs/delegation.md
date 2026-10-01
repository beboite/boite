# Subagents

Delegation is on in every conversation, with nothing to set up. The main agent
delegates through the `boite` CLI and the owner can launch a brief from the
Subagents tab of the side panel. The built-in profile `conversation` is the conversation's own
harness, account, model and effort. Open Subagents > Settings to add named profiles for other
models, with the same picker the composer uses, or to turn delegation off for
that conversation.

Every child is a normal Boite conversation with its own provider session,
permissions, process trace and usage. It inherits the parent's project,
checkout and permission mode at creation. Profiles can use any installed,
runnable provider and account. Native provider subagents are separate from
these Boite subagents, and appear in their own section of the tab. The global
Persistent agents page holds agents with their own roles, memory and missions;
it is not the list of children of a conversation. Enable it in Settings >
Experiments to reveal its bottom-left launcher, which opens a dedicated
interface. It adds no conversation panel or mobile navigation tab.

Subagents lists the Boite subagents first, with a way to launch one, then the
provider's own, then Settings. Its first block says whether Boite subagents are
on, off or paused. The tab opens from the side panel and from the title's menu;
the header has no button for it. Workflows do not depend on it: they run with delegation
off, and only a paused team holds them. Its agent, turn and token totals count only Boite
delegation. Communication between conversations is a separate setting; its
Off label does not disable provider-native subagents.

## Native provider subagents

Subagents shows native agents' reported names, tasks, models, status and bounded
results. Running agents also appear below the chat. Ask the main agent to steer
or stop them: these records are not Boite conversations. Explicit provider IDs
join updates across turns; inferred tool IDs are scoped to a turn so repeated
tool IDs keep separate invocations. No token
total is invented for children whose usage the provider does not separate.
Background acknowledgements for a group stay at group level when they do not
identify an individual child.

Codex collaboration calls and subagent activity become persisted tool parts.
Child-thread text and tools stay out of the parent's answer. Claude Agent/Task
calls and background agent lists, Muse subagent items, and named agent tools
from ACP and pi feed the same view. Other drivers, including agy's ordinary
tool stream, retain agent tools if the provider reports their name and brief.
A provider that sends only text or shell output exposes no native agent list.

A successful spawn call is not a completed child. Missing individual states,
background launch acknowledgements, and unfinished children after a parent
turn ends show Status unknown. A live background-agent list can still confirm
that a child is running. The tab retains reported results across message paging
and restart. Native events discarded by an older Boite version cannot be
reconstructed from its journal.

## Follow and steer

The parent chat keeps a "Started N agents" row at the first launch. It shows
successful completions out of the team total, failed or stopped tasks, and
elapsed time. Click it to open every agent's model, task, status and result in
the right panel. The timer runs locally while work is active and freezes when
all agents settle. Sending a follow-up to a child resumes its status and timer.

The bottom strip stays visible while children are running, queued or waiting
for an answer. Select an agent to inspect it in the right panel, send a message
or stop it. Open its conversation to answer permission and question cards.
The panel keeps completed results after the active strip disappears.

Messages carry the authenticated sender and appear as forwarded messages.
Claude receives them at a tool boundary; Codex and pi can accept live steering.
Other drivers receive a new turn after their current turn finishes. A waiting
permission or question is never answered by a forwarded message. A delivery
receipt means provider acceptance, not agreement or task completion. An
uncertain submission is not retried automatically.

The final text of a child turn returns to the parent automatically, capped at
4,000 characters. Tool output and reasoning stay in the child conversation.
There is no model call to summarize the result. Send another brief to an
existing child to reuse its session.

## Controls and usage

Delegation starts enabled, on the `conversation` profile alone. The agent is
told about it when the request is about handing work out (delegation,
subagents, parallel work, a workflow), and on every turn once the owner added a
profile. Persistent agents keep their own setting, which starts off. Only the
owner can configure profiles, turn delegation off or resume a paused team. A paired phone can inspect, message and stop an enabled team.

Boite imposes no quota on the number of children, their concurrent turns, total
turns or turn duration. Previously saved quotas are ignored. Each conversation
still runs one turn at a time. Usage counters survive restart and are not reset
by pausing or changing profiles. Usage is whatever the provider reports;
subscription usage is not an invoice, and missing cost reports stay unknown.

Briefs are limited to 12,000 characters. Boite does not copy the parent's
conversation into every child. Messages are capped at 4,000 characters and
delivered in batches of up to four. Unread steering messages expire after 15 minutes.
Team messages are limited to 100 per hour; terminal results have a separate
delivery path and stay available. They wake an idle parent or join its next
prompt when live steering is unavailable.
Only the selected child's transcript is subscribed to in the panel; inactive
children contribute summaries instead of a stream per agent. After a
reconnect, the panel asks for the selected child's messages from its oldest
unfinished turn and reads the team and coordination views again, since events
sent while the socket was down reach no client.

Stop all pauses the team and cancels queued and running children. Stopping or
archiving the parent does the same, and so does a parent failure. A team with
no child is never paused that way: there is nothing to stop. A core restart
pauses only a team with a message still to deliver or a child turn it cut
short. Resume is an owner action. An unsuccessful child is not retried by Boite.

## Workflows

A [workflow](workflows.md) is a plan of delegated steps the core runs by
itself: dependencies, one step per item of an earlier step's output, and steps
that run only when a condition holds. Its steps are ordinary children on the
conversation's model, or on one of this team's profiles when a step names it,
so a workflow needs neither a profile nor an enabled team. The plan controls
step concurrency. Workflow steps are not
listed among the team's agents.

## Agent commands

```sh
boite delegate profiles
boite delegate spawn conversation "List the parser's entry points. Do not edit files."
boite delegate spawn reviewer "Review the parser changes. Do not edit files."
boite delegate list
boite delegate send <child-thread-id> "Focus on malformed inputs."
boite delegate stop <child-thread-id>
boite delegate stop
```

A child can send a question or blocker to its parent with `delegate send`.
Its final answer returns automatically, so it should not send a duplicate
completion message. Replies do not grant user permission or override the task.
Only direct parent-child messages are allowed. Delegation has one level;
children ask the parent when another worker is needed.

Agents should name the files each child owns, because children share the
checkout. Boite does not create a worktree per child or merge their edits.
While a child works, the parent should do independent work or finish its turn.
Waiting inside a tool keeps the parent busy and can delay delivery of results.

The core journals relationships and idempotent spawn/message requests. Retrying
the same request ID returns its existing result; using it for different content
is refused. The owner's token and provider credentials never enter a brief.
