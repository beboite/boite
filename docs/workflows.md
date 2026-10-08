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
profile: `{ "id": "review", "profile": "reviewer", ... }`. `"speed": "fast"`
puts it on a speed tier of its model. `boite delegate models` lists the
choices. `boite workflow check` refuses a model, a level or a speed the step
cannot have before anything starts, with the step's place as `steps[0] (review): `
before the message `delegate spawn` gives. The run stores a speed as its tier
id and launches on it, even after a restart cleared the probed model list.

| Field | Meaning |
| --- | --- |
| `id` | Letters, digits, `_` and `-`, starting with a letter |
| `model` | Optional. `provider/model`, a model id or a unique part of one, matched like `delegate spawn --model`. Refused when the owner turned off "Let the agent choose the model" and it is not a suggested one |
| `effort` | Optional. One of the model's reasoning levels. Left out: the parent's level on the same model, else the model's default |
| `speed` | Optional. One of the model's speed tiers, by id or label in any case, such as `fast`. Left out: none, whatever the conversation runs on |
| `profile` | Optional. A delegation profile id of this thread. Left out with no `model`, the step runs on the conversation's model |
| `task` | The brief. `{{step}}`, `{{step.field}}`, `{{item}}` and `{{index}}` are filled in when the step starts |
| `after` | Steps that must end first. A step named in `forEach`, `when` or the task is added automatically |
| `forEach` | A path to a list. The step runs once per item |
| `when` | `{ "path", "equals" }`, `{ "path", "notEmpty": true }` or `{ "path", "empty": true }`. A false condition skips the step |
| `output` | The JSON shape the step must return: `"string"`, `"number"`, `"boolean"`, `"any"`, `[shape]` or `{ "key": shape }` |

A path reads a step's structured output, or its final answer when it has none.
On a fanned-out step, `review.bugs` collects the bugs of every item into one
list. The core checks the whole plan before anything starts: a name that is no profile,
a model that is not installed or not allowed, a level or a speed tier the model lacks, cycles, a path to a step that does not exist and a bad shape are refused with
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
parent's working directory: give parallel steps distinct files.

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

## Failure, stop and restart

A failed step stops new launches. Steps already running finish, the executions
that never launched read stopped ("Not started"), then the run fails and its
summary goes back to the conversation. `boite workflow retry <run-id> <step>`
runs the failed executions again in their own conversations, with the previous
error in the prompt; an execution whose conversation was archived since gets a
new one. The executions held back as "Not started" wait again with it, in any
step.

Handing the summary back is a turn of the parent. If the team is paused before
delivery, the run keeps the reason as `deliveryError` and the panel shows it.
The summary goes again when the parent ends another turn or the owner resumes
the team.

Stop cancels every running step and marks the steps that did not start as
stopped; retry runs them again. Stopping or archiving the parent conversation
stops its runs too. A parent turn that ends in an error pauses every running
run, and the team when there is one, until the owner resumes it. A team that is
merely disabled holds nothing: only a paused one does. Pause launches nothing new, but
the steps already running still finish, and a paused run whose every step ended
is done. A core restart never resumes paid work by itself: running runs pause,
and each interrupted execution waits on its own thread. Resume runs it again
with "Interrupted by a core restart" in its prompt.

Resume is an owner action. An agent pauses, stops, retries and extends only the
runs it started, and retries none while the run is paused. An agent saves new
templates but never replaces one already saved under that name. A paired phone
can follow a run and stop it; Pause is not offered there, since only the owner
resumes.

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

Clicking a step opens its detail: dependencies, condition, each execution, its
structured output and its conversation streaming live in the height left
below. "Open conversation" jumps to the step's own thread. The arrow in the run's
header goes back to the list. Templates are saved, listed and started from the
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
