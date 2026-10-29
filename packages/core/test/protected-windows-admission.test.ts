import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {thrown} from './settle.ts';
import {admitWindowsExecution, windowsHelperIdentity, windowsHelperVersion, type WindowsAdmission} from '../src/platform/windows/protected-admission.ts';
import type {ProtectionRunner} from '../src/platform/protected.ts';

const scratch: string[] = [];
afterEach(() => {for (const path of scratch.splice(0)) rmSync(path, {recursive: true, force: true});});
const nullDenied = {code: 125, stdout: '', stderr: 'execution.windows.probe.null-device: native call failed (5); no unprotected fallback\r\nexecution.windows.child: exit status 125\r\n'};
const admitted = {code: 0, stdout: windowsHelperVersion, stderr: ''};
function fixture(): WindowsAdmission {
  const root = mkdtempSync(join(tmpdir(), 'boite-windows-admission-')); scratch.push(root);
  const helper = join(root, 'protected-tool.exe'); writeFileSync(helper, 'captured helper fixture');
  return {helper, identity: windowsHelperIdentity(helper), profile: 'private-profile', checkout: join(root, 'project'), probe: join(root, 'probe.exe'),
    ambient: join(root, 'ambient-probe'), scratch: root, env: {HOME: join(root, 'home')}};
}

test('a native Null denial repeats the same protected probe and pins the broker mode', async () => {
  const input = fixture(), calls: Parameters<ProtectionRunner>[] = [];
  const mode = await admitWindowsExecution(input, async (...args) => {calls.push(args); return calls.length === 1 ? nullDenied : admitted;});
  expect(mode).toBe('run-null-broker');
  expect(calls).toEqual(['run', 'run-null-broker'].map(mode => [input.helper, [mode, input.profile, input.checkout, input.probe, '--probe', input.ambient], input.scratch, input.env]));
});

test('direct admission stays direct, while unrelated failures never try another boundary', async () => {
  const input = fixture(), modes: string[] = [];
  expect(await admitWindowsExecution(input, async (_command, args) => {modes.push(args[0]!); return admitted;})).toBe('run');
  expect(modes).toEqual(['run']);
  for (const result of [
    {...nullDenied, stderr: nullDenied.stderr.replace('null-device', 'ambient-path')},
    {...nullDenied, stderr: nullDenied.stderr.replace('failed (5)', 'failed (2)')},
    {...nullDenied, stdout: 'partial output'},
    {...nullDenied, stderr: nullDenied.stderr + 'execution.windows.launch.token: native call failed (5)\n'},
  ]) {
    let calls = 0;
    expect(await thrown(admitWindowsExecution(input, async () => {calls++; return result;}))).toThrow('no unprotected fallback');
    expect(calls).toBe(1);
  }
});

test('broker failure and wrong probe output cannot admit a session', async () => {
  const input = fixture();
  for (const result of [{code: 125, stdout: '', stderr: 'execution.windows.null-broker: unsupported image'}, {...admitted, stdout: 'stale helper'}]) {
    let calls = 0;
    expect(await thrown(admitWindowsExecution(input, async () => ++calls === 1 ? nullDenied : result))).toThrow('no unprotected fallback');
    expect(calls).toBe(2);
  }
});

test('changed helper bytes reject admission before a broker retry or a successful return', async () => {
  for (const result of [nullDenied, admitted]) {
    const input = fixture(); let calls = 0;
    expect(await thrown(admitWindowsExecution(input, async () => {calls++; writeFileSync(input.helper, 'changed helper'); return result;}))).toThrow('captured launcher');
    expect(calls).toBe(1);
  }
});
