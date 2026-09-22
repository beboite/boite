# Agent delegation

Open Agents in a conversation to configure a team. Add named profiles with
the same harness, account, model and reasoning picker used by the composer.
Enable delegation when the profiles and limits are ready. The main agent can
then delegate through the `boite` CLI, and the owner can launch a brief from
the panel.

Every child is a normal Boite conversation with its own provider session,
permissions, process trace and usage. It inherits the parent's project,
checkout and permission mode at creation. Profiles can use any installed,
runnable provider and account. Native provider subagents are separate from
these Boite-managed teams.

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

## Limits and cost

Delegation starts disabled. Only the owner can configure profiles or increase
limits. A paired phone can inspect, message and stop an enabled team.

| Default | Scope |
| --- | --- |
| 4 agents | Total children in this team; reuse them for follow-ups |
| 2 concurrent | Running child turns, also subject to global and account caps |
| 12 turns | All accepted child turns and automatic parent wake turns |
| 30 minutes | Deadline per child turn or automatic parent wake, including time awaiting an answer |
| 100 messages/hour | Team messages; terminal results always have a reserved delivery path |

Turn budgets survive restart and are not reset by pausing or changing profiles.
Cancelled queued turns still count. Limits can be raised to 8 agents, 8 concurrent
children, 100 turns and 120 minutes. Turn and time limits bound work, not a dollar
amount. Usage is whatever the provider reports; subscription usage is not an
invoice, and missing cost reports stay unknown.

Briefs are limited to 12,000 characters. Boite does not copy the parent's
conversation into every child. Messages are capped at 4,000 characters and
delivered in batches of up to four. Unread steering messages expire after 15 minutes.
Terminal results stay available. When the turn budget is exhausted, they wait
for the next manual parent turn or an owner budget increase instead of waking a
model beyond the limit.
Only the selected child's transcript is subscribed to in the panel; inactive
children contribute summaries instead of a stream per agent.

Stop all pauses the team and cancels queued and running children. Stopping or
archiving the parent does the same. Parent failure and core restart pause the
team. Resume is an owner action. An unsuccessful child is not retried by Boite.

## Agent commands

```sh
boite delegate profiles
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
Waiting inside a tool keeps a scheduler slot occupied and can delay queued
children when the account limit is one.

The core journals relationships and idempotent spawn/message requests. Retrying
the same request ID returns its existing result; using it for different content
is refused. The owner's token and provider credentials never enter a brief.
