import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The check names a pull request run reports on its head, whether each job
// runs or skips, for a ruleset that requires them directly
// (docs/ci.md#check-names). A name holds no expression: a skipped matrix job
// reports its unexpanded template, so every required job is written out.

const WORKFLOWS = join(import.meta.dir, '../../.github/workflows');

export type Job = {
  name?: string;
  uses?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  env?: Record<string, unknown>;
  strategy?: { matrix?: unknown };
};
export type Workflow = { on?: unknown; jobs: Record<string, Job> };
export type Load = (file: string) => Workflow;

export const loadWorkflow: Load = (file) => Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;

// The `CI required` gate leaves the ruleset in step 4 of the switch and the
// workflow in step 5; a draft names it `CI draft`, so it is no fixed name.
export const GATE_JOB = 'required';
export const GATE_NAME = 'CI required';

function list(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Every check a job reports: its name, or for a caller each name of the workflow it calls. */
export function jobChecks(file: string, id: string, job: Job, load: Load = loadWorkflow): string[] {
  if (job.strategy?.matrix !== undefined) throw new Error(`${file}: job ${id} is a matrix; a skipped one reports its template name`);
  const name = job.name ?? id;
  if (name.includes('${{')) throw new Error(`${file}: job ${id} has a computed name: ${name}`);
  if (!job.uses) return [name];
  const called = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/.exec(job.uses)?.[1];
  if (!called) throw new Error(`${file}: job ${id} calls ${job.uses}, outside this repository`);
  return workflowChecks(called, load).map((inner) => `${name} / ${inner}`);
}

export function workflowChecks(file: string, load: Load = loadWorkflow): string[] {
  return Object.entries(load(file).jobs)
    .filter(([id]) => !(file === 'ci.yml' && id === GATE_JOB))
    .flatMap(([id, job]) => jobChecks(file, id, job, load));
}

/** The workflows a pull request starts on its head; pull_request_target runs the base's. */
export function pullRequestWorkflows(files: string[], load: Load = loadWorkflow): string[] {
  return files.filter((file) => {
    const on = load(file).on;
    return on === 'pull_request' || (Array.isArray(on) && on.includes('pull_request'))
      || (typeof on === 'object' && on !== null && 'pull_request' in on);
  });
}

export function requiredChecks(files: string[], load: Load = loadWorkflow): string[] {
  const names = pullRequestWorkflows(files, load).flatMap((file) => workflowChecks(file, load));
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length) throw new Error(`check names reported twice: ${[...new Set(repeated)].join(', ')}`);
  return names.sort();
}

type Ruleset = { rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[] };

/** Compares with `gh api repos/<owner>/<repo>/rulesets/<id>`; the gate may stay until step 4. */
export function compareRuleset(names: string[], ruleset: Ruleset) {
  const required = (ruleset.rules ?? []).filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context);
  return {
    missing: names.filter((name) => !required.includes(name)),
    unknown: required.filter((name) => !names.includes(name) && name !== GATE_NAME),
    gate: required.includes(GATE_NAME),
  };
}

if (import.meta.main) {
  const files = [...new Bun.Glob('*.yml').scanSync(WORKFLOWS)].sort();
  const names = requiredChecks(files);
  const index = process.argv.indexOf('--ruleset');
  if (index === -1) {
    process.stdout.write(`${names.join('\n')}\n`);
  } else {
    const { missing, unknown, gate } = compareRuleset(names, JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')));
    for (const name of missing) console.log(`not required: ${name}`);
    for (const name of unknown) console.log(`required but never reported: ${name}`);
    if (gate) console.log(`still required: ${GATE_NAME}`);
    if (missing.length || unknown.length) process.exit(1);
    console.log(`The ruleset requires the ${names.length} check names a pull request reports`);
  }
}
