import { expect, test } from 'bun:test';
import { affectedChecks, needsCodeChecks, needsWorkflowLint } from './changes.ts';

test('checks follow runtime boundaries and combine changed paths', () => {
  expect(affectedChecks(['apps/shell/src-tauri/src/main.rs'])).toEqual({ core: false, web: false, desktop: true, server: false });
  expect(affectedChecks(['Dockerfile'])).toEqual({ core: false, web: false, desktop: false, server: true });
  expect(affectedChecks(['packages/ui/src/app.css'])).toEqual({ core: false, web: true, desktop: true, server: true });
  expect(affectedChecks(['packages/core/src/main.ts'])).toEqual({ core: true, web: true, desktop: true, server: true });
  expect(affectedChecks(['tests/e2e/ui.test.ts', 'docker/compose.yml'])).toEqual({ core: false, web: false, desktop: true, server: true });
});

test('shared inputs and unknown files fail open to every check', () => {
  for (const file of ['bun.lock', 'package.json', 'packages/contracts/src/index.ts', '.github/workflows/ci.yml', 'new-config.json']) {
    expect(Object.values(affectedChecks([file])).every(Boolean)).toBe(true);
  }
  expect(Object.values(affectedChecks(['README.md', '.coderabbit.yaml'])).some(Boolean)).toBe(false);
});

test('docs-only changes keep the cheap check path', () => {
  expect(needsCodeChecks(['README.md', 'docs/server.md', 'LICENSE'])).toBe(false);
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
