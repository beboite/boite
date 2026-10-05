import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { affectedChecks, ciMode, lastGreen, needsCodeChecks, needsWorkflowLint, plan } from './changes.ts';

const none = { core: false, web: false, desktop: false, server: false, android: false, telemetry: false, e2eTypes: false, stress: false };
const allChecks = { core: true, web: true, desktop: true, server: true, android: true, telemetry: true, e2eTypes: true, stress: true };

test('checks follow runtime boundaries and combine changed paths', () => {
  expect(affectedChecks(['apps/shell/src-tauri/src/main.rs'])).toEqual({ ...none, desktop: true });
  expect(affectedChecks(['Dockerfile'])).toEqual({ ...none, server: true });
  expect(affectedChecks(['packages/ui/src/app.css'])).toEqual({ ...none, web: true, desktop: true, server: true, stress: true });
  expect(affectedChecks(['packages/core/src/main.ts'])).toEqual(allChecks);
  expect(affectedChecks(['tests/e2e/ui.test.ts', 'docker/compose.yml'])).toEqual({ ...none, desktop: true, server: true, e2eTypes: true });
});

test('only the wrapper and its own pipeline build the APK', () => {
  for (const file of ['apps/android/app/build.gradle', '.github/workflows/android.yml', 'scripts/ci/android-apk.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, android: true });
  }
});

test('ordinary benches and architecture scripts keep the cheap type-check route', () => {
  for (const file of ['bench/retitle.ts', 'scripts/architecture/check.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, web: true });
  }
  expect(affectedChecks(['bench/retitle.ts', 'packages/core/src/main.ts'])).toEqual(allChecks);
});

test('telemetry-only changes require behavioral relay coverage on PRs and main', () => {
  for (const file of ['telemetry/src/index.ts', 'telemetry/wrangler.toml']) {
    const checks = affectedChecks([file]);
    expect(checks).toEqual({ ...none, web: true, telemetry: true });
    for (const mode of ['pr', 'warm', 'full'] as const) expect(plan(checks, mode).telemetry).toBe(true);
  }
});

test('E2E-only changes require focused type checking without UI unit tests', () => {
  for (const file of ['tests/e2e/ui.test.ts', 'tests/e2e/lib/core.ts', 'tests/e2e/tsconfig.json']) {
    expect(plan(affectedChecks([file]), 'pr')).toMatchObject({ desktop: true, e2e: true, e2eTypes: true, web: false });
  }
});

test('stress fixtures and their bench helpers require the bounded stress suite', () => {
  for (const file of ['tests/stress/drivers.test.ts', 'tests/stress/lib/protocol-load.ts', 'bench/agent-stress.ts', 'bench/lib/health.ts']) {
    expect(affectedChecks([file])).toEqual({ ...none, web: true, stress: true });
  }
  for (const mode of ['pr', 'warm', 'full'] as const) {
    expect(plan(affectedChecks(['packages/core/src/scheduler.ts']), mode).stress).toBe(true);
  }
  expect(affectedChecks(['packages/ui/src/App.svelte'])).toEqual({ ...none, web: true, desktop: true, server: true, stress: true });
  expect(affectedChecks(['tests/e2e/lib/core.ts'])).toEqual({ ...none, desktop: true, e2eTypes: true, stress: true });
});

test('shared inputs and unknown files fail open to every check', () => {
  for (const file of ['bun.lock', 'package.json', 'packages/contracts/src/index.ts', '.github/workflows/ci.yml', 'new-config.json']) {
    expect(Object.values(affectedChecks([file])).every(Boolean)).toBe(true);
  }
  expect(Object.values(affectedChecks(['README.md', '.coderabbit.yaml'])).some(Boolean)).toBe(false);
});

test('docs-only changes keep the cheap check path', () => {
  expect(needsCodeChecks(['README.md', 'docs/server.md', 'LICENSE'])).toBe(false);
  expect(needsCodeChecks(['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/CODEOWNERS', '.github/labeler.yml'])).toBe(false);
});

test('workflow lint follows workflows, local actions and their decision scripts', () => {
  expect(needsWorkflowLint(['README.md'])).toBe(false);
  for (const path of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'scripts/ci/changes.ts']) {
    expect(needsWorkflowLint([path])).toBe(true);
  }
});

test('runtime, build inputs and unknown files require the complete suite', () => {
  for (const path of ['packages/core/src/main.ts', 'bun.lock', 'Dockerfile', '.github/workflows/ci.yml', 'new-config.json', 'docs/example.ts']) {
    expect(needsCodeChecks(['README.md', path])).toBe(true);
  }
});

test('pull requests, main pushes and forced runs pick their mode', () => {
  expect(ciMode('pull_request', false)).toBe('pr');
  expect(ciMode('push', false)).toBe('warm');
  expect(ciMode('push', true)).toBe('full');
  expect(ciMode('workflow_dispatch', false)).toBe('full');
  expect(ciMode('schedule', false)).toBe('full');
});

test('main pushes run affected tests while warming the extra portable architectures', () => {
  const all = affectedChecks(['packages/core/src/main.ts']);
  const pr = plan(all, 'pr');
  expect(pr).toMatchObject({ core: true, web: true, desktop: true, server: true, e2e: true });
  const runners = (portable: string) => JSON.parse(portable).map((platform: { runner: string; target?: string }) => platform.target ?? platform.runner);
  expect(runners(pr.portable)).toEqual(['ubuntu-22.04', 'macos-15']);
  const warm = plan(all, 'warm');
  expect(warm).toMatchObject({ core: true, web: true, desktop: true, server: true, e2e: true, stress: true });
  // Intel macOS is cross-built on Apple Silicon: no portable leg waits for an Intel runner.
  expect(runners(warm.portable)).toEqual(['ubuntu-22.04', 'ubuntu-22.04-arm', 'macos-15', 'x86_64-apple-darwin']);
  expect(JSON.parse(warm.portable).map((platform: { runner: string }) => platform.runner)).not.toContain('macos-15-intel');
  const full = plan(all, 'full');
  expect(full).toMatchObject({ core: true, e2e: true });
  expect(JSON.parse(full.portable)).toHaveLength(4);
  expect(plan(affectedChecks(['README.md']), 'warm')).toMatchObject({ ...none, e2e: false });
});

test('a main push compares with the last main commit whose CI passed, skipping cancelled and failed runs', () => {
  const head = 'h'.repeat(40);
  const [green, older] = ['g', 'o'].map((letter) => letter.repeat(40));
  // The API lists only passing runs, newest first: a cancelled or failed push is absent, so its changes stay in the diff.
  const ancestors = new Set([green, older]);
  expect(lastGreen([{ head_sha: green }, { head_sha: older }], head, (sha) => ancestors.has(sha))).toBe(green);
  // A rerun of the head's own passing run, or a newer commit's run, is no base.
  expect(lastGreen([{ head_sha: head }, { head_sha: 'n'.repeat(40) }, { head_sha: older }], head, (sha) => ancestors.has(sha))).toBe(older);
  expect(lastGreen([], head, () => true)).toBeUndefined();
});

test('focused checks are covered by the full core and web jobs when both apply', () => {
  expect(plan(affectedChecks(['telemetry/src/index.ts', 'packages/core/src/main.ts']), 'warm'))
    .toMatchObject({ core: true, telemetry: false, web: true, e2eTypes: false });
});

const python = Bun.which(process.platform === 'win32' ? 'python' : 'python3');
test.skipIf(!python)('the actual required gate rejects failed, cancelled and unexpected job skips', () => {
  const workflow = readFileSync(join(import.meta.dir, '../../.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toContain('name: CI required');
  const match = /          python3 - <<'PY'\n([\s\S]+?)          PY/.exec(workflow);
  if (!match) throw new Error('ci.yml: missing required gate Python script');
  const script = match[1]!.replace(/^ {10}/gm, '');
  const names = ['core', 'web', 'desktop', 'server', 'android', 'telemetry', 'e2e-types', 'stress', 'e2e'];
  const outputFor = (name: string) => name === 'e2e-types' ? 'e2eTypes' : name;
  const cases: { jobs: object; success: boolean }[] = [];
  for (const selected of [names, ['web', 'telemetry'], ['desktop', 'e2e-types', 'e2e'], ['web', 'stress'], []]) {
    const outputs = Object.fromEntries(names.map(name => [outputFor(name), String(selected.includes(name))]));
    const jobs = { changes: { result: 'success', outputs }, ...Object.fromEntries(names.map(name => [name, {
      result: selected.includes(name) ? 'success' : 'skipped',
    }])) } as Record<string, { result: string; outputs?: Record<string, string> }>;
    cases.push({ jobs, success: true });
    for (const name of ['changes', ...selected]) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        cases.push({ jobs: { ...jobs, [name]: { ...jobs[name], result } }, success: false });
      }
    }
    for (const name of names.filter(name => !selected.includes(name))) {
      cases.push({ jobs: { ...jobs, [name]: { result: 'success' } }, success: false });
    }
  }
  // Execute the workflow's own script for every fixture in one Python process.
  const result = Bun.spawnSync([python!, '-c', `
import json, os, sys
script = compile(os.environ['GATE_SCRIPT'], 'ci.yml', 'exec')
cases = json.load(sys.stdin)
for index, case in enumerate(cases):
    os.environ['RESULTS'] = json.dumps(case['jobs'])
    try:
        exec(script, {})
        success = True
    except AssertionError:
        success = False
    assert success == case['success'], (index, case)
print(f"Validated {len(cases)} required-gate results")
`], {
    env: { ...process.env, GATE_SCRIPT: script }, stdin: new TextEncoder().encode(JSON.stringify(cases)),
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`Validated ${cases.length} required-gate results`);
});
