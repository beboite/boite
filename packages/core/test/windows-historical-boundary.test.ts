import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureExecutionPolicy} from '../src/execution-policy.ts';
import {WindowsExecutionBoundary} from '../src/platform/windows/protected.ts';
import {HistoricalWindowsExecutionBoundary} from './fixtures/windows-historical-boundary.ts';
import {thrown} from './settle.ts';

// Exercise the actual boundary orchestration with the version in its C input.
// This runner never executes the synthetic helper or creates a native profile.
test('historical diagnostics reach their original setup and probe without entering the v2 broker', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-historical-boundary-'))), oldRoot = process.env.SystemRoot;
  const checkout = join(root, 'project'), windows = join(root, 'windows'), helper = join(root, 'historical.exe');
  const calls: string[][] = [], privateRoots: string[] = [];
  try {
    mkdirSync(checkout); mkdirSync(windows); writeFileSync(join(checkout, 'ordinary.txt'), 'synthetic');
    writeFileSync(helper, 'synthetic historical helper', {mode: 0o700}); process.env.SystemRoot = windows;
    const source = readFileSync(join(import.meta.dir, '../../../tests/diagnostics/windows-protected-reference.c'), 'utf8');
    const version = /#define VERSION L"([^"]+)"/.exec(source)![1]!;
    const policy = captureExecutionPolicy({scope: {kind: 'job', id: 'historical', associationId: 'synthetic', grantRevision: 1},
      checkout, credentialPaths: [], executables: [helper], expiresAt: Date.now() + 60000});
    const session = await new HistoricalWindowsExecutionBoundary(() => helper).open(policy, async (_command, args) => {
      calls.push(args);
      if (args[0] === '--version') return {code: 0, stdout: version, stderr: ''};
      if (args[0] === 'setup') {privateRoots.push(args[2]!); return {code: 0, stdout: 'protected-native-prepared', stderr: ''};}
      if (args[0] === 'run' && args[4] === '--probe') return {code: 0, stdout: version, stderr: ''};
      throw new Error(`Unexpected historical call: ${JSON.stringify(args)}`);
    });
    expect(calls.map(args => args[0])).toEqual(['--version', 'setup', 'run']);
    expect(calls[2]![4]).toBe('--probe');
    expect(session.launch(helper, [], checkout).args[0]).toBe('run');
    // No native profile exists to delete. Remove the captured private view
    // directly, without invoking userenv.dll in this portable transcript test.
  } finally {
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    for (const path of privateRoots) rmSync(path, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  }
});

test('production still rejects the historical v1 helper before setup', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-production-version-'))), oldRoot = process.env.SystemRoot;
  try {
    const checkout = join(root, 'project'), windows = join(root, 'windows'), helper = join(root, 'historical.exe');
    mkdirSync(checkout); mkdirSync(windows); writeFileSync(helper, 'synthetic historical helper'); process.env.SystemRoot = windows;
    const policy = captureExecutionPolicy({scope: {kind: 'job', id: 'current', associationId: 'synthetic', grantRevision: 1},
      checkout, credentialPaths: [], expiresAt: Date.now() + 60000});
    const calls: string[][] = [];
    expect(await thrown(new WindowsExecutionBoundary(() => helper).open(policy, async (_command, args) => {
      calls.push(args); return {code: 0, stdout: 'boite-windows-protected 1', stderr: ''};
    }))).toThrow('expected boite-windows-protected 2');
    expect(calls).toEqual([['--version']]);
  } finally {
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    rmSync(root, {recursive: true, force: true});
  }
});
