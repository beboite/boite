import { expect, test } from 'bun:test';
import { needsCodeChecks, needsWorkflowLint } from './changes.ts';

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
