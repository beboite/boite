/**
 * `boite workflow`: plans go in as JSON (a file or inline), runs come back as
 * one line per step. The help is the format's whole manual, because the
 * model writing a plan may never have seen Boite before.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { WorkflowNode, WorkflowPlan, WorkflowRun, WorkflowStepPlan } from '@boite/contracts';
import type { CoreClient } from './client.ts';

export const WORKFLOW_HELP = `A workflow is a JSON plan the core runs for you: every step is a child
agent on an approved profile (boite delegate profiles), steps run as soon as
the steps they depend on end, and the results come back to you in one message.

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

Fields of a step:
  id        letters, digits, _ or -, starting with a letter
  profile   an approved profile id
  task      the brief; {{step}}, {{step.field}}, {{item}}, {{index}} are filled in
  after     step ids that must end first (steps named anywhere else are added)
  forEach   a path to a list: one execution per item, {{item}} is the item
  when      { "path": ..., "equals": value | "notEmpty": true | "empty": true }
  output    the JSON shape the step must return: "string", "number",
            "boolean", "any", [shape], or { "key": shape }
A path reads a step's output (or its answer when it has none). On a fanned-out
step, "review.bugs" collects the bugs of every item into one list.

A step with output returns it with boite workflow output '<json>' or a final
\`\`\`json block; the core checks the shape and asks once more on a mismatch.
Steps share this checkout: give parallel steps distinct files. A failed step
pauses what depends on it; boite workflow retry <run-id> <step> runs it again.`;

function readPlan(raw: string | undefined, cwd: string, what: string): unknown {
  if (raw === undefined || raw.length === 0) throw new Error(`${what}: pass a JSON file or inline JSON`);
  const trimmed = raw.trim();
  let body = trimmed;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (!existsSync(path)) throw new Error(`${what}: ${path} does not exist`);
    body = readFileSync(path, 'utf8');
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${what}: not JSON (${(error as Error).message})`);
  }
}

const MARK: Record<WorkflowNode['status'], string> = { waiting: '[ ]', running: '[>]', done: '[x]', failed: '[!]', skipped: '[-]', stopped: '[s]' };

function nodeRow(node: WorkflowNode): string {
  const counts = node.forEach === null ? '' : ` ${node.instances.filter(i => i.status === 'done').length}/${node.instances.length}`;
  const model = node.instances.find(i => i.model)?.model;
  return `${MARK[node.status]} ${node.id}${counts} ${node.status}${model ? ` ${model}` : ''}${node.error ? ` error=${JSON.stringify(node.error)}` : ''}`;
}

function runHead(run: WorkflowRun): string[] {
  const steps = run.nodes.reduce((n, node) => n + node.instances.length, 0);
  return [`run: ${run.id}`, `name: ${run.name}`, `status: ${run.status}${run.error ? ` (${run.error})` : ''}`, `executions: ${steps}/${run.limits.maxSteps}`];
}

function value(output: unknown, result: string | null): string {
  if (output !== null && output !== undefined) return JSON.stringify(output);
  return result === null ? '' : JSON.stringify(result);
}

type Print = (lines: string[], value: unknown) => void;

export async function workflowCommand(client: CoreClient, threadId: string, rest: string[], io: { cwd: string }, print: Print, requestId?: string): Promise<void> {
  const action = rest[0] ?? 'help';
  const request = requestId ?? crypto.randomUUID();
  const runId = (): string => {
    if (!rest[1]) throw new Error(`workflow ${action} needs a run id from boite workflow list`);
    return rest[1];
  };
  const control = async (verb: 'pause' | 'resume' | 'stop' | 'retry', stepId?: string) => {
    const run = await client.call('workflows.control', { threadId, runId: runId(), action: verb, ...(stepId ? { stepId } : {}) });
    print([...runHead(run), ...run.nodes.map(nodeRow)], run);
  };
  switch (action) {
    case 'help':
      print([WORKFLOW_HELP], { help: WORKFLOW_HELP });
      return;
    case 'check': {
      const plan = readPlan(rest.slice(1).join(' '), io.cwd, 'workflow check') as WorkflowPlan;
      const { levels } = await client.call('workflows.check', { threadId, plan });
      print(['plan: valid', ...levels.map((ids, i) => `column ${i + 1}: ${ids.join(', ')}`)], { levels });
      return;
    }
    case 'run': {
      const plan = readPlan(rest.slice(1).join(' '), io.cwd, 'workflow run') as WorkflowPlan;
      const run = await client.call('workflows.start', { threadId, plan, requestId: request });
      const shown = await client.call('panel.open', { threadId, surface: { kind: 'workflow', runId: run.id } }).catch(() => ({ shown: false }));
      print([...runHead(run), ...run.nodes.map(nodeRow), `shown to the user: ${shown.shown ? 'yes' : 'no'}`, 'The results arrive as one message when the run ends. Do other work or end your turn; do not poll.'], run);
      return;
    }
    case 'start': {
      const name = rest.slice(1).join(' ').trim();
      if (!name) throw new Error('workflow start needs a template name or id from boite workflow templates');
      const templates = await client.call('workflows.templates.list', { threadId });
      const template = templates.find(t => t.id === name) ?? templates.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (!template) throw new Error(`no template ${JSON.stringify(name)}; boite workflow templates lists them`);
      const run = await client.call('workflows.start', { threadId, plan: template.plan, templateId: template.id, requestId: request });
      await client.call('panel.open', { threadId, surface: { kind: 'workflow', runId: run.id } }).catch(() => undefined);
      print([...runHead(run), ...run.nodes.map(nodeRow)], run);
      return;
    }
    case 'list': {
      const runs = await client.call('workflows.list', { threadId });
      print(runs.length === 0 ? ['workflows: none'] : runs.map(r => `${r.id} ${r.status} ${JSON.stringify(r.name)} ${r.nodes.filter(n => n.status === 'done' || n.status === 'skipped').length}/${r.nodes.length} steps`), runs);
      return;
    }
    case 'show': {
      const run = await client.call('workflows.get', { threadId, runId: runId() });
      const lines = [...runHead(run)];
      for (const node of run.nodes) {
        lines.push(nodeRow(node));
        for (const inst of node.instances) {
          const label = inst.label ? ` ${JSON.stringify(inst.label)}` : '';
          lines.push(`    ${inst.key}${label} ${inst.status}${inst.threadId ? ` thread=${inst.threadId}` : ''}${inst.error ? ` error=${JSON.stringify(inst.error)}` : ''}`);
          const shown = value(inst.output, inst.result);
          if (shown) lines.push(`      ${shown}`);
        }
      }
      print(lines, run);
      return;
    }
    case 'extend': {
      const steps = readPlan(rest.slice(2).join(' '), io.cwd, 'workflow extend');
      const list = (Array.isArray(steps) ? steps : (steps as { steps?: unknown }).steps) as WorkflowStepPlan[];
      const run = await client.call('workflows.extend', { threadId, runId: runId(), steps: list, requestId: request });
      print([...runHead(run), ...run.nodes.map(nodeRow)], run);
      return;
    }
    case 'pause':
    case 'resume':
    case 'stop':
      await control(action);
      return;
    case 'retry':
      await control('retry', rest[2]);
      return;
    case 'output': {
      const raw = rest.slice(1).join(' ');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = readPlan(raw, io.cwd, 'workflow output');
      }
      const result = await client.call('workflows.output', { threadId, value: parsed });
      print([`accepted: ${result.step}`, 'End your turn with a short summary; the output is already recorded.'], result);
      return;
    }
    case 'templates': {
      const templates = await client.call('workflows.templates.list', { threadId });
      print(templates.length === 0 ? ['templates: none'] : templates.map(t => `${t.id} ${JSON.stringify(t.name)} ${t.plan.steps.length} steps`), templates);
      return;
    }
    case 'save': {
      const name = rest[1];
      if (!name) throw new Error('workflow save needs a name, then a plan or a run id');
      const source = rest.slice(2).join(' ');
      const plan = /^wfr_/.test(source)
        ? (await client.call('workflows.get', { threadId, runId: source })).plan
        : readPlan(source, io.cwd, 'workflow save') as WorkflowPlan;
      const template = await client.call('workflows.templates.save', { threadId, name, plan });
      print([`template: ${template.id}`, `name: ${template.name}`], template);
      return;
    }
    default:
      throw new Error(`workflow: unknown action ${action}; boite workflow help`);
  }
}
