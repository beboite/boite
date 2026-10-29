import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The check names a pull request run reports on its head, whether each job
// runs or skips: the ruleset requires each of them (docs/ci.md#check-names).
// A name holds no expression: a skipped matrix job reports its unexpanded
// template, so every required job is written out.

// A job that never runs on a pull request guards none: its skip is no check.
const NOT_ON_PULL_REQUESTS = "github.event_name != 'pull_request'";

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
  return Object.entries(load(file).jobs).filter(([, job]) => job.if !== NOT_ON_PULL_REQUESTS)
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

/** The names a pull request reports, which the ruleset requires. */
export function requiredChecks(files: string[], load: Load = loadWorkflow): string[] {
  const names = pullRequestWorkflows(files, load).flatMap((file) => workflowChecks(file, load));
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length) throw new Error(`check names reported twice: ${[...new Set(repeated)].join(', ')}`);
  return names.sort();
}

type Rule = { type: string; parameters?: { required_status_checks?: { context: string }[] } };

/**
 * Compares with the rules for a branch (`gh api repos/<owner>/<repo>/rules/branches/main`,
 * every ruleset that applies) or one ruleset (`.../rulesets/<id>`).
 */
export function compareRuleset(names: string[], rules: Rule[] | { rules?: Rule[] }) {
  const required = (Array.isArray(rules) ? rules : rules.rules ?? []).filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context);
  return {
    missing: names.filter((name) => !required.includes(name)),
    unknown: [...new Set(required.filter((name) => !names.includes(name)))],
  };
}

/** The rules main's pull requests merge under, or undefined when this token cannot read them. */
async function liveRules(): Promise<Rule[] | undefined> {
  const { GITHUB_API_URL: api = 'https://api.github.com', GITHUB_REPOSITORY: repo = 'mtsu-dev/boite', GH_TOKEN: token } = process.env;
  try {
    const response = await fetch(`${api}/repos/${repo}/rules/branches/main`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return await response.json() as Rule[];
  } catch (error) {
    console.log(`::warning::the rules for main are unreadable here (${error instanceof Error ? error.message : String(error)}); check names not compared`);
    return undefined;
  }
}

if (import.meta.main) {
  const files = [...new Bun.Glob('*.yml').scanSync(WORKFLOWS)].sort();
  const names = requiredChecks(files);
  const index = process.argv.indexOf('--ruleset');
  if (index === -1 && !process.argv.includes('--live')) {
    process.stdout.write(`${names.join('\n')}\n`);
  } else {
    const rules = index === -1 ? await liveRules() : JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8'));
    if (rules === undefined) process.exit(0);
    const { missing, unknown } = compareRuleset(names, rules);
    // Only main's ruleset job runs it: a branch that adds or renames a job
    // diverges until the ruleset follows (docs/ci.md#check-names).
    for (const name of missing) console.log(`::error::not required by the ruleset: ${name}`);
    for (const name of unknown) console.log(`::error::required by the ruleset, reported by no pull request: ${name}`);
    if (missing.length || unknown.length) process.exit(1);
    console.log(`The ruleset requires the ${names.length} check names a pull request reports`);
  }
}
