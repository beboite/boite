# Workflows

A workflow is a JSON plan of steps that the core runs for a conversation. Each
step is a child agent on one of the thread's [delegation](delegation.md)
profiles. A step starts once every step it depends on has ended. When the run
ends, its results come back to the conversation as one message. No model sits
in the middle deciding what runs next, so the plan behaves the same whichever
provider wrote it or runs its steps.

The main agent writes a plan and runs it with `boite workflow run`. The owner
can save a run as a template and start it again from the panel. The owner must
enable delegation first, because profiles, the team's concurrency and the
team's turn budget apply to every step.

## A plan

```json
{
  "name": "Review the parser",
  "limits": { "maxConcurrent": 3, "maxSteps": 24 },
  "steps": [
    { "id": "scan", "profile": "fast",
      "task": "List the source files of src/parser that changed this week.",
      "output": { "files": ["string"] } },
    { "id": "review", "profile": "reviewer", "forEach": "scan.files",
      "task": "Review {{item}} for malformed-input bugs. Do not edit files.",
      "output": { "bugs": [{ "line": "number", "text": "string" }] } },
    { "id": "fix", "profile": "fast", "when": { "path": "review.bugs", "notEmpty": true },
      "task": "Fix these bugs, one commit each: {{review.bugs}}" },
    { "id": "report", "profile": "fast", "after": ["fix"],
      "task": "Summarize what was reviewed and fixed: {{review}}" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Letters, digits, `_` and `-`, starting with a letter |
| `profile` | A delegation profile id the owner approved for this thread |
| `task` | The brief. `{{step}}`, `{{step.field}}`, `{{item}}` and `{{index}}` are filled in when the step starts |
| `after` | Steps that must end first. A step named in `forEach`, `when` or the task is added automatically |
| `forEach` | A path to a list. The step runs once per item |
| `when` | `{ "path", "equals" }`, `{ "path", "notEmpty": true }` or `{ "path", "empty": true }`. A false condition skips the step |
| `output` | The JSON shape the step must return: `"string"`, `"number"`, `"boolean"`, `"any"`, `[shape]` or `{ "key": shape }` |

A path reads a step's structured output, or its final answer when it has none.
On a fanned-out step, `review.bugs` collects the bugs of every item into one
list. The core checks the whole plan before anything starts: unknown profiles,
cycles, a path to a step that does not exist and a bad shape are refused with
the field named.

`forEach`, `when` and `extend` make a plan dynamic. `forEach` sizes a step
from an earlier step's output. `when` skips a step from one. `boite workflow
extend <run-id> <steps>` adds steps to a run that is still running or paused,
so an agent can plan the next phase after reading the first one.

## Structured output on every provider

A step with `output` returns it one of two ways. The agent can run
`boite workflow output '<json>'`, which checks the shape and says what is wrong,
or it can end its answer with one fenced `json` block. The second way needs no
tool at all, so it works for any driver. On a mismatch the core sends the step
one more turn with the error, and then fails it.

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

`maxConcurrent` is also held to the team's own concurrency, and every step turn
counts against the team's turn budget.

## Failure, stop and restart

A failed step stops new launches. Steps already running finish, then the run
fails and its summary goes back to the conversation. `boite workflow retry
<run-id> <step>` runs the failed executions again in their own conversations,
with the previous error in the prompt.

Stop cancels every running step and marks the steps that did not start as
stopped; retry runs them again. Stopping or archiving the parent conversation
stops its runs too. A core restart never resumes paid work by itself: running
runs pause, and each interrupted execution waits on its own thread. Resume runs
it again with "Interrupted by a core restart" in its prompt.

Resume is an owner action. An agent pauses, stops, retries and extends only the
runs it started, and retries none while the run is paused. A paired phone can
follow a run, pause it and stop it.

The summary reaches the conversation once it is idle. When the run ends during
one of its turns, delivery waits for that turn to finish.

## Following a run

`boite workflow run` opens the Workflows tab in the [right panel](panel.md).
The chat shows one card per run where it started, with the run's status, steps
done out of the total, one bar per phase and the elapsed time. Clicking it
opens the run.

The tab draws the plan as columns, one per dependency level, with an arrow from
each step to the steps waiting for it. An arrow already implied by another path
is left out. When the columns do not fit (the panel at its default width, a
phone), the same run reads as a list of phases from top to bottom. A card shows
the step's status, its model, `done/total` and a segmented bar for a fan-out,
and its elapsed time.

Clicking a step opens its detail: dependencies, condition, each execution, its
structured output and its conversation streaming live. "Open conversation"
jumps to the step's own thread. Saved workflows sit at the bottom of the tab,
where the owner saves the shown run as a template, starts one or deletes one.
The palette's "Show the workflows" toggles the tab.

Captures: [columns on the desktop](images/workflow-desktop.png) · [a step's detail](images/workflow-step.png) · [phases on a phone](images/workflow-phone.png)

## Commands

```sh
boite workflow help                      the plan format, for an agent that never saw it
boite workflow check <plan.json|json>    validate and print the columns
boite workflow run <plan.json|json>      start a run and open it in the panel
boite workflow list
boite workflow show <run-id>             every execution, its thread and its output
boite workflow extend <run-id> <steps>
boite workflow pause|resume|stop <run-id>
boite workflow retry <run-id> [step]
boite workflow output <json>             from inside a step
boite workflow templates
boite workflow save <name> <plan|run-id>
boite workflow start <template>
```

After `run`, the agent should do other work or end its turn. Polling `show`
spends turns for nothing, since the results arrive as a message.

## Where it lives

The plan checks and the path rules are shared by the core and the UI in
`packages/contracts/src/workflow-plan.ts`. The core's runner is
`packages/core/src/workflows.ts`. It keeps one JSON record per run and reloads
it after every change, because a step's turn can end inside the call that
started it. Step threads are ordinary delegated children, recorded in
`workflow_steps`. The CLI is `packages/core/src/workflow-cli.ts`, the panel tab
is `packages/ui/src/components/WorkflowSurface.svelte`, and the fake client
runs plans in memory in `packages/ui/src/lib/fake-client/workflows.ts`. A task
that contains the word "fail" fails there, so retry can be tried on `?fake=1`.
