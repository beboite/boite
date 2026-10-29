import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startTestCore, waitFor, type TestCore} from './harness.ts';
import type {ProtectedExecutionInput} from '../src/execution-policy.ts';
import {policyFile} from '../src/contacts/file-policy.ts';
import {ProcRegistry} from '../src/procs.ts';
import {Bus} from '../src/bus.ts';
import {createPosixPlatform} from '../src/platform/posix.ts';
import {LinuxExecutionBoundary} from '../src/platform/linux-protected.ts';
import type {NativeExecutionBoundary} from '../src/platform/protected.ts';

let harness: TestCore;
let root: string;
let outside: string;
let credential: string;
beforeEach(async () => {
  harness = await startTestCore();
  root = join(harness.dataDir, 'project');
  outside = join(harness.dataDir, 'outside');
  credential = join(harness.dataDir, 'provider-auth');
  mkdirSync(root);
  for (const path of [outside, credential, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_PROTECTED');
  writeFileSync(join(root, 'innocent.txt'), 'api_key=SYNTHETIC_PROTECTED');
  symlinkSync(outside, join(root, 'outside-link'));
  symlinkSync('.env', join(root, 'secret-link'));
  linkSync(outside, join(root, 'hard-link'));
  writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
  writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer()).toBe(42));\n");
  copyFileSync(join(import.meta.dir, 'fixtures/native-protected-tool.ts'), join(root, 'tool.ts'));
});
afterEach(async () => { await harness.stop(); });

function input(extra: Partial<ProtectedExecutionInput> = {}): ProtectedExecutionInput {
  return {scope: {kind: 'job', id: 'job-fixture', associationId: 'association-fixture', grantRevision: 7},
    checkout: root, credentialPaths: [credential], executables: [process.execPath], expiresAt: Date.now() + 60000, ...extra};
}
const native = process.platform === 'linux' && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

describe.skipIf(!native)('native protected execution', () => {
  test('useful edits and a child build/test cannot read secrets, credentials, links, descriptors or host procfs', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('protected-native', input(), () => {});
    const fd = openSync(outside, 'r');
    const {dlopen, FFIType} = await import('bun:ffi');
    const libc = dlopen('libc.so.6', {fcntl: {args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int}});
    expect(libc.symbols.fcntl(fd, 2, 0)).toBe(0); // Make the synthetic secret descriptor deliberately inheritable.
    try {
      const child = procs.spawn('protected-native', process.execPath, ['tool.ts', outside, credential, String(fd), String(process.pid)], {
        cwd: root, env: {SYNTHETIC_API_KEY: 'SYNTHETIC_PROTECTED', NODE_OPTIONS: '--require=/outside'},
      });
      const [out, err, code] = await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
      expect(code, err).toBe(0);
      expect(JSON.parse(out)).toEqual({exposed: [], built: true, tested: true, nestedNamespaceDenied: true, unixSocketDenied: true});
      expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 41');
      procs.protection.flush('protected-native');
      expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 42');
      expect(existsSync(join(root, 'dist/answer.js'))).toBe(true);
      for (const path of [outside, credential, join(root, '.env'), join(root, 'private.key')]) expect(readFileSync(path, 'utf8')).toBe('SYNTHETIC_PROTECTED');
    } finally { closeSync(fd); libc.close(); }
  }, 30000);

  test('node streams and piped stdin enforce the same environment and native file boundary', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('streams', input(), () => {});
    const node = procs.spawnChild('streams', '/bin/sh', ['-c', 'set -eu; read line; test "$line" = useful; test ! -e "$1"; test ! -e .env; test -z "${SYNTHETIC_API_KEY:-}"; echo node-protected', 'fixture', outside], {cwd: root, env: {SYNTHETIC_API_KEY: 'SYNTHETIC_PROTECTED'}});
    let output = '';
    node.stdout.on('data', b => { output += b.toString(); });
    const exit = new Promise<number | null>((resolve, reject) => { node.once('exit', resolve); node.once('error', reject); });
    node.stdin.end('useful\n');
    expect(await exit).toBe(0);
    expect(output.trim()).toBe('node-protected');
    const piped = procs.spawnPiped('streams', '/bin/sh', ['-c', 'set -eu; read line; test "$line" = useful; test ! -e "$1"; test -z "${SYNTHETIC_API_KEY:-}"; echo piped-protected', 'fixture', outside], {cwd: root, env: {SYNTHETIC_API_KEY: 'SYNTHETIC_PROTECTED'}});
    piped.proc.stdin.write('useful\n');
    piped.proc.stdin.end();
    expect((await new Response(piped.proc.stdout).text()).trim()).toBe('piped-protected');
    expect(await piped.exited).toBe(0);
  });

  test('captured immutable identity follows descendants and retries, then revoke kills detached descendants and removes the private view', async () => {
    const procs = harness.core.procs;
    const request = input({route: {providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'yolo'},
      additionalScopes: [{kind: 'letter', id: 'letter-fixture', associationId: 'additional-association', grantRevision: 2}]});
    const captured = await procs.protection.install('parent', request, () => {});
    request.scope.grantRevision = 99;
    (request.credentialPaths as string[]).length = 0;
    expect(captured.scope.grantRevision).toBe(7);
    expect(captured.credentialPaths).toEqual([credential]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.scope)).toBe(true);
    expect(captured.route).toEqual({providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'yolo'});
    expect(Object.isFrozen(captured.route)).toBe(true);
    expect(Object.isFrozen(captured.additionalScopes[0])).toBe(true);
    procs.protection.inherit('parent', 'descendant');
    expect(procs.protection.policy('descendant')?.fingerprint).toBe(captured.fingerprint);
    const child = procs.spawn('descendant', '/bin/sh', ['-c', 'setsid sh -c "trap \'\' TERM; while :; do sleep 1; done" >/dev/null 2>&1 & echo ready; wait'], {cwd: root});
    expect(new TextDecoder().decode((await child.proc.stdout.getReader().read()).value).trim()).toBe('ready');
    const owned = readdirSync(tmpdir()).filter(p => p.startsWith(`boite-protected-${captured.capabilityId}-`));
    expect(owned).toHaveLength(1);
    const scratch = join(tmpdir(), owned[0]!);
    const descendants = (pid: number): number[] => {
      let direct: number[];
      try { direct = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).filter(Boolean); } catch { return []; }
      return direct.flatMap(p => [p, ...descendants(p)]);
    };
    const capturedPids = descendants(child.record.pid);
    expect(capturedPids.length).toBeGreaterThan(1);
    // A second root can be retried under the same immutable view, never with a fresh unprotected policy.
    const retry = procs.spawn('parent', '/bin/sh', ['-c', 'test ! -e .env && echo retry-protected'], {cwd: root});
    expect((await new Response(retry.proc.stdout).text()).trim()).toBe('retry-protected');
    expect(await retry.exited).toBe(0);
    await procs.protection.revoke('parent');
    expect(await child.exited).not.toBe(0);
    expect(existsSync(scratch)).toBe(false);
    for (const pid of capturedPids) {
      let status = '';
      try { status = readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { /* Reaped. */ }
      expect(status === '' || /^State:\s+Z/m.test(status)).toBe(true);
    }
    expect(() => procs.spawn('descendant', '/bin/sh', ['-c', 'echo escaped'], {cwd: root})).toThrow('revoked');
    expect(() => procs.spawn('parent', '/bin/sh', ['-c', 'echo escaped'], {cwd: root})).toThrow('revoked');
  });

  test('the PID namespace kills a detached tool when its root exits', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('detached', input(), () => {});
    const start = procs.spawn('detached', '/bin/sh', ['-c', 'setsid sh -c "sleep 0.2; echo survived > orphan" >/dev/null 2>&1 & echo root-finished'], {cwd: root});
    await new Response(start.proc.stdout).text();
    expect(await start.exited).toBe(0);
    await Bun.sleep(350);
    const verify = procs.spawn('detached', '/bin/sh', ['-c', 'test ! -e orphan && echo descendants-gone'], {cwd: root});
    expect((await new Response(verify.proc.stdout).text()).trim()).toBe('descendants-gone');
    expect(await verify.exited).toBe(0);
  });

  test('exact read overrides are read-only, identity checked on reuse and never grant an alias', async () => {
    const procs = harness.core.procs;
    const file = policyFile(root, '.env');
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh/id_ed25519'), 'SYNTHETIC_ALLOWED_EXACT_KEY');
    writeFileSync(join(root, '.ssh/other.pem'), 'SYNTHETIC_PROTECTED');
    const key = policyFile(root, '.ssh/id_ed25519');
    const hard = policyFile(root, 'hard-link');
    await procs.protection.install('override', input({readOverrides: [file, key, hard].map(f => ({path: f.path, identity: f.identity, expiresAt: Date.now() + 60000}))}), () => {});
    const tool = procs.spawn('override', '/bin/sh', ['-c', 'set -eu; test "$(cat .env)" = SYNTHETIC_PROTECTED; test "$(cat hard-link)" = SYNTHETIC_PROTECTED; test "$(cat .ssh/id_ed25519)" = SYNTHETIC_ALLOWED_EXACT_KEY; test ! -e .ssh/other.pem; test ! -e secret-link; if printf overwritten > .env; then exit 1; fi; if printf overwritten > .ssh/id_ed25519; then exit 1; fi; echo exact-read-only'], {cwd: root});
    expect((await new Response(tool.proc.stdout).text()).trim()).toBe('exact-read-only');
    expect(await tool.exited).toBe(0);
    procs.protection.flush('override');
    writeFileSync(join(root, '.env'), 'SYNTHETIC_PROTECTED_NEW');
    expect(() => procs.spawn('override', '/bin/sh', ['-c', 'cat .env'], {cwd: root})).toThrow('same authorized file');
    await procs.protection.revoke('override');
  });

  test('expired grants terminate a running namespace and cannot revive on reuse', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('expiry', input({expiresAt: Date.now() + 1000}), () => {});
    const child = procs.spawn('expiry', '/bin/sh', ['-c', 'echo ready; exec sleep 60'], {cwd: root});
    await child.proc.stdout.getReader().read();
    expect(await child.exited).not.toBe(0);
    expect(() => procs.spawn('expiry', '/bin/true', [], {cwd: root})).toThrow('revoked');
  });

  test('scope revalidation rejects a changed grant before tool launch and result publication', async () => {
    const procs = harness.core.procs;
    let revision = 7;
    await procs.protection.install('grant', input(), () => { if (revision !== 7) throw new Error('grant revision changed'); });
    const tool = procs.spawn('grant', '/bin/sh', ['-c', 'echo changed > answer.js'], {cwd: root});
    await tool.exited;
    revision = 8;
    expect(() => procs.protection.flush('grant')).toThrow('grant revision changed');
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 41');
    expect(() => procs.spawn('grant', '/bin/true', [], {cwd: root})).toThrow('revoked');
  });

  test('hidden host paths and links created in the private view cannot be published over protected files', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('publication', input(), () => {});
    const tool = procs.spawn('publication', '/bin/sh', ['-c', 'echo malicious > .env; ln -s "$1" forged', 'fixture', outside], {cwd: root});
    expect(await tool.exited).toBe(0);
    expect(() => procs.protection.flush('publication')).toThrow('not publishable');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SYNTHETIC_PROTECTED');
    expect(readFileSync(outside, 'utf8')).toBe('SYNTHETIC_PROTECTED');
    expect(existsSync(join(root, 'forged'))).toBe(false);
  });

  test('checkout replacement and out-of-scope cwd cannot change the installed authority', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('cwd', input(), () => {});
    expect(() => procs.spawn('cwd', '/bin/true', [], {cwd: harness.dataDir})).toThrow('captured checkout');
    await procs.protection.release('cwd');
    await procs.protection.install('replacement', input(), () => {});
    rmSync(root, {recursive: true});
    symlinkSync(harness.dataDir, root);
    expect(() => procs.spawn('replacement', '/bin/true', [], {cwd: root})).toThrow('captured directory');
  });

  test('extra descriptors and terminal routes fail closed, while unrelated ordinary local processes keep their environment', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('descriptors', input(), () => {});
    expect(() => procs.spawn('descriptors', '/bin/true', [], {cwd: root, extraPipes: 1})).toThrow('controlled stdin');
    expect(() => procs.spawnTerminal('descriptors', '/bin/sh', [], {cwd: root, env: {}, cols: 80, rows: 24, onData() {}})).toThrow('controlled standard pipes');
    const local = procs.spawn('ordinary', '/bin/sh', ['-c', 'set -eu; test "$LOCAL_MARKER" = retained; test -r "$1"; echo ordinary-retained', 'fixture', outside], {cwd: root, env: {LOCAL_MARKER: 'retained'}});
    expect((await new Response(local.proc.stdout).text()).trim()).toBe('ordinary-retained');
    expect(await local.exited).toBe(0);
  });

  test('private snapshots reject host path changes on publication and exclude later host credentials on warm reuse', async () => {
    const procs = harness.core.procs;
    await procs.protection.install('warm', input(), () => {});
    writeFileSync(join(root, 'late-auth'), 'SYNTHETIC_PROTECTED');
    const warm = procs.spawn('warm', '/bin/sh', ['-c', 'set -eu; test ! -e late-auth; echo tool-edit > answer.js'], {cwd: root});
    expect(await warm.exited).toBe(0);
    writeFileSync(join(root, 'answer.js'), 'owner-edit');
    expect(() => procs.protection.flush('warm')).toThrow('host file changed');
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toBe('owner-edit');
  });

  test('isolated networking cannot reach a host-local synthetic credential service', async () => {
    const procs = harness.core.procs;
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('SYNTHETIC_PROTECTED')});
    try {
      await procs.protection.install('network', input(), () => {});
      const tool = procs.spawn('network', process.execPath, ['-e', 'try { const r = await fetch(process.argv[1], {signal: AbortSignal.timeout(500)}); console.log(await r.text()); } catch { console.log("network-denied"); }', server.url.href], {cwd: root});
      expect((await new Response(tool.proc.stdout).text()).trim()).toBe('network-denied');
      expect(await tool.exited).toBe(0);
    } finally { await server.stop(true); }
  });
  test('revocation removes private directories made unreadable by the untrusted tool', async () => {
    const procs = harness.core.procs;
    const policy = await procs.protection.install('hostile-cleanup', input(), () => {});
    const tool = procs.spawn('hostile-cleanup', '/bin/sh', ['-c', 'set -eu; mkdir locked; touch locked/file; chmod 000 locked .'], {cwd: root});
    expect(await tool.exited).toBe(0);
    await procs.protection.revoke('hostile-cleanup');
    expect(readdirSync(tmpdir()).filter(p => p.startsWith(`boite-protected-${policy.capabilityId}-`))).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('protected execution admission failures', () => {
  async function refusedBoundary(boundary: NativeExecutionBoundary | undefined, expected: string): Promise<void> {
    const platform = {...createPosixPlatform('linux', null), protectedExecution: boundary};
    const procs = new ProcRegistry(harness.core.journal, new Bus(), platform);
    try {
      let error = '';
      try { await procs.protection.install('unavailable', input(), () => {}); } catch (e) { error = (e as Error).message; }
      expect(error).toContain(expected);
      expect(() => procs.spawn('unavailable', '/bin/sh', ['-c', 'echo escaped'], {cwd: root})).toThrow('revoked');
    } finally { await procs.killAll(); await procs.close(); }
  }
  test('unsupported hosts and missing helpers stay refused, including retries', async () => {
    await refusedBoundary(undefined, 'no native protected execution boundary');
    await refusedBoundary(new LinuxExecutionBoundary(() => null), 'bubblewrap >= 0.13.1');
  });
  test('a helper with no working namespace fails before any untrusted code, without fallback', async () => {
    const helper = join(harness.dataDir, 'unavailable-bwrap');
    writeFileSync(helper, '#!/bin/sh\nif [ "$1" = --version ]; then echo "bubblewrap 0.13.1"; exit 0; fi\necho "synthetic unavailable kernel" >&2\nexit 1\n', {mode: 0o700});
    await refusedBoundary(new LinuxExecutionBoundary(() => helper), 'native protected launch failed');
  });
  test('credentials that overlap system runtime binds are refused before launch', async () => {
    const procs = harness.core.procs;
    let message = '';
    try { await procs.protection.install('runtime-credential', input({credentialPaths: ['/usr/share/synthetic-auth']}), () => {}); }
    catch (e) { message = (e as Error).message; }
    expect(message).toContain('credential files cannot overlap');
    expect(() => procs.spawn('runtime-credential', '/bin/true', [], {cwd: root})).toThrow('revoked');
  });
  test('bad descriptors and executable credential aliases cannot turn an intended protected spawn into an ordinary one', async () => {
    const procs = harness.core.procs;
    let error = '';
    try { await procs.protection.install('bad-grant', input({scope: {kind: 'job', id: 'bad', associationId: 'association', grantRevision: -1}}), () => {}); }
    catch (e) { error = String(e); }
    expect(error).toContain('execution.scope');
    expect(() => procs.spawn('bad-grant', '/bin/true', [], {cwd: root})).toThrow('descriptor was refused');
    const alias = join(harness.dataDir, 'executable-auth-alias');
    writeFileSync(credential, 'SYNTHETIC_PROTECTED', {mode: 0o700});
    const {chmodSync} = await import('node:fs');
    chmodSync(credential, 0o700);
    linkSync(credential, alias);
    try { await procs.protection.install('bad-toolchain', input({executables: [alias]}), () => {}); }
    catch (e) { error = String(e); }
    expect(error).toContain('execution.executables');
    expect(() => procs.spawn('bad-toolchain', '/bin/true', [], {cwd: root})).toThrow('descriptor was refused');
  });
  test('revocation during a hanging prerequisite kills the traced helper and cleans preparation', async () => {
    const helper = join(harness.dataDir, 'hanging-bwrap');
    writeFileSync(helper, '#!/bin/sh\nif [ "$1" = --version ]; then echo "bubblewrap 0.13.1"; exit 0; fi\nexec sleep 60\n', {mode: 0o700});
    const bus = new Bus();
    const procs = new ProcRegistry(harness.core.journal, bus, {...createPosixPlatform('linux', null), protectedExecution: new LinuxExecutionBoundary(() => helper)});
    let pid: number | undefined;
    bus.onAny((name, payload) => {
      if (name !== 'process.started') return;
      const p = payload as {pid: number; commandLine: string | null};
      if (p.commandLine?.includes('boite-tool-bootstrap')) pid = p.pid;
    });
    try {
      const install = procs.protection.install('preparing', input(), () => {}).then(() => 'unexpected admission', e => String(e));
      const policy = procs.protection.policy('preparing')!;
      await waitFor(() => pid !== undefined);
      expect(() => procs.spawn('preparing', '/bin/true', [], {cwd: root})).toThrow('not ready');
      await procs.protection.revoke('preparing');
      expect(await install).toContain('native protected launch failed');
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(readdirSync(tmpdir()).filter(p => p.startsWith(`boite-protected-${policy.capabilityId}-`))).toEqual([]);
    } finally { await procs.killAll(); await procs.close(); }
  });
});
