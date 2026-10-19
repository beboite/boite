import { expect, test } from 'bun:test';
import { CORE_ALL, PORTABLE_ALL } from './changes.ts';
import { compareRuleset, GATE_JOB, GATE_NAME, jobChecks, loadWorkflow, requiredChecks, type Workflow } from './required-checks.ts';

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
    ...CORE_ALL.map((runner) => `Core tests (${runner.name})`),
    ...PORTABLE_ALL.map((platform) => `Desktop / ${platform.name}`),
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
  // labeler.yml runs the base's workflow through pull_request_target, so it
  // is absent; so is the gate, which leaves once the ruleset requires these.
  expect(names).not.toContain(GATE_NAME);
});

test('every job a needs chain runs through is in the list, so a skip after a failed dependency comes with a failed check', () => {
  const names = requiredChecks(files);
  const ci = loadWorkflow('ci.yml');
  for (const [id, job] of Object.entries(ci.jobs)) {
    if (id === GATE_JOB) continue;
    for (const need of [job.needs ?? []].flat()) {
      for (const check of jobChecks('ci.yml', need, ci.jobs[need]!)) expect(names).toContain(check);
    }
  }
});

test('the gate waits for every job it judges', () => {
  const gate = loadWorkflow('ci.yml').jobs[GATE_JOB]!;
  const jobs = Object.keys(loadWorkflow('ci.yml').jobs).filter((id) => id !== GATE_JOB && id !== 'ui');
  expect([gate.needs ?? []].flat().sort()).toEqual(jobs.sort());
});

test('matrix jobs and computed names are refused', () => {
  const load = (jobs: Workflow['jobs']) => () => ({ on: { pull_request: null }, jobs });
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'Core tests (${{ matrix.name }})' } }))).toThrow('computed name');
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'Core', strategy: { matrix: { os: ['a', 'b'] } } } }))).toThrow('matrix');
  expect(() => requiredChecks(['x.yml'], load({ a: { name: 'A' }, b: { name: 'A' } }))).toThrow('reported twice');
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

test('the ruleset comparison names what to add and what no run reports, and tolerates the gate', () => {
  const ruleset = (contexts: string[]) => ({ rules: [{ type: 'deletion' }, {
    type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) },
  }] });
  expect(compareRuleset(['A', 'B'], ruleset([GATE_NAME, 'A', 'B']))).toEqual({ missing: [], unknown: [], gate: true });
  expect(compareRuleset(['A', 'B'], ruleset(['A', 'Core tests (${{ matrix.name }})']))).toEqual({
    missing: ['B'], unknown: ['Core tests (${{ matrix.name }})'], gate: false,
  });
});
