# Subagents

Delegation is on in every conversation, with nothing to set up. The main agent
delegates through the `boite` CLI; nothing is launched by hand. For each child
it names a model and a reasoning level, from any installed provider: a Claude
conversation can start a Codex reviewer. `boite delegate models` lists the
choices. Without `--model` the child runs on the built-in profile
`conversation`, the conversation's own harness, account, model and effort. A
child runs on one of a model's speed tiers, such as its fast mode, only when
the spawn names one with `--speed`; it never inherits the parent's.

The gear in the Subagents tab opens Settings with two switches and a list.
"Let this conversation start subagents" turns delegation off for that
conversation. "Let the agent choose the model", on by default, can restrict
children to the conversation's model and the suggested models. Suggested
models are named profiles the owner adds with the same picker the composer
uses; the agent sees them by name, for example `reviewer`.

Boite picks the child's account: the parent's own when the model belongs to the
parent's provider, else that provider's logged-in default login. A provider
whose model list was never read is probed once, at most 30 seconds, when the
agent asks for its models or names one of them.

Every child is a normal Boite conversation with its own provider session,
permissions, process trace and usage. It inherits the parent's project,
checkout and permission mode at creation. Profiles can use any installed,
runnable provider and account. Native provider subagents are separate from
these Boite subagents, and appear in their own section of the tab. The global
Persistent agents page holds agents with their own roles, memory and missions;
it is not the list of children of a conversation. Enable it in Settings >
Experiments to reveal its bottom-left launcher, which opens a dedicated
interface. It adds no conversation panel or mobile navigation tab.

Subagents is one list and nothing else: the conversation's
[workflow](workflows.md) runs, then the Boite subagents, then the provider's
own. With nothing handed out it is empty. A run opens its graph in place and a
subagent its conversation, each with a way back to the list. The header shows
Off or Paused only in those states, Stop all while something runs, and the
owner's gear. The tab opens from the side panel, the title's menu and the
palette's "Show the subagents"; the header has no button for it. Workflows run
with delegation off, and only a paused team holds them. Communication between
conversations is a separate setting in the title's menu; its Off label does not
disable provider-native subagents.

## Native provider subagents

Boite subagents replace the providers' own. Claude starts with its `Agent`,
`Task` and `Workflow` tools disallowed, Codex with `features.multi_agent` and
`features.multi_agent_v2` off, the shipped OpenCode descriptor denies its
`task` permission, and Grok starts with `GROK_SUBAGENTS=0` and
`GROK_WORKFLOWS=0`, which its CLI honours in `grok agent stdio` as in its TUI.
Muse Code turns its own off only through `run.subagent_delegation_mode` in the
user's `settings.json`, which Boite does not rewrite, so a Muse conversation
keeps its native subagents. Other harnesses keep whatever native agents they
have.

Subagents shows native agents' reported names, tasks, models, status and bounded
results. Active agents contribute to the count above the composer. Ask the main agent to steer
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

Agent CLIs launched through a shell also appear under "Started from a command"
when the process trace records them. They contribute to the active count above
the composer. Finishing the launch command or
the parent turn does not complete the child: its own process exit settles its
status. Results stay in the command output. Version checks and the conversation's
own provider process do not appear as children.
After a core restart, an old trace without an exit stays in history as Status
unknown unless the current process registry confirms it is still running.

Windows records descendant starts and exits through its process jobs. Linux and
macOS record only direct processes, so a CLI launched inside another shell can
remain outside this view. Provider-native agents and Boite-managed children use
their existing lifecycle on every platform.

A successful spawn call is not a completed child. Missing individual states,
background launch acknowledgements, and unfinished children after a parent
turn ends show Status unknown. A live background-agent list can still confirm
that a child is running. The tab retains reported results across message paging
and restart. Native events discarded by an older Boite version cannot be
reconstructed from its journal.

## Follow and steer

The parent chat keeps one "Started N agents" row per launch: the children
started after the same message share a row, placed where the first of them
started, and it stays once they finish. A launch older than the loaded history
shows when that page loads. Each row shows successful completions out of its
agents, failed or stopped tasks, and elapsed time, in hours past an hour. Click
it to open every agent's model, task, status and result in the right panel. The timer runs locally while work is active and freezes when
all agents settle. Sending a follow-up to a child resumes its status and timer.

One button above the composer shows the number of active subagents and running
workflows, with elapsed time since the oldest active start. It appears for a
running workflow even before a child starts. Click it to open the team overview,
then select an agent or workflow to inspect its progress. The panel keeps
completed results after the button disappears. Open a child's conversation to
answer permission and question cards.

Messages carry the authenticated sender and appear as forwarded messages.
Claude receives them at a tool boundary; Codex, Muse, pi and Grok can accept
live steering. Drivers without steering receive a later turn.
[Coordination](coordination.md#what-the-agent-receives) owns the protocol mapping. A waiting
permission or question is never answered by a forwarded message. A delivery
receipt means provider acceptance, not agreement or task completion. An
uncertain submission is not retried automatically.

The final text of a child turn returns to the parent automatically, capped at
4,000 characters. Tool output and reasoning stay in the child conversation.
There is no model call to summarize the result. Send another brief to an
existing child to reuse its session.

## Controls and usage

Delegation starts enabled, with free model choice. The first turn of a new
provider session carries a short guide: the commands, `--model`, `--effort` and
`--speed`, that a child runs at standard speed (no tier) without `--speed`,
and the rule that results come back as messages. Later turns carry it again
when the request is about handing work out (delegation, subagents, parallel
work, a workflow) or the team is paused. A child receives one line naming its
parent and how to report a blocker. Persistent agents keep their own setting, which starts off. Only the
owner can configure profiles, turn delegation off or resume a paused team. A paired phone can inspect and stop an enabled team.

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

[Workflows](workflows.md) run checked plans over ordinary child threads, with
explicit dependencies, fan-out, conditions and plan concurrency. They do not
require an enabled team or custom profile; pause still holds launches. Workflow
steps remain separate from the team's agent list. That guide owns plan syntax,
structured output, commands and recovery.

## Agent commands

```sh
boite delegate models
boite delegate spawn "List the parser's entry points. Do not edit files."
boite delegate spawn "Review the parser changes. Do not edit files." --model codex/gpt-5.5 --effort high
boite delegate spawn "Play the build and report what breaks." --model codex/gpt-6-luna --effort max --speed fast
boite delegate spawn "Review the parser changes." --profile reviewer
boite delegate list
boite delegate send <child-thread-id> "Focus on malformed inputs."
boite delegate result <child-thread-id> <turn-id>
boite delegate stop <child-thread-id>
boite delegate stop
```

`--model` takes `provider/model`, a bare model id (the parent's provider wins a
tie) or a unique part of an id or name, such as `opus`. An ambiguous or
unknown name is refused with the candidates. `--effort` must be one of the
model's levels; without it the child keeps the parent's level on the same
model, else the model's default. `--speed` names one of the model's speed tiers
by id or by label, in any case: `fast` selects Claude's `fast` and the Codex
tier whose id is `priority` and label "Fast". It applies to the model the child
runs on, so it also works with `--profile` and with no `--model`, unless that
route runs on the provider's default model: then the spawn is refused and
`--model` has to name a model. A tier the model lacks is refused with the model
and the tiers it offers, or that it offers none. Tiers come from
`boite delegate models`, which reads any agent-owned list not read yet. A spawn
never probes for tiers, so a spawn naming a speed on a model or profile whose
tiers are not read yet is refused and says to list the delegation models and spawn again; a spawn without a speed is not
affected. `delegate models` prints the tiers of each model that has some, joined
by `|`, each as its id, with the label in front when the label says something
else: `speed=fast` for Claude, `speed=Fast (priority)` for that Codex tier.
`--speed` takes any one of those entries as it is.
`delegate list` and a spawn show the id the child stores, here
`speed=priority`. The older `delegate spawn <profile> "<brief>"` form still
works.

Every answer is a few plain lines. `delegate list` starts with one summary
line (`subagents: on; 1 running, 2 done, 0 failed, 0 stopped`), then one row per
child with its id, state, elapsed time, `provider/model effort=`, `speed=` when
it has one, and title, and
the first 300 characters of a finished result. Workflow runs follow as
`<run-id> workflow <status> <elapsed> steps=<done>/<total>`. A spawn prints the
child id, its route and a reminder that the result arrives as a message.

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
