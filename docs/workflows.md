# Workflows

A workflow is a JSON plan of steps that the core runs for a conversation. Each
step is a child agent on the conversation's own harness, account, model and
effort, on a model and reasoning level the step names, or on a
[delegation](delegation.md) profile. A step starts once
every step it depends on has ended. When the run
ends, its results come back to the conversation as one message. No model sits
in the middle deciding what runs next, so the plan behaves the same whichever
provider wrote it or runs its steps.

The main agent writes a plan and runs it with `boite workflow run`, and keeps
one as a template with `boite workflow save`. Nothing has to
be enabled or configured first: a plan whose steps name no profile runs in any
conversation, on the model already chosen there.

A plan is a template the agent may reach for, not an obligation. When a request
mentions a workflow, every driver receives the runner commands and is asked to
give the run ID of a run it starts. A conversation with an enabled team receives
them on every turn, beside its profiles. The agent stays free to answer with
native subagents or plain work when that fits better.

## A plan

```json
{
  "name": "Review the parser",
  "limits": { "maxConcurrent": 3, "maxSteps": 24 },
  "steps": [
    { "id": "scan",
      "task": "List the source files of src/parser that changed this week.",
      "output": { "files": ["string"] } },
    { "id": "review", "forEach": "scan.files",
      "task": "Review {{item}} for malformed-input bugs. Do not edit files.",
      "output": { "bugs": [{ "line": "number", "text": "string" }] } },
    { "id": "fix", "when": { "path": "review.bugs", "notEmpty": true },
      "task": "Fix confirmed bugs and report the checks run: {{review.bugs}}" },
    { "id": "report", "after": ["fix"],
      "task": "Summarize what was reviewed and fixed: {{review}}" }
  ]
}
```

Every step above runs on the conversation's model. A step that should run on
another one names it, as `boite delegate spawn --model` does:
`{ "id": "review", "model": "codex/gpt-5.5", "effort": "high", ... }`, or a
profile: `{ "id": "review", "profile": "reviewer", ... }`. `boite delegate
models` lists the choices.

| Field | Meaning |
| --- | --- |
| `id` | Letters, digits, `_` and `-`, starting with a letter |
| `model` | Optional. `provider/model`, a model id or a unique part of one, matched like `delegate spawn --model`. Refused when the owner turned off "Let the agent choose the model" and it is not a suggested one |
| `effort` | Optional. One of the model's reasoning levels. Left out: the parent's level on the same model, else the model's default |
| `profile` | Optional. A delegation profile id of this thread. Left out with no `model`, the step runs on the conversation's model |
| `context` | Optional. A [context mode](context-modes.md): `"light"`, `"neutral"` or `{ "preset", "keep", "drop", "tools", "rules" }`. Checked against the step's provider before anything starts |
| `task` | The brief. `{{step}}`, `{{step.field}}`, `{{item}}` and `{{index}}` are filled in when the step starts |
| `after` | Steps that must end first. A step named in `forEach`, `when` or the task is added automatically |
| `forEach` | A path to a list. The step runs once per item |
| `when` | `{ "path", "equals" }`, `{ "path", "notEmpty": true }` or `{ "path", "empty": true }`. A false condition skips the step |
| `output` | The JSON shape the step must return: `"string"`, `"number"`, `"boolean"`, `"any"`, `[shape]` or `{ "key": shape }` |
| `worktree` | Optional. `true` runs the step in a git worktree of its own on a new branch from the conversation's HEAD, as `delegate spawn --worktree` does ([delegation](delegation.md#children-in-their-own-worktree)). The step's `worktree` record, `boite workflow show` and the run's summary name the branch to merge, or say it was removed with nothing in it |
| `machine` | Optional. Another machine of the group, by name or core id prefix as `delegate spawn --machine` takes it. The step runs there ([below](#steps-on-another-machine)). Not with `compute` |
| `project` | Optional, with `machine` only. One of that machine's projects, as `delegate spawn --project`. Left out, the one named like this conversation's project |

### Steps on another machine

A step with `"machine": "pc"` runs as a subagent of the run's conversation on
that machine of the group, the way `delegate spawn --machine` starts one
([delegation](delegation.md#on-another-machine-of-the-group)): in the project
`project` names there, or the one named like this conversation's, on this
conversation's model there or the `model`, `effort` and `profile` the step
names, matched against that machine's list. With `worktree` its branch stays on
that machine. Each attempt asks with a request id made from the run, the
execution and its attempt, so a lost answer or a restart here finds the same
subagent there instead of starting another.

The plan check refuses a machine that is not in the group with the words of
`delegate spawn --machine`. A machine whose owner keeps `groupThreads` off, a
model that machine lacks, or a project it does not have fails the step at
launch with that refusal, which names the setting to propose. A brief that
passes 12,000 characters once the step's instructions wrap it fails the step.

The step settles from that machine's reports, with no polling: once its
subagent ends a turn there, the run reads its whole answer (up to 64,000
characters), takes the last `json` block when the step has `output`, and asks
that subagent once more on a mismatch, as for a step here. `boite workflow
output` does not reach the run from there, so its brief asks only for the block.
Its result and questions never reach the conversation as mail, and `delegate
list` does not show it: its run does. Stop and archive stop it there once that
machine takes the stop; retry starts a new subagent there and stops the old
one. A restart here leaves it at work there: once the run resumes, the same
request id finds it and its last report settles the step. `instance.machine`
keeps the machine, the request id, that machine's thread id (never a local
`threadId`) and the last turn judged.

The optional `compute` field selects an explicitly offered shared-project host:
`{ sharedProjectId, host: { ownerCoreId, coreId, projectId }, profileId, baseCommit }`.
The base is a full commit ID. The host owns model, effort, permissions, context
and checkout; combining this target with `model`, `profile`, `effort`, `context`
or `worktree` is refused.

`host.coreId` may differ from `host.ownerCoreId` when an explicitly associated
project executes on a group member. Preserve the complete tuple from the
shared directory; a public relay thread alias is not an execution host or an
owner credential. Restart and cancellation keep the captured host/job identity.

A path reads a step's structured output, or its final answer when it has none.
On a fanned-out step, `review.bugs` collects the bugs of every item into one
list. The core checks the whole plan before anything starts: a name that is no profile,
a model that is not installed or not allowed, a level the model lacks, cycles, a path to a step that does not exist and a bad shape are refused with
the field named.

`forEach`, `when` and `extend` make a plan dynamic. `forEach` sizes a step
from an earlier step's output. `when` skips a step from one. `boite workflow
extend <run-id> <steps>` adds steps to a run that is still running or paused,
so an agent can plan the next phase after reading the first one.

## Structured output on every provider

A step with `output` returns it one of two ways. The agent can run
`boite workflow output '<json>'`, which checks the shape and says what is wrong,
or it can end its answer with one fenced `json` block. The second way needs no
tool at all, so it works for any driver. On a mismatch the core persists one correction
as a waiting execution with
the error. After the preceding turn is idle, the normal runner admits that
correction under the run's current pause, stop and archive state. A pause keeps
it waiting; stop or archive prevents launch. A second invalid result fails it.
The correction retains the execution's attempt count and original start time;
it does not bypass the scheduler with a detached callback.

The step's brief tells it where it sits in the run, that other steps share the
checkout, and that its answer is collected automatically. Steps share the
parent's working directory: give parallel steps distinct files, or set
`worktree` on a step so it works on a branch of its own and is told to commit
there. A step's result is collected once its worktree is kept or removed.

## Limits

| Limit | Default | Maximum |
| --- | --- | --- |
| Steps in a plan | | 32 |
| Executions in a run, fan-out included (`maxSteps`) | 24 | 64 |
| Executions running at once (`maxConcurrent`) | 3 | 8 |
| Unfinished runs per conversation | | 3 |
| Task after substitution | | 12,000 characters |
| Final answer kept per execution | | 4,000 characters |
| Structured output | | 16,000 characters of JSON |

`maxConcurrent` controls this run. The team adds no concurrency or turn quota.
For a plan containing shared-compute steps, the default and maximum concurrency
ceiling in this table do not apply. A positive explicit plan limit still holds,
and each host enforces its own contribution/resource settings. This permits
four host-local and five remote shared executions without changing ordinary
local plans or adding an exchange/hop limit. In a mixed plan, ordinary steps
keep the default local concurrency of three unless the plan specifies an
explicit limit. Shared steps can still start while those local slots are full;
an explicit plan limit counts both kinds together. Existing step and payload
bounds remain.

Shared executions keep `instance.compute` with their job, owning endpoint,
worker and verified Git result. A remote worker ID is never used as a local
`threadId`. The durable job identity is saved before dispatch, so reconnect or
restart before the response reattaches the same job. A host restart leaves an
interrupted job uncertain; retry first confirms its cancellation before asking
for another job. Results arrive through scoped Contacts notifications; no extra
runner or polling timer is created. Shared result shape mismatches fail the step
and require explicit retry; the local runner's automatic correction is not sent
to another owner's host.

## Failure, stop and restart

A failed step stops new launches. The parent hears of it at once, in a turn
of its own once it is idle, with the error, the steps still running and the
retry command: it can retry the step without waiting for the others. A step
the owner stopped in its own conversation is told the same way, and each
failure is told once. Steps already running finish, the executions that never
launched read stopped ("Not started"), then the run fails and its summary goes
back to the conversation. `boite workflow retry <run-id> <step>`
runs the failed executions again in their own conversations, with the previous
error in the prompt; an execution whose conversation was archived since gets a
new one. The executions held back as "Not started" wait again with it, in any
step. Without a step, retry runs every failed step. While another step stays
failed, retrying one named step is refused with the names of the steps that
still hold the run, and nothing changes.

Handing the summary back is a turn of the parent. If the team is paused before
delivery, the run keeps the reason as `deliveryError` and the panel shows it.
The summary goes again when the parent ends another turn or the owner resumes
the team.

Stop cancels every running step and marks the steps that did not start as
stopped; retry runs them again. Stopping or archiving the parent conversation
stops its runs too. A parent turn that ends in an error or is cut by the system
(a provider at capacity, an agent update) pauses nothing: its runs go on and
their summary reaches it when they end. A team that is
merely disabled holds nothing: only a paused one does. Pause launches nothing new, but
the steps already running still finish, and a paused run whose every step ended
is done.

An update or a restart from the app hands the run over: each running step is
cut at its next tool boundary and waits again with "Interrupted by a core
restart", the run stays running, and the next core runs those steps again with
that line in their prompt ([restart handoff](restart-handoff.md)). After a
crash, or a handoff older than an hour, nothing resumes paid work by itself:
running runs pause, marked as held by a restart, and each interrupted execution
waits on its own thread. Resume runs it again with the same line in its prompt.

A step sent back to work in its own conversation still counts for its run. When
the owner stops a step, the run fails with it; a turn started later in that
step's conversation, by the owner or a letter, takes the step back: the run
runs again, the "Not started" executions wait again, and the step's answer
feeds the steps after it as if it had never stopped. A paused run takes such a
turn too, since the turn runs either way; the pause still holds the steps after
it until the run resumes.

A pause records who set it (`pausedBy`), and that decides who lifts it:

| Paused by | The agent that started the run resumes or retries it |
| --- | --- |
| The agent itself | at any time |
| A restart | at any time |
| The owner's Pause | once the owner wrote to the conversation again |
| The team's pause in Subagents > Settings | never; the run takes the team's origin |

`boite delegate resume` resumes every run a pause held that the agent may lift,
with the team. The owner resumes any of them. An agent pauses, stops, retries
and extends only the runs it started. An agent saves new templates but never
replaces one already saved under that name. A paired phone can follow a run and
stop it; Pause is not offered there, since a phone resumes nothing.

The summary reaches the conversation once it is idle. When the run ends during
one of its turns, delivery waits for that turn to finish.

## Following a run

`boite workflow run` opens the run in the Subagents tab of the
[right panel](panel.md), which lists every run of the conversation above its
subagents.
The chat shows one card per run where it started, with the run's status, steps
done out of the total, one bar per phase and the elapsed time. Clicking it
opens the run.

A run draws its plan top to bottom, the way the panel is shaped: one row per
dependency level, the steps of a row side by side, and an arrow down from each
step to the steps waiting for it. An arrow already implied by another path is
left out. The default panel width and a phone fit two steps in a row. A row
with more steps than fit turns the run into a plain list of phases. A card
shows the step's status, its model, `done/total` and a segmented bar for a
fan-out, and its elapsed time.

Clicking a step run by one subagent opens that subagent's conversation in the
chat, under a "parent / step" header. A step with several executions, or none
started yet, opens its detail: dependencies, condition, each execution and its
structured output, with "Open conversation" for the execution picked. The arrow
in the run's header goes back to the list. Templates are saved, listed and started from the
CLI only.

Captures: [the graph on the desktop](images/workflow-desktop.png) · [a step's
detail](images/workflow-step.png) · [the graph on a phone](images/workflow-phone.png)

## Commands

```sh
boite workflow help                     # plan format and command help
boite workflow check <plan.json|json>   # validate and print the columns
boite workflow run <plan.json|json>     # start a run and open its panel
boite workflow list
boite workflow show <run-id>            # executions, threads and output
boite workflow extend <run-id> <steps>
boite workflow pause|resume|stop <run-id>
boite workflow retry <run-id> [step]
boite workflow output <json>            # submit from inside a step
boite workflow templates
boite workflow save <name> <plan|run-id>
boite workflow start <template>
```

After `run`, the agent should do other work or end its turn. Results arrive as a
message; polling `show` keeps the parent busy and can
delay their delivery.

## Where it lives

The graph shows each step's reasoning effort and cumulative reported tokens,
with the run's total in its header, including zero before the first report.
Counts include input, output, cache reads, cache writes and previous attempts,
including a retry that replaced an archived child. Fan-out details also show
each execution's tokens. Usage arrives when a provider finishes a turn;
tokens still being generated are not estimated. Older cores without execution
usage keep the run total and omit per-step counts.

The plan checks and the path rules are shared by the core and the UI in
`packages/contracts/src/workflow-plan.ts`. The core's runner is
`packages/core/src/workflows.ts`. It keeps a durable JSON record per run and
rereads it across synchronous turn completion and later admission. Close
fences prevent callbacks from launching after teardown begins. Step threads
are ordinary child conversations, recorded in `workflow_steps`. The CLI is
`packages/core/src/workflow-cli.ts`; `WorkflowRunPane.svelte` displays the run
inside `DelegationSurface.svelte`. The fake client
runs plans in memory in `packages/ui/src/lib/fake-client/workflows.ts`. A task
that contains the word "fail" fails there, so retry can be tried on `?fake=1`.
