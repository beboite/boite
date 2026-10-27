import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {generate, sha256, sourceHash, sourcePath} from './generate.ts';
import {selectedEnvironment} from './environment.ts';
import {loadWorkflow} from '../../../scripts/ci/required-checks.ts';

test('generates only from the frozen historical boundary and rejects source drift', () => {
  const original = readFileSync(sourcePath, 'utf8');
  expect(sha256(original)).toBe(sourceHash);
  const generated = generate(original);
  expect(generated).toContain('#include "routing.h"');
  expect(generated).toContain('(debug_mode ? DEBUG_PROCESS : 0)');
  expect(generated).not.toContain('INFINITE');
  expect(() => generate(original + '\n')).toThrow('review diagnostic provenance');
  expect(readFileSync(sourcePath, 'utf8')).toBe(original);
});

test('selected child environment excludes live opt-ins and unrelated host variables', () => {
  const previous = process.env.DIAGNOSTIC_SYNTHETIC_ACCOUNT;
  process.env.DIAGNOSTIC_SYNTHETIC_ACCOUNT = 'synthetic-only';
  try {
    const selected = selectedEnvironment({HOME: 'synthetic-home'});
    expect(selected.DIAGNOSTIC_SYNTHETIC_ACCOUNT).toBeUndefined();
    expect(selected.HOME).toBe('synthetic-home');
    expect(selected.BOITE_HOST_AGENTS).toBe('0');
    expect(selected.BOITE_TAILNET).toBe('0');
    expect(Object.keys(selected).some(key => /^BOITE_(E2E|BENCH)_/.test(key))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.DIAGNOSTIC_SYNTHETIC_ACCOUNT;
    else process.env.DIAGNOSTIC_SYNTHETIC_ACCOUNT = previous;
  }
});

test('additional diagnostic cannot soften or prevent the original two-compiler native suites', () => {
  type Step = {name?: string; if?: string; run?: string; 'continue-on-error'?: boolean; with?: Record<string, unknown>};
  const workflow = loadWorkflow('ci.yml');
  const steps = (workflow.jobs['core-windows-x64'] as unknown as {steps: Step[]}).steps;
  const diagnostic = steps.findIndex(step => step.name?.startsWith('Diagnostic DEBUG_PROCESS'));
  const original = steps.findIndex(step => step.name === 'Native Windows protected tools');
  expect(diagnostic).toBeGreaterThan(0); expect(original).toBeGreaterThan(diagnostic);
  expect(steps[diagnostic]!['continue-on-error']).toBe(true);
  expect(steps[diagnostic]!.if).toBe("runner.os == 'Windows' && needs.changes.outputs.nativeWindows == 'true'");
  expect(steps[diagnostic]!.run).toContain('$diagnosticExit = $LASTEXITCODE');
  expect(steps[diagnostic]!.run).toContain('exit $diagnosticExit');
  expect(steps[original]!['continue-on-error']).toBeUndefined();
  expect(steps[original]!.run).toContain("@('protected-tool.exe', 'protected-tool-mingw.exe')");
  expect(steps[original]!.run).toContain('bun test packages/core/test/protected-windows.test.ts --timeout 120000');
  expect(steps[original]!.run).toContain('if ($LASTEXITCODE -ne 0) { $failed = $true }');
  expect(steps[original]!.run).toContain('if ($failed) { exit 1 }');
  const artifact = steps.find(step => step.name === 'Preserve DEBUG_PROCESS diagnostic evidence')!;
  expect(artifact.if).toStartWith('always()');
  expect(artifact['continue-on-error']).toBe(true);
  expect(artifact.with?.['retention-days']).toBe(3);
});
