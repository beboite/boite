import {afterEach, describe, expect, test} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as nativeProviders from './fixtures/prepare-native-providers.ts';
import {TOOL_FREE_CONTEXT, type ProviderInstall, type ThreadSummary} from '@boite/contracts';
import {createMuseDriver} from '../src/drivers/muse.ts';
import type {Driver, TurnContext} from '../src/drivers/types.ts';
import {protectedTools} from '../src/protected-tools.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {startTestCore, waitFor, type TestCore} from './harness.ts';
import {thrown} from './settle.ts';

let h: TestCore | undefined, driver: Driver | undefined, api: ReturnType<typeof protectedProviderApi> | undefined;
afterEach(async () => {driver?.shutdown?.(); driver = undefined; api?.stop(); api = undefined; await h?.stop(); h = undefined;});
const native = ['linux', 'win32'].includes(process.platform) && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

test('Windows Muse fixture verifies task-local native bytes and refuses tampering without retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-muse-install-test-'));
  const bytes = new TextEncoder().encode('synthetic native executable');
  let tampered = false, unavailable = false, requests = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    if (unavailable) return new Response('busy', {status: 503});
    return new Response(tampered ? new Uint8Array(bytes.length).fill(1) : bytes);
  }});
  const install: ProviderInstall = {format: 'binary', version: '1.4.13-R6996.1',
    url: `http://127.0.0.1:${server.port}/muse.exe`, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    archiveBytes: bytes.length, files: [{path: 'muse.exe', bytes: bytes.length}]};
  try {
    const binary = await nativeProviders.prepareWindowsMuse(join(root, 'valid'), install);
    expect(binary).toBe(join(root, 'valid', 'muse', 'muse-bin-1.4.13-R6996.1.exe'));
    expect(readFileSync(binary)).toEqual(Buffer.from(bytes));
    expect(readFileSync(join(root, 'valid', 'muse', '.muse-version'), 'utf8').trim()).toBe(install.version);
    tampered = true;
    expect(await thrown(nativeProviders.prepareWindowsMuse(join(root, 'tampered'), install))).toThrow(/hashes to/);
    expect(existsSync(join(root, 'tampered', 'muse', '.muse-version'))).toBe(false);
    expect(existsSync(join(root, 'tampered', 'muse', 'muse-bin-1.4.13-R6996.1.exe'))).toBe(false);
    unavailable = true;
    expect(await thrown(nativeProviders.prepareWindowsMuse(join(root, 'unavailable'), install))).toThrow(/0 retries/);
    expect(existsSync(join(root, 'unavailable', 'muse', '.muse-version'))).toBe(false);
    expect(requests).toBe(3);
  } finally {server.stop(true); rmSync(root, {recursive: true, force: true});}
});

describe.skipIf(!native)('Muse protected production MSP', () => {
  test.each(['missing-required-server', 'unresolved-tool'] as const)('%s is refused by native admission before the first provider request', async fault => {
    if (!process.env.BOITE_TEST_MUSE_CLI) throw new Error('Requires task-owned Muse 1.4.13');
    h = await startTestCore();
    const root = join(h.dataDir, 'project'), account = join(h.dataDir, 'account');
    mkdirSync(root); mkdirSync(join(account, 'muse'), {recursive: true});
    api = protectedProviderApi('muse', []);
    writeFileSync(join(account, 'muse/auth.json'), JSON.stringify({schema_version: 1, providers: {meta: {api_key: 'synthetic-fixture-account-key'}}}));
    writeFileSync(join(account, 'muse/settings.json'), JSON.stringify({schema_version: 1, model: 'protected-model', endpoint_transport: {base_url: api.url, auth: 'bearer'}}));
    const id = 'muse-admission', core = h.core, provider = core.providers.require('muse');
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.env.BOITE_TEST_MUSE_CLI}];
    await core.procs.protection.install(id, {scope: {kind: 'letter', id: 'fixture', associationId: 'fixture', grantRevision: 1}, route: {providerId: 'muse', accountId: 'synthetic', permissionMode: 'yolo'}, checkout: root, credentialPaths: [account], executables: [process.execPath], expiresAt: Date.now() + 30000}, () => {});
    const control = core.procs.protection.control(id), logs: string[] = [];
    const client = await h.connect(), project = await client.call('projects.add', {path: root});
    const echo = core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echo.id});
    const ctx = {provider, account: {...echo, id: 'synthetic'}, accountEnv: {XDG_CONFIG_HOME: account}, thread: {...base, id, cwd: root, model: 'protected-model', permissionMode: 'yolo'},
      protectedExecution: protectedTools(core.procs, id, () => {}, () => {}), sessionId: null, warmProcessMinutes: 0, prompt: 'Must never reach the provider', attachments: [], turn: {id: 'fixture'} as TurnContext['turn'],
      log: (_level: string, text: string) => logs.push(text), context() {}, commands() {},
      requestPermission() {throw new Error('Admission must precede permission requests');}, askQuestion() {throw new Error('No question');}, spawn() {throw new Error('Use tracked child');},
      emit: {startMessage: () => 'fixture', delta() {}, part() {}, patchTool() {}, complete() {}},
      spawnChild(cmd, args, opts) {
        // Trusted fixture corruption proves the native registry is mandatory,
        // including its lazy run preparation, rather than just hidden schemas.
        const path = join(opts!.env!['XDG_CONFIG_HOME']!, 'muse/settings.json');
        const settings = JSON.parse(readFileSync(path, 'utf8'));
        if (fault === 'missing-required-server') settings.mcp_servers.boite_protected.url = 'http://127.0.0.1:1/mcp';
        else settings.run.toolset = ['mcp__missing__exec'];
        writeFileSync(path, JSON.stringify(settings));
        return core.procs.spawnChild(control, cmd, args, opts);
      }, killTree: () => core.procs.killTree(control),
    } as TurnContext;
    driver = createMuseDriver();
    const result = await driver.startTurn(ctx).done;
    expect(result.status, logs.join('\n')).toBe('error');
    expect(result.error).toMatch(/MCP|mcp|tool.*(missing|unknown)|unknown.*tool/i);
    expect(api.requests).toHaveLength(0);
    await waitFor(() => core.procs.liveCount(control) === 0);
  }, 30000);

  test('native mandatory MCP admission edits/builds/tests while forged native tools cannot disclose credentials', async () => {
    if (!process.env.BOITE_TEST_MUSE_CLI) throw new Error('Requires task-owned Muse 1.4.13 BOITE_TEST_MUSE_CLI');
    h = await startTestCore();
    const core = h.core, root = join(h.dataDir, 'project'), accountDir = join(h.dataDir, 'account');
    mkdirSync(root); mkdirSync(join(accountDir, 'muse'), {recursive: true});
    const outside = join(h.dataDir, 'outside'), credential = join(accountDir, 'provider-auth'), marker = join(h.dataDir, 'escape-marker');
    for (const path of [outside, credential, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_PROTECTED');
    writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
    writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer()).toBe(42));\n");
    copyFileSync(join(import.meta.dir, 'fixtures/native-protected-tool.ts'), join(root, 'tool.ts'));
    const markCommand = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],'ESCAPED')" "${marker}"`;
    const readCommand = `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${credential}"`;
    // Configured native discovery must not execute project/account code.
    mkdirSync(join(root, '.muse'));
    writeFileSync(join(root, '.muse/hooks.json'), JSON.stringify({hooks: {PreToolUse: [{command: markCommand}]}}));
    const foreign = join(accountDir, 'foreign');
    mkdirSync(join(foreign, 'skills/host-only'), {recursive: true});
    writeFileSync(join(foreign, 'skills/host-only/SKILL.md'), '---\nname: host-only\ndescription: SYNTHETIC_FOREIGN_SKILL_SECRET\n---\nHost-only private instructions.\n');
    const client = await h.connect(), project = await client.call('projects.add', {path: root});
    const echo = core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echo.id});
    const provider = core.providers.require('muse'), account = {...echo, id: 'muse-synthetic', providerId: 'muse', isolationDir: accountDir};
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.env.BOITE_TEST_MUSE_CLI}];
    const thread: ThreadSummary = {...base, providerId: 'muse', accountId: account.id, model: 'protected-model', effort: 'high', permissionMode: 'default', contextMode: {...TOOL_FREE_CONTEXT}};
    await core.procs.protection.install(thread.id, {scope: {kind: 'letter', id: 'fixture', associationId: 'fixture', grantRevision: 1},
      route: {providerId: 'muse', accountId: account.id, permissionMode: 'default'}, checkout: root, credentialPaths: [accountDir], executables: [process.execPath], expiresAt: Date.now() + 90000}, () => {});
    const control = core.procs.protection.control(thread.id), changed: string[] = [];
    const execution = protectedTools(core.procs, thread.id, () => {}, paths => changed.push(...paths));
    api = protectedProviderApi('muse', [
      {name: 'mcp__boite_protected.boite_exec', input: {command: process.execPath, args: ['tool.ts', outside, credential, '999', String(process.pid)]}},
      ...['muse.read_file', 'muse.shell', 'muse.workflow', 'read_file', 'muse.apply_patch', 'mcp__other.read'].map(name => ({name, input: {path: credential, command: `${readCommand} && ${markCommand}`, script: `throw new Error('unprotected')`}})),
      {name: 'mcp__boite_protected.boite_exec', input: {command: process.execPath, args: ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", credential], env: {ESCAPE: 'yes'}}},
    ]);
    writeFileSync(join(accountDir, 'muse/auth.json'), JSON.stringify({schema_version: 1, providers: {meta: {api_key: 'synthetic-fixture-account-key'}}}));
    writeFileSync(join(accountDir, 'muse/settings.json'), JSON.stringify({schema_version: 1, model: 'protected-model', endpoint_transport: {base_url: api.url, auth: 'bearer'},
      hooks: {PreToolUse: [{command: markCommand}]}, run: {toolset: ['read_file']}}));
    const logs: string[] = []; let approvals = 0, spawns = 0;
    const ctx: TurnContext = {thread, account, provider, accountEnv: {XDG_CONFIG_HOME: accountDir, XDG_DATA_HOME: accountDir, XDG_STATE_HOME: accountDir, CODEX_HOME: foreign}, protectedExecution: execution,
      prompt: 'Run the deterministic fixture.', attachments: [], sessionId: null, turn: {id: 'synthetic-turn', threadId: thread.id} as TurnContext['turn'], warmProcessMinutes: 1,
      emit: {startMessage: () => 'synthetic-message', delta: () => {}, part: () => {}, patchTool: () => {}, complete: () => {}},
      log: (_level, text) => logs.push(text), diagnostic: (_level, text) => logs.push(text), commands: () => {}, context: () => {},
      askQuestion: () => {throw new Error('No question');}, requestPermission: () => {approvals++; return Object.assign(Promise.resolve('allow' as const), {requestId: 'synthetic-approval', withdraw() {}});},
      spawn: () => {throw new Error('Use the tracked child route');}, spawnChild: (cmd, args, opts) => {spawns++; return core.procs.spawnChild(control, cmd, args, opts);},
      killTree: () => {core.procs.killTree(control); core.procs.killTree(thread.id);},
    };
    driver = createMuseDriver();
    const result = await driver.startTurn(ctx).done;
    expect(result, logs.join('\n')).toMatchObject({status: 'done'});
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 42');
    expect(changed).toContain('answer.js'); expect(existsSync(marker)).toBe(false);
    const wire = JSON.stringify(api.requests);
    expect(wire.includes('SYNTHETIC_FOREIGN_SKILL_SECRET')).toBe(false);
    const outputs = api.requests.flatMap(body => (body as {input?: {type?: string; output?: unknown}[]}).input?.filter(item => item.type === 'function_call_output').map(item => item.output) ?? []);
    const toolResults = JSON.stringify(outputs).replaceAll('\\', '');
    expect(toolResults).toContain('"exposed":[]');
    expect(toolResults.includes('"built":true')).toBe(true); expect(toolResults.includes('"tested":true')).toBe(true);
    if (process.platform === 'win32') {
      expect(toolResults).toContain('"lowbox":true');
      expect(toolResults).toContain('"hostProcessDenied":true');
    } else expect(wire).toContain('nestedNamespaceDenied');
    expect(wire).toContain('tool unavailable');
    expect(wire).not.toContain('SYNTHETIC_PROTECTED'); expect(wire).not.toContain('synthetic-fixture-account-key');
    expect(api.authorizations.every(value => value === 'Bearer synthetic-fixture-account-key')).toBe(true);
    // Native promptUnmatched admission and the host's OS command approval.
    expect(approvals).toBe(2);
    const advertised = JSON.stringify((api.requests[0] as {tools?: unknown}).tools);
    expect(advertised).toContain('boite_exec'); expect(advertised).not.toContain('read_file');
    api.enqueue({name: 'mcp__boite_protected.boite_exec', input: {command: process.execPath, args: ['-e', "console.log('warm protected')"]}});
    const warm = {...ctx, sessionId: result.sessionId};
    expect(await driver.startTurn(warm).done).toMatchObject({status: 'done'}); expect(spawns).toBe(1);
    expect(JSON.stringify(api.requests)).toContain('warm protected');
    driver.shutdown?.(); driver = createMuseDriver();
    const cold = await driver.startTurn({...warm, continuation: () => ({prompt: 'SANITIZED_COLD_REPLAY', attachments: []})}).done;
    expect(cold).toMatchObject({status: 'done'}); expect(cold.sessionId).not.toBe(result.sessionId);
    expect(JSON.stringify(api.requests)).toContain('SANITIZED_COLD_REPLAY');
    driver.shutdown?.(); driver = createMuseDriver();
    const disabled = protectedTools(core.procs, thread.id, () => {}, () => {}, undefined, false), before = api.requests.length;
    api.enqueue({name: 'mcp__boite_protected.boite_exec', input: {command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.argv[1],'ESCAPED')", marker]}});
    expect(await driver.startTurn({...ctx, protectedExecution: disabled}).done).toMatchObject({status: 'done'});
    expect(api.requests.slice(before).every(body => !(body as {tools?: unknown[]}).tools?.length)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await core.procs.protection.revoke(thread.id);
    const revokedAt = api.requests.length;
    expect(await driver.startTurn(warm).done).toMatchObject({status: 'error'});
    expect(api.requests).toHaveLength(revokedAt);
    await waitFor(() => core.procs.liveCount(control) === 0);
  }, 90000);
});
