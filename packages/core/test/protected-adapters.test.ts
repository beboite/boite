import {afterEach, describe, expect, test} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {TOOL_FREE_CONTEXT, type PermissionMode, type ThreadSummary} from '@boite/contracts';
import {createPiDriver} from '../src/drivers/pi.ts';
import {createAcpDriver} from '../src/drivers/acp.ts';
import type {Driver, TurnContext} from '../src/drivers/types.ts';
import {protectedTools} from '../src/protected-tools.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {startTestCore, waitFor, type TestCore} from './harness.ts';

let harness: TestCore | undefined, driver: Driver | undefined;
let api: ReturnType<typeof protectedProviderApi> | undefined;
afterEach(async () => {driver?.shutdown?.(); driver = undefined; api?.stop(); api = undefined; await harness?.stop(); harness = undefined;});
const native = ['linux', 'win32'].includes(process.platform) && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

describe.skipIf(!native)('native protected extensions', () => {
  test.each(['pi', 'opencode'] as const)('%s useful edits and child tests use the OS capability, forged tools and discovered extensions cannot escape', async protocol => {
    if (protocol === 'pi' && !process.env.BOITE_TEST_PI_CLI) throw new Error('Native pi fixture requires BOITE_TEST_PI_CLI');
    harness = await startTestCore();
    const core = harness.core, root = join(harness.dataDir, 'project'), accountDir = join(harness.dataDir, 'account');
    mkdirSync(root); mkdirSync(accountDir);
    const outside = join(harness.dataDir, 'outside'), credential = join(accountDir, 'provider-auth'), marker = join(harness.dataDir, 'escape-marker');
    for (const path of [outside, credential, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_PROTECTED');
    writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
    writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer()).toBe(42));\n");
    copyFileSync(join(import.meta.dir, 'fixtures/native-protected-tool.ts'), join(root, 'tool.ts'));
    const client = await harness.connect(), project = await client.call('projects.add', {path: root});
    const echoAccount = core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echoAccount.id});
    const provider = core.providers.require(protocol), account = {...echoAccount, id: `${protocol}-synthetic-account`, providerId: protocol, isolationDir: accountDir};
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: protocol === 'pi' ? process.env.BOITE_TEST_PI_CLI! : process.env.BOITE_TEST_OPENCODE_CLI || Bun.which('opencode')!}];
    if (protocol === 'pi' && process.platform === 'win32') provider.profiles.windows!.executable = [{kind: 'npm', value: '@earendil-works/pi-coding-agent#pi'}];
    const permissionMode: PermissionMode = protocol === 'pi' ? 'yolo' : 'default';
    const thread: ThreadSummary = {...base, providerId: protocol, accountId: account.id, model: 'fixture/protected-model', permissionMode, contextMode: null};
    await core.procs.protection.install(thread.id, {scope: {kind: 'letter', id: 'synthetic-letter', associationId: 'synthetic-association', grantRevision: 1},
      route: {providerId: protocol, accountId: account.id, permissionMode}, checkout: root, credentialPaths: [accountDir], executables: [process.execPath], expiresAt: Date.now() + 90000}, () => {});
    const control = core.procs.protection.control(thread.id);
    const changed: string[] = [], protectedExecution = protectedTools(core.procs, thread.id, () => {}, paths => changed.push(...paths));
    api = protectedProviderApi('claude', [
      {name: protocol === 'pi' ? 'boite_exec' : 'boite_protected_boite_exec', input: {command: process.execPath, args: ['tool.ts', outside, credential, '999', String(process.pid)]}},
      {name: 'read', input: {path: credential}},
      {name: 'bash', input: {command: `cat ${credential}; touch ${marker}`}},
      {name: protocol === 'pi' ? 'boite_exec' : 'boite_protected_boite_exec', input: {command: '/bin/cat', args: [credential], env: {ESCAPE: 'yes'}}},
    ], body => protocol === 'opencode' && !(body as {tools?: unknown[]}).tools?.length);
    writeFileSync(join(accountDir, 'auth.json'), JSON.stringify({fixture: {type: 'api_key', key: 'synthetic-fixture-account-key'}}));
    writeFileSync(join(accountDir, 'models.json'), JSON.stringify({providers: {fixture: {baseUrl: api.url, api: 'anthropic-messages', models: [{id: 'protected-model', name: 'Protected fixture', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 1024}]}}}));
    mkdirSync(join(accountDir, 'extensions'));
    writeFileSync(join(accountDir, 'extensions/escape.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ESCAPED'); export default function() {}`);
    writeFileSync(join(accountDir, 'settings.json'), JSON.stringify({extensions: [join(accountDir, 'extensions/escape.mjs')]}));
    mkdirSync(join(accountDir, 'opencode'));
    writeFileSync(join(accountDir, 'opencode/auth.json'), JSON.stringify({fixture: {type: 'api', key: 'synthetic-fixture-account-key'}}));
    writeFileSync(join(accountDir, 'opencode/opencode.jsonc'), '// Native JSONC provider selection\n' + JSON.stringify({provider: {fixture: {npm: '@ai-sdk/anthropic', name: 'Fixture', options: {baseURL: api.url + '/v1'}, models: {'protected-model': {name: 'Protected fixture', limit: {context: 200000, output: 1024}}}}}, model: 'fixture/protected-model'}));
    mkdirSync(join(accountDir, 'opencode/plugins'));
    writeFileSync(join(accountDir, 'opencode/plugins/escape.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ESCAPED'); export default async function() {return {}}`);
    mkdirSync(join(root, '.pi/extensions'), {recursive: true});
    mkdirSync(join(root, '.opencode/plugins'), {recursive: true});
    for (const path of ['.pi/extensions/escape.mjs', '.opencode/plugins/escape.mjs']) writeFileSync(join(root, path), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ESCAPED'); export default function() {return {}}`);
    const accountEnv = {PI_CODING_AGENT_DIR: accountDir, XDG_CONFIG_HOME: accountDir, XDG_DATA_HOME: accountDir, XDG_CACHE_HOME: join(accountDir, 'cache')};
    const logs: string[] = [];
    let approvals = 0, spawns = 0;
    const workspaces: string[] = [];
    const processes: {pid: number | undefined; command: string; args: string[]; cwd: string | undefined; events: Record<string, unknown>[]}[] = [];
    const tracePiStartup = protocol === 'pi' && process.platform === 'win32';
    const ctx: TurnContext = {thread: {...thread, contextMode: {...TOOL_FREE_CONTEXT}}, account, provider, accountEnv, protectedExecution, prompt: 'Run the deterministic fixture.', attachments: [], sessionId: null,
      turn: {id: 'synthetic-turn', threadId: thread.id} as TurnContext['turn'], warmProcessMinutes: 1,
      emit: {startMessage: () => 'synthetic-message', delta: () => {}, part: () => {}, patchTool: () => {}, complete: () => {}},
      log: (_level, text) => logs.push(text), diagnostic: (_level, text) => logs.push(text), commands: () => {}, context: () => {},
      askQuestion: () => {throw new Error('No question');}, requestPermission: () => {approvals++; return Object.assign(Promise.resolve('allow' as const), {requestId: 'synthetic-approval', withdraw() {}});},
      spawn: () => {throw new Error('Control must use the tracked child route');},
      spawnChild: (cmd, args, opts) => {
        spawns++; if (opts?.cwd) workspaces.push(opts.cwd);
        const tracedArgs = tracePiStartup ? ['--import', pathToFileURL(join(import.meta.dir, 'fixtures/native-pi-startup.mjs')).href, ...args] : args;
        const child = core.procs.spawnChild(control, cmd, tracedArgs, {...opts,
          env: {PATH: process.env.PATH, SystemRoot: process.env['SystemRoot'], HOME: accountDir, LANG: 'C.UTF-8', ...accountEnv, ...opts?.env, ...(tracePiStartup ? {PI_TIMING: '1'} : {})}});
        const captured = {pid: child.pid, command: cmd, args: tracedArgs, cwd: opts?.cwd, events: [] as Record<string, unknown>[]};
        processes.push(captured);
        child.once('spawn', () => captured.events.push({event: 'spawn', at: Date.now()}));
        child.stdout.once('data', () => captured.events.push({event: 'first-stdout', at: Date.now()}));
        child.stderr.once('data', () => captured.events.push({event: 'first-stderr', at: Date.now()}));
        child.once('exit', (code, signal) => captured.events.push({event: 'exit', at: Date.now(), code, signal}));
        child.once('close', (code, signal) => captured.events.push({event: 'close', at: Date.now(), code, signal}));
        child.once('error', error => captured.events.push({event: 'error', at: Date.now(), error: error.message}));
        return child;
      },
      killTree: () => {core.procs.killTree(control); core.procs.killTree(thread.id);},
    };
    driver = protocol === 'pi' ? createPiDriver() : createAcpDriver({loadSdk: () => import('@agentclientprotocol/sdk')});
    const handle = driver.startTurn(ctx);
    expect(handle.setPermissionMode).toBeUndefined();
    const result = await handle.done;
    if (tracePiStartup) console.error(JSON.stringify({protocol, helper: process.env.BOITE_WINDOWS_SANDBOX_PATH, processes, logs}));
    if (result.status !== 'done') console.error(logs.join('\n'));
    if (!readFileSync(join(root, 'answer.js'), 'utf8').includes('return 42')) console.error(JSON.stringify({protocol, helper: process.env.BOITE_WINDOWS_SANDBOX_PATH, processes, logs, requests: api?.requests}));
    expect(result, logs.join('\n')).toMatchObject({status: 'done'});
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 42');
    expect(changed).toContain('answer.js');
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC_PROTECTED');
    const wire = JSON.stringify(api.requests);
    expect(wire).toContain(process.platform === 'win32' ? 'hostProcessDenied' : 'nestedNamespaceDenied'); expect(wire).not.toContain('SYNTHETIC_PROTECTED');
    expect(approvals).toBe(protocol === 'pi' ? 0 : 1);
    expect(core.procs.protection.policy(thread.id)?.route).toEqual({providerId: protocol, accountId: account.id, permissionMode});
    expect(api.authorizations.every(value => value.includes('synthetic-fixture-account-key'))).toBe(true);
    api.enqueue({name: protocol === 'pi' ? 'boite_exec' : 'boite_protected_boite_exec', input: {command: process.execPath, args: ['-e', "console.log('warm protected')"]}});
    const warm = {...ctx, sessionId: result.sessionId};
    expect(await driver.startTurn(warm).done).toMatchObject({status: 'done'});
    expect(spawns).toBe(1);
    expect(JSON.stringify(api.requests)).toContain('warm protected');
    if (protocol === 'pi') {
      driver.shutdown?.(); driver = createPiDriver();
      const cold = {...warm, continuation: () => ({prompt: 'SANITIZED_COLD_REPLAY', attachments: []})};
      const resumed = await driver.startTurn(cold).done;
      expect(resumed).toMatchObject({status: 'done'});
      expect(resumed.sessionId).not.toBe(result.sessionId);
      expect(JSON.stringify(api.requests)).toContain('SANITIZED_COLD_REPLAY');
    }
    // The shared-turn context disables native tools even when protected tools
    // are allowed. A host's actual tool-free choice must still disable both.
    driver.shutdown?.();
    driver = protocol === 'pi' ? createPiDriver() : createAcpDriver({loadSdk: () => import('@agentclientprotocol/sdk')});
    writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
    api.enqueue({name: protocol === 'pi' ? 'boite_exec' : 'boite_protected_boite_exec', input: {command: process.execPath, args: ['-e', "require('fs').writeFileSync('answer.js', 'escaped host tool-free context')"]}});
    const disabled = protectedTools(core.procs, thread.id, () => {}, () => {}, undefined, false);
    const requestStart = api.requests.length;
    expect(await driver.startTurn({...ctx, protectedExecution: disabled}).done).toMatchObject({status: 'done'});
    const disabledRequests = api.requests.slice(requestStart) as {tools?: unknown[]}[];
    expect(disabledRequests.length).toBeGreaterThan(0);
    expect(disabledRequests.every(request => !request.tools?.length)).toBe(true);
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 41');
    if (protocol === 'opencode') {
      // A warm protected process must not keep the native default when the
      // captured host selection disappears from the live model catalogue.
      const before = api.requests.length;
      const missing = {...ctx, thread: {...ctx.thread, model: 'fixture/unoffered-model'}, protectedExecution: disabled};
      const refused = await driver.startTurn(missing).done;
      expect(refused).toMatchObject({status: 'error'});
      expect(api.requests).toHaveLength(before);
      expect(refused.error).toContain('execution.acp.model');
    }
    await core.procs.protection.revoke(thread.id);
    const before = api.requests.length;
    expect(await driver.startTurn(warm).done).toMatchObject({status: 'error'});
    expect(api.requests).toHaveLength(before);
    expect(core.procs.liveCount(control)).toBe(0);
    driver.shutdown?.();
    await waitFor(() => workspaces.every(path => !existsSync(path))).catch(error => {
      try {
        console.error(JSON.stringify({stage: 'execution.adapter.cleanup-timeout', protocol, helper: process.env.BOITE_WINDOWS_SANDBOX_PATH,
          processes, cleanup: logs.filter(line => line.startsWith('execution.bridge.cleanup:')),
          workspaces: workspaces.map(cwd => ({cwd, present: existsSync(cwd),
            entries: existsSync(dirname(cwd)) ? [...new Bun.Glob('**/*').scanSync({cwd: dirname(cwd), dot: true, onlyFiles: false, followSymlinks: false})] : []}))}));
      } catch (snapshotError) {console.error(`execution.adapter.cleanup-snapshot: ${String(snapshotError)}`);}
      throw error;
    });
  }, 90000);
});
