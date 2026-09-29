import { expect, test } from 'bun:test';
import { affectedChecks, ciMode, needsCodeChecks, needsWorkflowLint, plan } from './changes.ts';

test('checks follow runtime boundaries and combine changed paths', () => {
  expect(affectedChecks(['apps/shell/src-tauri/src/main.rs'])).toEqual({ core: false, web: false, desktop: true, server: false });
  expect(affectedChecks(['Dockerfile'])).toEqual({ core: false, web: false, desktop: false, server: true });
  expect(affectedChecks(['packages/ui/src/app.css'])).toEqual({ core: false, web: true, desktop: true, server: true });
  expect(affectedChecks(['packages/core/src/main.ts'])).toEqual({ core: true, web: true, desktop: true, server: true });
  expect(affectedChecks(['tests/e2e/ui.test.ts', 'docker/compose.yml'])).toEqual({ core: false, web: false, desktop: true, server: true });
});

test('benches, telemetry and architecture scripts only need the type checks', () => {
  for (const file of ['bench/retitle.ts', 'telemetry/src/index.ts', 'telemetry/wrangler.toml', 'scripts/architecture/check.ts']) {
    expect(affectedChecks([file])).toEqual({ core: false, web: true, desktop: false, server: false });
  }
  expect(affectedChecks(['bench/retitle.ts', 'packages/core/src/main.ts'])).toEqual({ core: true, web: true, desktop: true, server: true });
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

test('a pull request skips the extra architectures, a main push skips what the pull request passed', () => {
  const all = affectedChecks(['packages/core/src/main.ts']);
  const pr = plan(all, 'pr');
  expect(pr).toMatchObject({ core: true, web: true, desktop: true, server: true, e2e: true });
  expect(JSON.parse(pr.portable)).toEqual(['ubuntu-24.04', 'macos-15']);
  const warm = plan(all, 'warm');
  expect(warm).toMatchObject({ core: false, web: true, desktop: true, server: true, e2e: false });
  expect(JSON.parse(warm.portable)).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel']);
  const full = plan(all, 'full');
  expect(full).toMatchObject({ core: true, e2e: true });
  expect(JSON.parse(full.portable)).toHaveLength(4);
  expect(plan(affectedChecks(['README.md']), 'warm')).toMatchObject({ core: false, web: false, desktop: false, server: false });
});
