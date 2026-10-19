import { expect, test } from 'bun:test';
import { CORE_ALL, PORTABLE_ALL } from './changes.ts';
import { compareRuleset, jobChecks, jobNames, loadWorkflow, requiredChecks, type Job, type Workflow } from './required-checks.ts';

const files = [...new Bun.Glob('*.yml').scanSync(`${import.meta.dir}/../../.github/workflows`)].sort();

// A ruleset that requires these names blocks every pull request once one
// is renamed, so a rename fails here first: update the ruleset with it.
test('a pull request reports the same fixed check names whichever jobs run', () => {
  const names = requiredChecks(files);
  for (const name of names) expect(name).not.toContain('${{');
  expect(names).toEqual([
    'Android / apk',
    'Build UI',
    'Bundle size',
    // Written out, not derived from CORE_ALL or PORTABLE_ALL: renaming a runner
    // renames a required check too.
    'Core tests (Linux arm64)',
    'Core tests (Linux x64)',
    'Core tests (Windows x64)',
    'Core tests (macOS arm64)',
    'Core tests (macOS x64)',
    'Desktop / Linux arm64',
    'Desktop / Linux x64',
    'Desktop / macOS arm64',
    'Desktop / macOS x64',
    'Desktop / Windows x64',
    'Desktop / Windows x64 Rust tests',
    'E2E 1/3',
    'E2E 2/3',
    'E2E 3/3',
    'E2E type check',
    'PR title',
    'Plan and repository checks',
    'Server / verify server (amd64)',
    'Server / verify server (arm64)',
    'Stress fixtures',
    'Telemetry relay tests',
    'Type checks and UI tests',
  ].sort());
  // labeler.yml runs the base's workflow through pull_request_target.
});

test('every job a needs chain runs through is in the list, so a skip after a failed dependency comes with a failed check', () => {
  const names = requiredChecks(files);
  const ci = loadWorkflow('ci.yml');
  for (const [id, job] of Object.entries(ci.jobs)) {
    for (const need of [job.needs ?? []].flat()) {
      for (const check of jobChecks('ci.yml', need, ci.jobs[need]!)) expect(names).toContain(check);
    }
  }
});

// A draft cannot satisfy the ruleset: after ready_for_review the required
// planning name stays expected until the full run creates it, and a
// conversion to draft fails it, so an earlier full run's success cannot merge
// next to the draft's skips.
test('a draft reports another planning name and a conversion to draft fails the required one', () => {
  const changes = loadWorkflow('ci.yml').jobs.changes as Job & { steps: { if?: string; run?: string }[] };
  expect(jobNames(changes, 'changes')).toEqual({ draft: 'Plan and repository checks (draft)', ready: 'Plan and repository checks' });
  const [stop] = changes.steps;
  expect(stop!.if).toBe("github.event.action == 'converted_to_draft'");
  expect(stop!.run).toContain('exit 1');
});

test('main compares the names with the live rules in a job no other job needs', () => {
  const ci = loadWorkflow('ci.yml');
  const ruleset = ci.jobs.ruleset as Job & { steps: { run?: string }[] };
  expect(ruleset.needs).toBeUndefined();
  expect(ruleset.if).toBe("github.event_name != 'pull_request'");
  expect(ruleset.steps.map((step) => step.run)).toContain('bun scripts/ci/required-checks.ts --live');
  for (const job of Object.values(ci.jobs)) expect([job.needs ?? []].flat()).not.toContain('ruleset');
  expect(requiredChecks(files)).not.toContain('Ruleset check names');
});

test('matrix jobs and computed names are refused', () => {
  const load = (jobs: Workflow['jobs']) => () => ({ on: { pull_request: null }, jobs });
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'Core tests (${{ matrix.name }})' } }))).toThrow('computed name');
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'Core', strategy: { matrix: { os: ['a', 'b'] } } } }))).toThrow('matrix');
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'A' }, b: { name: 'A' } }))).toThrow('reported twice');
  expect(() => requiredChecks(['x.yml'], load({ a: { name: "${{ github.event.pull_request.draft && 'A' || 'B' }}" } }))).toThrow('computed name');
  expect(requiredChecks(['x.yml'], load({ a: { name: "${{ github.event.pull_request.draft && github.event.action != 'converted_to_draft' && 'A (draft)' || 'A' }}" } }))).toEqual(['A']);
  expect(requiredChecks(['x.yml'], load({ a: { name: 'A', if: "github.event_name != 'pull_request'" } }))).toEqual([]);
  expect(requiredChecks(['x.yml'], () => ({ on: { push: null }, jobs: { a: {} } }))).toEqual([]);
});

// changes.ts picks the runners and platforms; each written-out job must run
// on the one it names, or a selected leg would skip without a failure.
test('each core job runs on its CORE_ALL runner when coreRunners lists it', () => {
  const jobs = Object.entries(loadWorkflow('ci.yml').jobs).filter(([id]) => id.startsWith('core-'));
  expect(jobs.map(([, job]) => ({ os: job['runs-on'], name: job.name })))
    .toEqual(CORE_ALL.map((runner) => ({ os: runner.os, name: `Core tests (${runner.name})` })));
  for (const [, job] of jobs) {
    expect(job.if).toBe(`needs.changes.outputs.core == 'true' && contains(needs.changes.outputs.coreRunners, '"os":"${job['runs-on']}"')`);
  }
  // The quoted label cannot match a longer one.
  const pr = JSON.stringify(CORE_ALL.filter((runner) => runner.os !== 'ubuntu-24.04'));
  expect(pr.includes('"os":"ubuntu-24.04"')).toBe(false);
  expect(pr.includes('"os":"ubuntu-24.04-arm"')).toBe(true);
});

test('each portable desktop job builds its PORTABLE_ALL platform when platforms lists it', () => {
  const jobs = Object.entries(loadWorkflow('desktop.yml').jobs).filter(([id]) => id.startsWith('portable-'));
  expect(jobs.map(([id, job]) => ({
    id: id.slice('portable-'.length), name: job.name, runner: job['runs-on'], target: job.env?.BOITE_TARGET || undefined,
  }))).toEqual(PORTABLE_ALL.map(({ id, name, runner, target }) => ({ id, name, runner, target })));
  for (const [id, job] of jobs) {
    const platform = id.slice('portable-'.length);
    expect(job.if).toBe(`inputs.enabled && contains(inputs.platforms, '"id":"${platform}"')`);
    expect(job.env).toMatchObject({ PORTABLE_ID: platform, PORTABLE_RUNNER: job['runs-on'] });
  }
});

test('the ruleset comparison names what to add and what no run reports', () => {
  const rules = (contexts: string[]) => [{ type: 'deletion' }, {
    type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) },
  }];
  expect(compareRuleset(['A', 'B'], rules(['A', 'B']))).toEqual({ missing: [], unknown: [] });
  // One ruleset's own rules, as `rulesets/<id>` answers.
  expect(compareRuleset(['A', 'B'], { rules: rules(['A', 'B']) })).toEqual({ missing: [], unknown: [] });
  // The removed gate, reported by no workflow, would block every pull request.
  expect(compareRuleset(['A', 'B'], rules(['A', 'CI required', 'Core tests (${{ matrix.name }})']))).toEqual({
    missing: ['B'], unknown: ['CI required', 'Core tests (${{ matrix.name }})'],
  });
});
