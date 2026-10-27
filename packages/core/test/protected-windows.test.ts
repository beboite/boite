import {afterEach, describe, expect, test} from 'bun:test';
import type {Pointer} from 'bun:ffi';
import {copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, win32} from 'node:path';
import {startTestCore, waitFor, type TestCore} from './harness.ts';
import {policyFile} from '../src/contacts/file-policy.ts';
import type {ProtectedExecutionInput} from '../src/execution-policy.ts';
import {publicationState} from './fixtures/native-windows-publication.ts';
import {sampleThreadJob} from '../src/platform/windows/jobs.ts';

let harness: TestCore | undefined;
afterEach(async () => {await harness?.stop(); harness = undefined;});
const native = process.platform === 'win32' && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

describe.skipIf(!native)('native Windows protected execution', () => {
  test('a host checkout on the runner volume builds in the selected system-volume private view', async () => {
    const {procs, root, input} = await setup();
    const fixture = join(import.meta.dir, 'fixtures/native-windows-volume.ts');
    copyFileSync(fixture, join(root, 'volume.ts'));
    writeFileSync(join(root, 'answer.js'), 'export const answer = 42;\n');
    const host = procs.spawn('volume-host', process.execPath, [fixture], {cwd: root});
    const [code, out, err] = await Promise.all([host.exited, new Response(host.proc.stdout).text(), new Response(host.proc.stderr).text()]);
    expect(code, err).toBe(0);
    console.error('WINDOWS_VOLUME_HOST', out.trim());
    expect(JSON.parse(out).build).toMatchObject({status: 0, output: true});
    rmSync(join(root, 'volume-dist'), {recursive: true, force: true});
    await procs.protection.install('volume-selected', input(), () => {});
    try {
      const launch = procs.protection.launch('volume-selected', process.execPath, ['volume.ts'], {cwd: root});
      const child = procs.spawn('volume-selected', process.execPath, ['volume.ts'], {cwd: root});
      const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
      console.error('WINDOWS_VOLUME_PRIVATE', JSON.stringify({variant: 'selected', source: root, mode: launch?.args[0], code, out, err}));
      expect(code, err).toBe(0);
      const result = JSON.parse(out);
      expect(result.observations.length).toBe(6);
      expect(win32.parse(result.cwd).root.toLowerCase()).toBe(win32.parse(result.systemRoot).root.toLowerCase());
      expect(result.build).toMatchObject({status: 0, output: true});
    } finally {await procs.protection.release('volume-selected');}
  }, 120000);

  test('an ordinary native process edits, builds and tests without host file authority', async () => {
    harness = await startTestCore();
    const root = join(harness.dataDir, 'project'), outside = join(harness.dataDir, 'outside');
    mkdirSync(root);
    for (const path of [outside, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_PROTECTED');
    writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
    writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer()).toBe(42));\n");
    writeFileSync(join(root, 'innocent.txt'), 'api_key=SYNTHETIC_PROTECTED');
    linkSync(outside, join(root, 'hard-link'));
    const outsideDirectory = join(harness.dataDir, 'outside-directory'); mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'secret'), 'SYNTHETIC_PROTECTED');
    symlinkSync(outsideDirectory, join(root, 'outside-junction'), 'junction');
    copyFileSync(join(import.meta.dir, 'fixtures/native-protected-tool.ts'), join(root, 'tool.ts'));
    const procs = harness.core.procs;
    const captured = await procs.protection.install('windows-native', {scope: {kind: 'job', id: 'native-job', associationId: 'association', grantRevision: 1},
      route: {providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'yolo'}, checkout: root, credentialPaths: [outside], executables: [process.execPath], expiresAt: Date.now() + 120000}, () => {});
    const {dlopen, FFIType, ptr} = await import('bun:ffi');
    const native = dlopen('kernel32.dll', {CreateFileW: {args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr}, CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32}});
    const name = Buffer.from(`${outside}\0`, 'utf16le'), security = Buffer.alloc(24);
    security.writeUInt32LE(24, 0); security.writeUInt32LE(1, 16); // Explicitly inheritable synthetic credential handle.
    const handle = native.symbols.CreateFileW(ptr(name), 0x80000000, 7, ptr(security), 3, 0, null);
    expect(Number(handle)).toBeGreaterThan(0);
    // Probe the first protected process directly. A second descendant could
    // discard a leaked handle and hide a launcher inheritance regression.
    const handleProbe = procs.spawn('windows-native', process.execPath, ['-e', `const {dlopen,FFIType,ptr}=require('bun:ffi'); const k=dlopen('kernel32.dll',{ReadFile:{args:[FFIType.ptr,FFIType.ptr,FFIType.u32,FFIType.ptr,FFIType.ptr],returns:FFIType.i32}}); const bytes=Buffer.alloc(256),used=Buffer.alloc(4); if(k.symbols.ReadFile(${Number(handle)},ptr(bytes),bytes.length,ptr(used),null)) console.log(bytes.toString()); else console.log('denied');`], {cwd: root});
    const [probeCode, probeOut, probeErr] = await Promise.all([handleProbe.exited, new Response(handleProbe.proc.stdout).text(), new Response(handleProbe.proc.stderr).text()]);
    expect(probeOut).not.toContain('SYNTHETIC_PROTECTED');
    if (probeCode === 0) expect(probeOut.trim()).toBe('denied');
    else {expect(probeCode, probeErr).toBe(8); expect(probeErr).toContain('3221225480');} // STATUS_INVALID_HANDLE under strict checking.
    const child = procs.spawn('windows-native', process.execPath, ['tool.ts', outside, outside, String(handle), String(process.pid), 'grow-ledger'], {cwd: root, env: {SYNTHETIC_KEY: 'SYNTHETIC_PROTECTED'}});
    const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
    expect(code, err).toBe(0);
    native.symbols.CloseHandle(handle); native.close();
    const result = JSON.parse(out);
    expect(result, err).toMatchObject({exposed: [], built: true, tested: true, lowbox: true, hostProcessDenied: true, generations: 40});
    if (result.breakaway.created) {
      // Helper success composes with its mandatory exact-job/LPAC binding on
      // this child's CREATE_PROCESS; direct mode cannot supply that witness.
      const launch = procs.protection.launch('windows-native', process.execPath, [], {cwd: root});
      expect(launch?.args[0], err).toBe('run-null-broker');
      expect(result.breakaway).toEqual({created: true, denied: false, pid: expect.any(Number), waited: true, exit: 0, closed: true});
      expect(result.breakaway.pid).toBeGreaterThan(0);
    } else expect(result.breakaway).toEqual({created: false, denied: true, pid: 0, waited: false, exit: null, closed: true});
    await procs.waitForExit('windows-native', [handleProbe.record.pid, child.record.pid]);
    await procs.protection.publish('windows-native', captured.capabilityId);
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('42');
    expect(existsSync(join(root, 'dist/answer.js'))).toBe(true);
  }, 120000);

  test('node and piped standard streams preserve argv while rejecting extra descriptors and account environment', async () => {
    const {procs, root, input} = await setup();
    await procs.protection.install('streams', input(), () => {});
    const program = "const text = await Bun.stdin.text(); console.log(JSON.stringify({text, args:process.argv.slice(1), secret:process.env.SYNTHETIC_KEY ?? null}))";
    const args = ['-e', program, 'quote" and spaces', 'trailing\\', '$(echo unsafe)'];
    const node = procs.spawnChild('streams', process.execPath, args, {cwd: root, env: {SYNTHETIC_KEY: 'SYNTHETIC_PROTECTED'}});
    let output = ''; node.stdout.on('data', bytes => {output += bytes;});
    const exited = new Promise<number | null>((resolve, reject) => {node.once('exit', resolve); node.once('error', reject);});
    node.stdin.end('useful input'); expect(await exited).toBe(0);
    expect(JSON.parse(output)).toEqual({text: 'useful input', args: args.slice(2), secret: null});
    const piped = procs.spawnPiped('streams', process.execPath, args, {cwd: root});
    piped.proc.stdin.write('useful input'); piped.proc.stdin.end();
    expect(JSON.parse(await new Response(piped.proc.stdout).text())).toEqual(JSON.parse(output));
    expect(await piped.exited).toBe(0);
    expect(() => procs.spawn('streams', process.execPath, [], {cwd: root, extraPipes: 1})).toThrow('controlled');
  }, 120000);

  test('exact read exceptions stay read-only and do not grant aliases or original host access', async () => {
    const {procs, root, input} = await setup();
    const stop = harness!.core.bus.onAny((event, payload) => {
      if (event !== 'process.started' && event !== 'process.exited') return;
      const record = payload as {threadId: string; pid: number; parentPid: number | null; exe: string; startedAt: number; exitedAt: number | null};
      if (record.threadId === 'override') console.error('WINDOWS_PUBLICATION_EVENT', JSON.stringify({event, at: performance.now(),
        pid: record.pid, parentPid: record.parentPid, exe: record.exe, startedAt: record.startedAt, exitedAt: record.exitedAt}));
    });
    const observe = (phase: string, rootPid: number) => console.error('WINDOWS_PUBLICATION_STATE', JSON.stringify({phase, rootPid,
      at: performance.now(), job: sampleThreadJob('override'), live: publicationState(procs.liveOf('override'))}));
    try {
      const secret = join(root, '.env'); writeFileSync(secret, 'SYNTHETIC_PROTECTED');
      linkSync(secret, join(root, 'secret-alias'));
      const identity = policyFile(root, '.env').identity;
      const captured = await procs.protection.install('override', input({readOverrides: [{path: '.env', identity, expiresAt: Date.now() + 60000}]}), () => {});
      const result = await execute('override', `const fs = require('fs'); let written = false, alias = false, host = false;
const {dlopen,FFIType,ptr}=require('bun:ffi'); const acl=dlopen('advapi32.dll',{SetNamedSecurityInfoW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.u32}});
const aclDenied=acl.symbols.SetNamedSecurityInfoW(ptr(Buffer.from('.env\\0','utf16le')),1,4,null,null,null,null)===5; acl.close();
try {fs.writeFileSync('.env', 'altered'); written=true;} catch {}
try {fs.readFileSync('secret-alias'); alias=true;} catch {}
try {fs.readFileSync(${JSON.stringify(secret)}); host=true;} catch {}
console.log(JSON.stringify({text:fs.readFileSync('.env','utf8'),written,alias,host,aclDenied}));`, root, observe);
      expect(JSON.parse(result)).toEqual({text: 'SYNTHETIC_PROTECTED', written: false, alias: false, host: false, aclDenied: true});
      await procs.protection.publish('override', captured.capabilityId);
      writeFileSync(secret, 'changed');
      expect(() => procs.spawn('override', process.execPath, ['-e', ''], {cwd: root})).toThrow('authorized file');
    } finally {stop();}
  }, 120000);

  test.each(['revoke', 'expiry', 'root-exit'] as const)('%s terminates a captured detached descendant and cleans task identity and view', async reason => {
    const {dlopen, FFIType, ptr} = await import('bun:ffi');
    const kernel = dlopen('kernel32.dll', {OpenProcess: {args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr},
      WaitForSingleObject: {args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32}, CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32}});
    const {procs, root, input} = await setup();
    const captured = await procs.protection.install('parent', input({expiresAt: Date.now() + (reason === 'expiry' ? 5000 : 60000)}), () => {});
    procs.protection.inherit('parent', 'child');
    expect(procs.protection.policy('child')?.fingerprint).toBe(captured.fingerprint);
    const scratch = procs.protection.launch('child', process.execPath, [], {cwd: root})!.cwd;
    expect(existsSync(scratch)).toBe(true);
    const tool = procs.spawn('child', process.execPath, ['-e', `const p=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); p.unref(); console.log(p.pid); ${reason === 'root-exit' ? 'setTimeout(()=>process.exit(0),2000)' : 'setInterval(()=>{},1000)'}`], {cwd: root});
    const first = await tool.proc.stdout.getReader().read(), pid = Number(new TextDecoder().decode(first.value).trim());
    expect(pid, pid ? '' : await new Response(tool.proc.stderr).text()).toBeGreaterThan(0);
    const held = kernel.symbols.OpenProcess(0x100000, 0, pid); expect(Number(held)).toBeGreaterThan(0);
    try {
      if (reason === 'revoke') await procs.protection.revoke('parent');
      else if (reason === 'root-exit') expect(await tool.exited).toBe(0);
      else await tool.exited;
      expect(kernel.symbols.WaitForSingleObject(held, 5000)).toBe(0);
      if (reason === 'root-exit') await procs.protection.revoke('parent');
      else expect(() => procs.spawn('parent', process.execPath, [], {cwd: root})).toThrow('revoked');
      await waitFor(() => !existsSync(scratch));
      // Recreating the exact name fails with ERROR_ALREADY_EXISTS if cleanup leaked it.
      const userenv = dlopen('userenv.dll', {
        CreateAppContainerProfile: {args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32},
        DeleteAppContainerProfile: {args: [FFIType.ptr], returns: FFIType.i32},
      });
      const advapi = dlopen('advapi32.dll', {FreeSid: {args: [FFIType.ptr], returns: FFIType.ptr}});
      const name = Buffer.from(`boite.tool.${captured.capabilityId}\0`, 'utf16le'), sid = Buffer.alloc(8);
      try {
        expect(userenv.symbols.CreateAppContainerProfile(ptr(name), ptr(name), ptr(name), null, 0, ptr(sid))).toBe(0);
      } finally {
        const pointer = Number(sid.readBigUInt64LE()) as Pointer; if (pointer) advapi.symbols.FreeSid(pointer);
        expect(userenv.symbols.DeleteAppContainerProfile(ptr(name))).toBe(0);
        userenv.close(); advapi.close();
      }
    } finally {if (held) kernel.symbols.CloseHandle(held); kernel.close();}
  }, 120000);

  test('host authority intersection, stop, fresh restart and offline networking fail closed', async () => {
    const {procs, root, input} = await setup();
    let valid = true;
    const captured = await procs.protection.install('scope', input({scope: {kind: 'board', id: 'claim', associationId: 'primary', grantRevision: 3},
      additionalScopes: [{kind: 'letter', id: 'letter', associationId: 'secondary', grantRevision: 4}]}), () => {if (!valid) throw new Error('secondary association revoked');});
    expect(captured.route).toEqual({providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'default'});
    let requests = 0;
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => {requests++; return new Response('SYNTHETIC_PROTECTED');}});
    try {
      const network = procs.spawn('scope', process.execPath, ['-e', `try {await fetch('http://127.0.0.1:${server.port}',{signal:AbortSignal.timeout(1500)}); console.log('escaped')} catch {console.log('offline')}`], {cwd: root});
      const [code, out, err] = await Promise.all([network.exited, new Response(network.proc.stdout).text(), new Response(network.proc.stderr).text()]);
      if (code === 0) expect(out.trim()).toBe('offline');
      else expect(err).toContain('WSAStartup'); // Some LPAC hosts refuse Winsock initialization itself.
      expect(requests).toBe(0); expect(out).not.toContain('escaped');
    } finally {server.stop(true);}
    valid = false;
    expect(() => procs.spawn('scope', process.execPath, [], {cwd: root})).toThrow('secondary association');
    await procs.protection.release('scope'); valid = true;
    const next = await procs.protection.install('scope', input(), () => {});
    expect(next.fingerprint).not.toBe(captured.fingerprint);
    expect((await execute('scope', "console.log('fresh')", root)).trim()).toBe('fresh');
    await procs.protection.revoke('scope');
    expect(() => procs.spawn('scope', process.execPath, [], {cwd: root})).toThrow('revoked');
    const ordinary = procs.spawn('local', process.execPath, ['-e', 'console.log(process.env.SYNTHETIC_KEY)'], {cwd: root, env: {SYNTHETIC_KEY: 'local-retained'}});
    expect((await new Response(ordinary.proc.stdout).text()).trim()).toBe('local-retained'); await ordinary.exited;
  }, 120000);
});

async function setup() {
  harness = await startTestCore();
  const root = join(harness.dataDir, 'project'); mkdirSync(root);
  writeFileSync(join(root, 'ordinary.txt'), 'ordinary');
  const input = (extra: Partial<ProtectedExecutionInput> = {}): ProtectedExecutionInput => ({
    scope: {kind: 'job', id: 'job', associationId: 'association', grantRevision: 1},
    route: {providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'default'}, checkout: root,
    credentialPaths: [], executables: [process.execPath], expiresAt: Date.now() + 120000, ...extra});
  return {procs: harness.core.procs, root, input};
}
async function execute(id: string, script: string, cwd: string, observe?: (phase: string, rootPid: number) => void) {
  const child = harness!.core.procs.spawn(id, process.execPath, ['-e', script], {cwd});
  const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
  observe?.('collected', child.record.pid);
  await harness!.core.procs.waitForExit(id, [child.record.pid]);
  observe?.('root-retired', child.record.pid);
  expect(code, err).toBe(0); return out;
}
