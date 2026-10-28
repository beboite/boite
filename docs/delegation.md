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
Bots page holds bots: agents with their own identity, memory and
routines, each in a thread of its own; it is not the list of children of a
conversation. Enable it in Settings > Experiments to show the Threads and
Bots switch at the top of the desktop sidebar and the Bots tab in the phone's
bottom navigation. Each bot opens its ordinary conversation, with its desk in
the right panel ([bots](bots.md)).

A bot delegates project work with `boite delegate spawn "<brief>" --project <project>`.
The project must be entrusted to that bot. With one entrusted project, delegation
uses it automatically; with several or none, an unnamed child stays personal.
Project workers run in the project's folder and appear in its thread list,
including Done and Archived, while the bot keeps steering them from Subagents.
Ordinary conversations keep their helpers under their parent. Memory passes
stay in the bot's brain folder.

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

## Context modes

`--context light|neutral`, `--keep`, `--drop`, `--tools` and `--rules` or
`--rules-file` start a child without part of the user's setup, with rules of
its own; the child's row and header then carry a badge. A small Haiku chore
fits `light`, a neutral review `neutral`. [Context modes](context-modes.md)
lists the presets, the fields and what each provider honours.

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
from ACP and pi feed the same view. Other drivers retain agent tools if the
provider reports their name and brief.
A provider that sends only text or shell output exposes no native agent list.

Agent CLIs launched through a shell also appear under "Started from a command"
when the process trace records them. They contribute to the active count above
the composer. Finishing the launch command or
the parent turn does not complete the child: its own process exit settles its
status. Results stay in the command output. Version checks and the conversation's
own provider process do not appear as children.
After a core restart, an old trace without an exit stays in history as Status
unknown unless the current process registry confirms it is still running.

Windows records descendant starts and exits through its process jobs. When the
job never reports an exit, for example after a nested job is terminated, the
next load sample finds it within four seconds and the active count drops.
A CLI that Boite or its job ended exits with code 9 and reads Stopped; any
other nonzero code reads Failed. Linux and macOS record only direct processes, so a CLI launched inside another
shell can remain outside this view. Provider-native agents and Boite-managed
children use their existing lifecycle on every platform.

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
completed results after the button disappears. The button sits right on the
composer, below any notice; the task overlay floats above it, never over it.

A parent's row in the sidebar, the Recent list and the phone's list carries a
chip with the number of its subagents at work, in every state of the parent.
When a child asks the user something or waits on a permission, the chip takes
the waiting colour and the parent reads Needs you, unless the parent itself
failed. The parent's question dock shows each such child's question, "Asked by"
its title, with its options and an Open button that goes to the child's
conversation; a permission gets a row with the tool it asks for and Open, since
it is approved in the child's conversation only. Text typed in the parent's
composer never answers a child's question: it stays a message to the parent,
and a written answer goes through Open. The core sends a child's `question.*`
and `permission.*` events to the windows that have its parent open, and the
dock reads the children's open cards when the parent opens.

Messages carry the authenticated sender and appear as forwarded messages.
Claude receives them at a tool boundary; Codex, Muse, pi and Grok can accept
live steering. Drivers without steering receive a later turn.
[Coordination](coordination.md#what-the-agent-receives) owns the protocol mapping. A waiting
permission is never answered by a forwarded message; a parent's message to a
child waiting on a question answers that question
([questions from a child](#questions-from-a-child)). A delivery
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
parent and how to report a blocker. Bots keep their own setting, which starts off. Only the
owner can configure profiles or turn delegation off; the parent agent resumes
the pauses listed under [Stop, pause and resume](#stop-pause-and-resume). A
paired phone can inspect and stop an enabled team.

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
The panel lists children by their summaries and streams none of them. Clicking
a child opens its conversation in the chat like any thread; its header reads
"parent title / child title" and the parent's title goes back to it. After a
reconnect, the panel reads the team and coordination views again, since events
sent while the socket was down reach no client.

### Stop, pause and resume

Stop all pauses the team and cancels queued and running children. Stopping or
archiving the parent does the same. A parent turn that fails or that the system
cuts (a provider error, an agent update) pauses nothing: the children keep
working, and their results reach the parent at its next prompt. A team with
no child is never paused that way: there is nothing to stop. An unsuccessful
child is not retried by Boite.

An update or a restart from the app cuts each running child at its next tool
boundary without a result: the parent hears nothing, the team stays as it was,
and the next core starts the child again on the same task, told that Boite
restarted ([restart handoff](restart-handoff.md)). After a crash, the core
pauses only a team with a message still to deliver or a child turn it cut
short; a handoff older than an hour pauses the teams of the children it cut.

A pause records who set it (`pausedBy`, `pausedAt`), and that decides whether
the parent agent may lift it with `boite delegate resume`:

| Paused by | `pausedBy` | The parent agent resumes |
| --- | --- | --- |
| Its own `delegate stop` | `agent` | at any time |
| A crash of the core, or a handoff past its hour | `restart` | at any time |
| The owner's Stop, or archiving | `stop` | once the owner wrote to the conversation again |
| The owner's Pause in Subagents > Settings | `owner` | never |

A pause saved before origins existed reads as the owner's. A refused resume
says which pause holds and who lifts it, and so do a refused spawn and the guide
of a paused team. The owner resumes any of them. Resume hands over the mail the
team held at once, sends each child whose last turn stopped, failed or was
interrupted
a message to continue from where it stopped, and resumes the team's
[workflow](workflows.md) runs that a pause held, under the same rules. A child
is continued once per stopped turn: a second resume sends nothing, whoever
asks, unless a Stop rejected that continuation before it reached the child.

## Workflows

[Workflows](workflows.md) run checked plans over ordinary child threads, with
explicit dependencies, fan-out, conditions and plan concurrency. They do not
require an enabled team or custom profile; pause still holds launches. Workflow
steps remain separate from the team's agent list. That guide owns plan syntax,
structured output, commands and recovery.

## On another machine of the group

`boite delegate spawn "<brief>" --machine <name>` (MCP: `machine` on
`boite_delegate_spawn`) starts the child on another machine of the same
[group](groups.md), named as `--machine` names it for `thread new`. The child
is an ordinary thread of that machine, in its project named like the parent's
or the one `--project` names; a missing project is refused with that
machine's project names. Its owner sees it in that machine's sidebar, where it
belongs to no conversation of that machine.

The machine that runs the child decides, through the same **Threads from the
other machines** switch (`groupThreads`) as `thread new --machine`: while it is
off the spawn is refused with the settings card to propose, and a letter from
the parent is refused too. Stops, result pages and reports always pass. The
parent's own gates apply first: subagents on and unpaused, the owner's
any-model rule. A bot's subagents run on its own machine only.

Without `--model`, `--effort` or `--speed`, the child runs on the parent's
provider and model (or the named `--profile`) there, at the parent's level when
that model lists it, else at its default; a machine where that provider has no
account signed in or that model is not listed refuses with its own list. With
one of them, the parent reads that machine's list first (`boite delegate models
--machine <name>`), picks as `delegate models` does, and that machine starts on
exactly that model, level and speed or refuses; a miss starts nothing.

`delegate list` and `delegation.get` show the child with `machine` beside the
model, as that machine last reported it: its state, last turn, last result,
open questions and worktree. `delegate wait` settles on those reports.
`delegate send <id>` steers it, or answers its question, through that machine
at once, and is refused while it is away; `delegate result` reads the full
answer from it. `delegate stop <id>`, a team stop and archiving or deleting the
parent stop it there, and archiving or deleting the parent archives it there.
Its result, its questions and its own `delegate send` to the parent come back
as letters from that machine, which wake the parent once each. A worktree child
branches from that machine's checkout of the project, and its branch stays
there. `delegate spawn` and `thread new` refuse the child; its instructions
tell it not to start workflows either.

### The protocol

Five sealed operations between the two machines, each safe to repeat, since
the transport retries a request across addresses and either side can restart
or be away:

| Operation | From | Key | What the receiver does |
| --- | --- | --- | --- |
| `delegation.start` | parent's machine | parent and `--request-id` | starts the child, or answers the one it started for that key; other content under the same key is refused. `groupThreads` and the caller's membership are checked again right before the child is created |
| `delegation.report` | child's machine | child, and a letter's request id | keeps the newest state; files a result, question or message once |
| `delegation.letter` | parent's machine | parent and request id | files the steer once, answering an open question when it is one |
| `delegation.read` | parent's machine | none, read only | returns a page of the named turn's answer |
| `delegation.stop` | parent's machine | the stop's own `id` | stops it once, and archives it when the parent was archived or deleted; the same `id` again changes nothing |

Reports and stops wait in an outbox in the sender's journal until the other
machine took them, tried again after 5 s, 15 s, 1 min and then every 5 min,
and at once when that machine is heard from again. A report replaces the state
waiting for the same child. A refusal drops the entry; a machine that left the
group drops its outbox. A start whose answer was lost keeps its record on the
parent's machine: the next report or the same `--request-id` finds the child.
Archiving the parent before then keeps the retirement asked, and the report
or answer that names the child sends it; a stop asked by request id before
then (a workflow step stopped while its start was out) waits the same way.
Each stop carries an id of its own, which the child's machine keeps once
applied: a stop sent again because its answer was lost does not cut the
instruction that followed it, and `delegate send` delivers a stop still
waiting before its letter. A restart
handoff on the child's machine keeps a turn the parent's letter opened and
continues it like the turns of a child here. Until that machine's next core
continues a cut turn, its reports mark the child `restarting`, which the parent
counts as at work rather than as a result; a turn that does not go on is
reported again without the mark, and that stop is final.
A machine whose Boite lacks these operations is reported too old before
anything starts there.

## Shared-project hosts

An associated project can offer compute separately from its read and board
permissions ([Contacts](contacts.md#compute-and-results)). The host owner binds
the offer to an enabled local parent, its delegation profiles, permission mode
and optional contribution limit. `sharedCompute.models/start/list/get/send/cancel`
operate on that exact association and source conversation. The host resolves
the provider/account, creates an ordinary captured child and isolated worktree,
and uses its scheduler, quota and process controls. Credentials never cross.

The source supplies a full base commit already present in both registered
repositories; no remote path or account is accepted. The host retains the
captured branch even when echo makes no changes. Completion derives repository,
branch, base, commit and dirty state from Git, rather than an agent's answer.
Core preparation and inspection disable Git hooks, filters and fsmonitor for
these jobs. Bounded result text remains data. Fetching and merging the branch
uses the project's ordinary approved Git workflow; the result executes nothing.

The host can be a group member behind a Contact gateway. Its canonical
owner/core/project tuple selects the original host; the gateway does not
choose its account, spawn the worker or consume its result. The real three-core
fixture in `tests/e2e/shared-cores.test.ts` fetches the captured worker branch
from a fixture-controlled local repository, checks the advertised object and
base ancestry, then cherry-picks that commit on the source integration branch.
This verifies normal Git consumption without executing a peer-supplied URL.

Follow-ups stay external instructions and cannot approve a host permission
card. Stop/revoke fences exactly the captured job, including delayed starts,
and waits for its tracked processes and preparation; siblings and the host's
own conversation continue. Non-Windows process tracking retains its documented
direct-child limitations. An offline cancellation remains pending until the
host confirms it. Interrupted host execution is uncertain after restart and
is never automatically resubmitted.

Actual host file protection is required before enabling providers with tools.
Without that service only tool-free echo is admitted. Claude/Codex use their
mandatory protected adapters and the common OS executor when available. Their
trusted native account/control stays local; model tools receive a filtered
project view without account credentials, hooks or ambient host access.
`boite_commit` publishes validated edits on the captured branch for real Git
result verification. OpenCode 1.19.3 (default/build or plan) and pi (YOLO/bypass)
now use their own native extension and the common executor. Muse 1.4.13 uses
its verified mandatory MCP-only native registry and the same executor; older
Muse versions and other ACP implementations remain refused. No permission fallback or implicit bypass is introduced.

## Agent commands

```sh
boite delegate models
boite delegate spawn "List the parser's entry points. Do not edit files."
boite delegate spawn "Review the parser changes. Do not edit files." --model codex/gpt-5.5 --effort high
boite delegate spawn "Play the build and report what breaks." --model codex/gpt-6-luna --effort max --speed fast
boite delegate spawn "Review the parser changes." --profile reviewer
boite delegate spawn "Fix the parser bug and commit it." --worktree
boite delegate list
boite delegate send <child-thread-id> "Focus on malformed inputs."
boite delegate result <child-thread-id> <turn-id>
boite delegate stop <child-thread-id>
boite delegate stop
boite delegate resume <child-thread-id>
boite delegate resume
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

`boite delegate models --machine <name>` (MCP `boite_delegate_models` with
`machine`) prints the models of another machine of the group instead, read
from it now, for the caller's provider and model, in the same format. They are
the models a thread started there with `boite thread new --machine <name>
--model` can run on ([CLI](cli.md#commands)). That machine answers only while its **Threads
from the other machines** switch (`groupThreads`) is on, and is refused with
the settings hint otherwise; a machine whose Boite cannot list its models is
reported too old.

Every answer is a few plain lines. `delegate list` starts with one summary
line (`subagents: on; 1 running, 1 waiting, 2 done, 0 failed, 0 stopped`, with
`, N interrupted` when there are some), then one row per
child with its id, state, elapsed time, `provider/model effort=`, `speed=` when
it has one, and title, and
the first 300 characters of a finished result. Workflow runs follow as
`<run-id> workflow <status> <elapsed> steps=<done>/<total>`. A spawn prints the
child id, its route and a reminder that the result arrives as a message.

A child can end its turn while work it started in the background still runs
(a long test, a build). It is not done: its state reads `waiting`, its row adds
`waiting for: <task> (<elapsed>)`, and the summary counts it with the active
ones. What it said at the end of that turn reaches the parent marked as a
checkpoint, and the row labels it `checkpoint:` rather than `result:`;
`delegate wait` keeps waiting. When the task ends, the agent wakes on it,
runs again, and its next answer is the final result. A permission request a
child waits on reads `approval`.

When that background work ends without waking the agent (the task failed and
nothing answered it, or the agent process, Boite or the PC stopped), the child
is `interrupted`: its row says what ended and why, the parent gets one message
saying so, and `boite delegate resume <thread-id>` (or Resume in the Subagents
panel) continues it, while `boite delegate send <thread-id> "<instruction>"`
steers it. A task that ends is given 30 seconds
to wake the agent; after that a failed or vanished task counts as interrupted
and a completed one as done. Work that ended with its agent process counts at
once.

A child can send a question or blocker to its parent with `delegate send`.
Its final answer returns automatically, so it should not send a duplicate
completion message. Replies do not grant user permission or override the task.
Only direct parent-child messages are allowed. Delegation has one level;
children ask the parent when another worker is needed.

A child that opened a pull request waits on it with `boite pr watch`, never a
polling loop (`sleep`, `gh pr checks`, a monitor that expires): its subagent
note says so. Each wake (`docs/cli.md`, "Watching a pull request") opens the
child's next turn, and that turn's answer goes to the parent as a result, so
the parent hears only what the child made of a CI verdict or a review. The
child's watches end when it is stopped, by its own Stop, `delegate stop` or a
failed turn, and when its parent stops, is archived or is removed.

### Finished children are put away

A child is archived as done (`doneAt` set) once it is over, so a conversation
does not keep every agent it started open (`delegation/retirement.ts`):

- a delegated agent, once its last turn ended done, nothing it runs in the
  background is pending or about to wake it, it watches no pull request, no
  question or held answer waits, its result reached the parent and no letter
  waits for it;
- a workflow step's conversation, once its run is done; a failed or stopped
  run keeps its steps, since a retry continues a step in its own conversation.

A stopped or failed child stays open for `delegate resume`. Archiving the
parent leaves the rest of its family as it was, and restoring it brings that
family back unchanged. Every child stays in the team's list and opens from it.
A child put away as done comes back when its parent writes to it
(`delegate send`) or the user sends it a prompt (`turns.start`); a child
archived another way, or whose parent is archived, stays archived. One the
user reopens from its done notice stays open until its next turn ends. On
start, the core applies the same rules to the children an older core left
open.

### Questions from a child

A child can also ask through its own question tool (Claude's AskUserQuestion,
Codex's requestUserInput, `boite ask`) or stop on a permission card. The
parent learns of a question at once: a message with origin `question` names the
child, its question, its options and whether it is blocked, and wakes an idle
parent like a result does. A permission request reaches the parent only if it
is still open after 30 seconds, since the user may be watching the child, and
says that only the user can approve it, in the child's conversation. Settings
cards are the owner's and never go to the parent.

The parent's next `boite delegate send <child> "<answer>"` answers the child's
blocking question instead of queuing a message. The text is an option label in
any case, several labels separated by commas where the question takes several,
or free text where it takes some; a text that fits none is refused with the
options. A question asked without stopping takes the parent's text only when
it names its options: the child is still working, so any other text stays an
ordinary message. The answer is recorded as
given by the parent agent, and the letter carries `answered` with the question
id. A permission card is never answered this way: the message waits until the
child runs again.

A question message not yet delivered is withdrawn when the card closes first
(the user answered it in the child, or its turn ended). A child that finishes
its turn, unless it waits on its own background work, or that is stopped has
its open asynchronous questions closed, so nothing is left asking on the
parent's side. `delegate list` and `delegate wait` print each open card under
the child (`asks (blocked): "..." options: ...` or `needs the user's
approval: <tool>`), and the child's state reads `question` or `approval`.

`delegate wait` returns as soon as a child it covers waits on a blocking
question or a permission, with state `needs_input`, instead of holding until
its timeout while the child's turn stays running. A question asked without
stopping wakes the parent but does not end a wait.

### Children in their own worktree

Children share the parent's checkout by default, so agents should name the
files each child owns. `boite delegate spawn --worktree` (and `"worktree":
true` on a [workflow](workflows.md) step) gives the child a git worktree of its
own on a new `boite/sub-<id>` branch, in the configured worktree folder. Its
branch and folder are chosen at spawn and shown in the spawn output; the
worktree itself is made from the parent's current HEAD, or the entrusted project's
HEAD for a bot, just before the child's first turn. Uncommitted edits are not in it. A
conversation outside a git repository is refused by name.

The child is told to commit its work on that branch. When one of its turns ends
(and it is not waiting on background work), Boite looks at the worktree: with
no commit beyond its base and no uncommitted change, the worktree and its
branch are removed and the result says so; otherwise both are kept and the
result ends with `Worktree kept: <path> on branch <branch>, N commits beyond
<base>`, uncommitted changes noted, and the `git merge <branch>` to run.
Boite does not merge for the parent. A removed worktree is made again, from
the same source checkout's current HEAD, if the child gets another turn.

While a child works, the parent should do independent work or finish its turn.
Waiting inside a tool keeps the parent busy and can delay delivery of results.

The core journals relationships and idempotent spawn/message requests. Retrying
the same request ID returns its existing result; using it for different content
is refused. The owner's token and provider credentials never enter a brief.
