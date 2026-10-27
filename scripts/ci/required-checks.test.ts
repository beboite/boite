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
    'Android server / apk',
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

// A skip passes in a ruleset, so a draft must not satisfy it. A skipped job
// reports its name unevaluated, so only the planning job and the reusable
// workflows' callers, which always run, name themselves "(draft)"; every
// other job runs only to fail when a draft run is rerun once the pull request
// is ready, and a conversion to draft fails the required planning name.
// How each direct job's condition starts, and what it decides for a run.
// `stale` is planning's first step: `false` (still a draft) lets a failed
// planning skip as usual; `true` (ready, or no answer) or nothing at all
// (planning failed before it, a fork's draft run approved late included)
// makes the job run only to fail. A cancelled run reports its pending jobs
// cancelled, not skipped (#653), which blocks without a runner.
const STALE = "!cancelled() && github.event.pull_request.draft && (needs.changes.outputs.stale == 'true' || needs.changes.result != 'success' && needs.changes.outputs.stale != 'false')";
type Run = { draft: boolean; changes: 'success' | 'failure'; stale: 'true' | 'false' | ''; cancelled?: boolean };
const runsStale = (run: Run) => !run.cancelled && run.draft && (run.stale === 'true' || run.changes !== 'success' && run.stale !== 'false');

test('a draft run fails its direct jobs unless planning saw a draft, whatever the attempt', () => {
  // Planning failed at setup, before the flag read: no output.
  expect(runsStale({ draft: true, changes: 'failure', stale: '' })).toBe(true);
  expect(runsStale({ draft: true, changes: 'success', stale: 'true' })).toBe(true);
  expect(runsStale({ draft: true, changes: 'failure', stale: 'true' })).toBe(true);
  // Still a draft and its repository checks failed: the usual skips, no runner.
  expect(runsStale({ draft: true, changes: 'failure', stale: 'false' })).toBe(false);
  expect(runsStale({ draft: true, changes: 'success', stale: 'false' })).toBe(false);
  expect(runsStale({ draft: false, changes: 'failure', stale: '' })).toBe(false);
  expect(runsStale({ draft: true, changes: 'failure', stale: '', cancelled: true })).toBe(false);
});

test('a draft passes no required name, rerun or converted', () => {
  const ci = loadWorkflow('ci.yml');
  const changes = ci.jobs.changes as Job & { steps: { id?: string; if?: string; run?: string }[]; permissions: Record<string, string> };
  expect(jobNames(changes, 'changes')).toEqual({ draft: 'Plan and repository checks (draft)', ready: 'Plan and repository checks' });
  expect(changes.name).toContain("github.event.action != 'converted_to_draft'");
  const [stale, conversion] = changes.steps;
  expect(stale!.id).toBe('stale');
  expect(stale!.if).toBe('github.event.pull_request.draft');
  // Fail closed: only a draft answer gives `false`; an unreadable one is stale.
  expect(stale!.run).toContain('if [ "$draft" = true ]; then\n  echo "stale=false"');
  expect((changes as Job & { outputs: Record<string, string> }).outputs.stale).toBe('${{ steps.stale.outputs.stale }}');
  expect(conversion!.if).toBe("github.event.action == 'converted_to_draft'");
  expect(conversion!.run).toContain('exit 1');
  expect(changes.permissions['pull-requests']).toBe('read');

  const ready = requiredChecks(files);
  const draftNames = requiredChecks(files, loadWorkflow, true);
  for (const [id, job] of Object.entries(ci.jobs)) {
    if (id === 'changes' || id === 'ruleset') continue;
    if (job.uses) {
      expect(jobChecks('ci.yml', id, job, loadWorkflow, true).filter((name) => ready.includes(name))).toEqual([]);
      continue;
    }
    // Every other job keeps a fixed name, and a stale draft run makes it run and fail.
    expect(jobNames(job, id).draft).toBe(jobNames(job, id).ready);
    expect(job.if).toStartWith(`\${{ ${STALE} || success() && (`);
    const [stop] = (job as Job & { steps: { if?: string; run?: string }[] }).steps;
    expect(stop!.if).toBe("needs.changes.result != 'success' || needs.changes.outputs.stale == 'true'");
    expect(stop!.run).toContain('exit 1');
  }
  expect(draftNames).toContain('Desktop (draft) / Linux x64');
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
  expect(() => requiredChecks(['x.yml'], load({ a: { name: "${{ github.event.pull_request.draft && 'A (draft)' || 'B' }}" } }))).toThrow('computed name');
  for (const name of ["${{ github.event.pull_request.draft && 'A (draft)' || 'A' }}", "${{ github.event.pull_request.draft && github.event.action != 'converted_to_draft' && 'A (draft)' || 'A' }}"]) {
    const both = load({ a: { name } });
    expect([requiredChecks(['x.yml'], both), requiredChecks(['x.yml'], both, true)]).toEqual([['A'], ['A (draft)']]);
  }
  expect(requiredChecks(['x.yml'], load({ a: { name: 'A', if: "github.event_name != 'pull_request'" } }))).toEqual([]);
  expect(requiredChecks(['x.yml'], () => ({ on: { push: null }, jobs: { a: {} } }))).toEqual([]);
});

// changes.ts picks the runners and platforms; each written-out job must run
// on the one it names, or a selected leg would skip without a failure.
test('each core job runs on its CORE_ALL runner when coreRunners lists it', () => {
  const jobs = Object.entries(loadWorkflow('ci.yml').jobs).filter(([id]) => id.startsWith('core-'));
  expect(jobs.map(([id, job]) => ({ os: job['runs-on'], name: jobNames(job, id).ready })))
    .toEqual(CORE_ALL.map((runner) => ({ os: runner.os, name: `Core tests (${runner.name})` })));
  for (const [, job] of jobs) {
    expect(job.if).toBe(`\${{ ${STALE} || success() && (needs.changes.outputs.core == 'true' && contains(needs.changes.outputs.coreRunners, '"os":"${job['runs-on']}"')) }}`);
  }
  // The quoted label cannot match a longer one.
  const pr = JSON.stringify(CORE_ALL.filter((runner) => runner.os !== 'ubuntu-24.04'));
  expect(pr.includes('"os":"ubuntu-24.04"')).toBe(false);
  expect(pr.includes('"os":"ubuntu-24.04-arm"')).toBe(true);
});

test('protection changes run the native fixture inside the existing Windows core check', () => {
  const ci = loadWorkflow('ci.yml');
  const changes = ci.jobs.changes as Job & { outputs: Record<string, string> };
  expect(changes.outputs.nativeWindows).toBe('${{ steps.filter.outputs.nativeWindows }}');
  const windows = ci.jobs['core-windows-x64'] as Job & { 'timeout-minutes': number; steps: { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> }[] };
  const helper = windows.steps.find(step => step.name === 'Build userspace native helper')!;
  const native = windows.steps.find(step => step.name === 'Native Windows protected tools')!;
  const prepare = windows.steps.find(step => step.name === 'Prepare synthetic native providers')!;
  const providers = windows.steps.find(step => step.name === 'Native Windows provider and shared scopes')!;
  expect(helper.id).toBe('native_helper');
  expect(prepare).toMatchObject({id: 'native_providers', if: "${{ !cancelled() && runner.os == 'Windows' && needs.changes.outputs.nativeWindows == 'true' && steps.native_helper.outcome == 'success' }}"});
  expect(providers.if).toBe("${{ !cancelled() && runner.os == 'Windows' && needs.changes.outputs.nativeWindows == 'true' && steps.native_providers.outcome == 'success' }}");
  expect(windows['timeout-minutes']).toBe(30);
  expect(providers.env).toMatchObject({BOITE_TEST_NATIVE_EXECUTION: '1', BOITE_DIAGNOSE_JOB_EVENTS: '1'});
  expect(providers.run).toContain("@('protected-tool.exe', 'protected-tool-mingw.exe')");
  expect(providers.run).toContain('bun test packages/core/test/protected-muse.test.ts --timeout 120000');
  expect(helper.if).toBe("runner.os == 'Windows' && needs.changes.outputs.nativeWindows == 'true'");
  expect(native.if).toBe(helper.if);
  expect(helper.run).toContain('bun packages/core/bin/install-windows-sandbox.ts');
  expect(helper.run).toContain('BOITE_WINDOWS_SANDBOX_PATH=');
  expect(helper.run).toContain('$env:GITHUB_ENV');
  expect(windows.steps.indexOf(helper)).toBeLessThan(windows.steps.indexOf(native));
  expect(native.env).toMatchObject({ BOITE_TEST_NATIVE_EXECUTION: '1', TEMP: '${{ runner.temp }}', TMP: '${{ runner.temp }}' });
  expect(native.run).toBe(`$failed = $false
foreach ($helper in @('protected-tool.exe', 'protected-tool-mingw.exe')) {
  Write-Host "Native fixture helper: $helper"
  $env:BOITE_WINDOWS_SANDBOX_PATH = "$env:RUNNER_TEMP\\$helper"
  bun test packages/core/test/protected-windows.test.ts --timeout 120000
  if ($LASTEXITCODE -ne 0) { $failed = $true }
}
if ($failed) { exit 1 }
`);
  expect(windows.steps.some(step => step.run === 'bun run --cwd packages/core test')).toBe(true);
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
