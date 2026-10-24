import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {startTestCore, type TestCore} from './harness.ts';

let harness: TestCore | undefined;
afterEach(async () => {await harness?.stop(); harness = undefined;});
const native = process.platform === 'win32' && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

describe.skipIf(!native)('native Windows protected execution', () => {
  test('an ordinary native process edits, builds and tests without host file authority', async () => {
    harness = await startTestCore();
    const root = join(harness.dataDir, 'project'), outside = join(harness.dataDir, 'outside');
    mkdirSync(root);
    for (const path of [outside, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_WINDOWS_PROTECTED');
    writeFileSync(join(root, 'answer.js'), 'export const answer = 41;\n');
    writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer).toBe(42));\n");
    const procs = harness.core.procs;
    await procs.protection.install('windows-native', {scope: {kind: 'job', id: 'native-job', associationId: 'association', grantRevision: 1},
      route: {providerId: 'native-fixture', accountId: 'host-account', permissionMode: 'yolo'}, checkout: root, credentialPaths: [outside], executables: [process.execPath], expiresAt: Date.now() + 120000}, () => {});
    const program = `
const fs = require('node:fs');
const exposed = [${JSON.stringify(outside)}, '.env', 'private.key'].filter(p => {try {fs.readFileSync(p); return true;} catch {return false;}});
fs.writeFileSync('answer.js', 'export const answer = 42;\\n');
const build = Bun.spawnSync([process.execPath, 'build', 'answer.js', '--outdir', 'dist']);
const test = Bun.spawnSync([process.execPath, 'test', 'answer.test.js']);
console.log(JSON.stringify({exposed, build: build.exitCode, test: test.exitCode}));`;
    const child = procs.spawn('windows-native', process.execPath, ['-e', program], {cwd: root, env: {SYNTHETIC_KEY: 'SYNTHETIC_WINDOWS_PROTECTED'}});
    const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({exposed: [], build: 0, test: 0});
    procs.protection.flush('windows-native');
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('42');
    expect(existsSync(join(root, 'dist/answer.js'))).toBe(true);
  }, 120000);
});
