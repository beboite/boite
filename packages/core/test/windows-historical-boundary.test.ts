import {expect, spyOn, test} from 'bun:test';
import * as ffi from 'bun:ffi';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureExecutionPolicy} from '../src/execution-policy.ts';
import {WindowsExecutionBoundary} from '../src/platform/windows/protected.ts';
import {windowsHelperVersion} from '../src/platform/windows/protected-admission.ts';
import {HistoricalWindowsExecutionBoundary} from './fixtures/windows-historical-boundary.ts';
import {thrown} from './settle.ts';

test('a failed Windows profile deletion still removes its private checkout and can be retried with launch closed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-windows-cleanup-'))), oldRoot = process.env.SystemRoot;
  let privateRoot = '', attempts = 0, librariesClosed = 0;
  const library = spyOn(ffi, 'dlopen').mockImplementation(((name: string | URL | Bun.BunFile) => {
    if (name !== 'userenv.dll') throw new Error(`Unexpected native library: ${name}`);
    return {symbols: {DeleteAppContainerProfile: () => ++attempts === 1 ? -2147024891 : 0}, close() {librariesClosed++;}};
  }) as unknown as typeof ffi.dlopen);
  try {
    const checkout = join(root, 'project'), windows = join(root, 'windows'), helper = join(root, 'helper.exe');
    mkdirSync(checkout); mkdirSync(windows); writeFileSync(helper, 'synthetic helper'); process.env.SystemRoot = windows;
    const policy = captureExecutionPolicy({scope: {kind: 'job', id: 'cleanup', associationId: 'synthetic', grantRevision: 1},
      checkout, credentialPaths: [], executables: [], expiresAt: Date.now() + 60000});
    const session = await new WindowsExecutionBoundary(() => helper).open(policy, async (_command, args) => {
      if (args[0] === 'setup') {privateRoot = args[2]!; return {code: 0, stdout: 'protected-native-prepared', stderr: ''};}
      return {code: 0, stdout: windowsHelperVersion, stderr: ''};
    });
    expect(existsSync(privateRoot)).toBe(true);
    expect(() => session.close()).toThrow('DeleteAppContainerProfile failed');
    expect(existsSync(privateRoot)).toBe(false);
    expect(() => session.launch(helper, [], checkout)).toThrow('private view is closed');
    await session.close(); await session.close();
    expect(attempts).toBe(2); expect(librariesClosed).toBe(2);
  } finally {
    library.mockRestore();
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    if (privateRoot) rmSync(privateRoot, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  }
});

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

test.each([
  {code: 0, stdout: 'boite-windows-protected 1', stderr: ''},
  {code: 9, stdout: 'boite-windows-protected 2', stderr: 'synthetic probe termination'},
])('production rejects a failed version probe before setup and preserves its result: %j', async result => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-production-version-'))), oldRoot = process.env.SystemRoot;
  try {
    const checkout = join(root, 'project'), windows = join(root, 'windows'), helper = join(root, 'historical.exe');
    mkdirSync(checkout); mkdirSync(windows); writeFileSync(helper, 'synthetic historical helper'); process.env.SystemRoot = windows;
    const policy = captureExecutionPolicy({scope: {kind: 'job', id: 'current', associationId: 'synthetic', grantRevision: 1},
      checkout, credentialPaths: [], expiresAt: Date.now() + 60000});
    const calls: string[][] = [];
    expect(await thrown(new WindowsExecutionBoundary(() => helper).open(policy, async (_command, args) => {
      calls.push(args); return result;
    }))).toThrow(`expected boite-windows-protected 2; received ${JSON.stringify(result)}`);
    expect(calls).toEqual([['--version']]);
  } finally {
    if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
    rmSync(root, {recursive: true, force: true});
  }
});
