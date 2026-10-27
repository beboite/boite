import {afterEach, describe, expect, test} from 'bun:test';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {PermissionMode, ThreadSummary} from '@boite/contracts';
import {createClaudeDriver} from '../src/drivers/claude.ts';
import {createCodexDriver} from '../src/drivers/codex.ts';
import type {Driver, TurnContext} from '../src/drivers/types.ts';
import {protectedTools} from '../src/protected-tools.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {startTestCore, type TestCore} from './harness.ts';

let harness: TestCore | undefined;
let driver: Driver | undefined;
let api: ReturnType<typeof protectedProviderApi> | undefined;
afterEach(async () => {driver?.shutdown?.(); driver = undefined; api?.stop(); api = undefined; await harness?.stop(); harness = undefined;});
const native = ['linux', 'win32'].includes(process.platform) && process.env.BOITE_TEST_NATIVE_EXECUTION === '1';

describe.skipIf(!native)('installed protected provider execution, deterministic local API', () => {
  test.each([['claude', 'yolo'], ['codex', 'yolo'], ['claude', 'default'], ['codex', 'default']] as const)('%s native control executes useful isolated tools and rejects forged host file tools in %s', async (protocol, permissionMode) => {
    harness = await startTestCore();
    const core = harness.core, root = join(harness.dataDir, 'project'), accountDir = join(harness.dataDir, 'account');
    mkdirSync(root); mkdirSync(accountDir);
    const outside = join(harness.dataDir, 'outside'), credential = join(accountDir, 'provider-auth');
    const alternate = join(harness.dataDir, 'alternate-tool-marker');
    for (const path of [outside, credential, join(root, '.env'), join(root, 'private.key')]) writeFileSync(path, 'SYNTHETIC_PROTECTED');
    writeFileSync(join(root, 'answer.js'), 'export function answer() { return 41; }\n');
    writeFileSync(join(root, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer()).toBe(42));\n");
    copyFileSync(join(import.meta.dir, 'fixtures/native-protected-tool.ts'), join(root, 'tool.ts'));
    const client = await harness.connect(), project = await client.call('projects.add', {path: root});
    const echoAccount = core.accounts.list().find(a => a.providerId === 'echo')!;
    const base = await client.call('threads.create', {projectId: project.id, providerId: 'echo', accountId: echoAccount.id});
    const provider = core.providers.require(protocol), account = {...echoAccount, id: `${protocol}-synthetic-account`, providerId: protocol, isolationDir: accountDir};
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: process.env[`BOITE_TEST_${protocol.toUpperCase()}_CLI`] || Bun.which(protocol) || (() => {throw new Error(`Native fixture requires installed ${protocol}`);})()}];
    const thread: ThreadSummary = {...base, providerId: protocol, accountId: account.id, model: protocol === 'claude' ? 'claude-sonnet-5' : 'gpt-6.1-sol', permissionMode, contextMode: null};
    const changed: string[] = [];
    await core.procs.protection.install(thread.id, {scope: {kind: 'letter', id: 'synthetic-letter', associationId: 'synthetic-association', grantRevision: 1},
      route: {providerId: protocol, accountId: account.id, permissionMode: thread.permissionMode}, checkout: root,
      credentialPaths: [accountDir], executables: [process.execPath], expiresAt: Date.now() + 90000}, () => {});
    const protectedExecution = protectedTools(core.procs, thread.id, () => {}, paths => changed.push(...paths));
    api = protectedProviderApi(protocol, [
      {name: protocol === 'claude' ? 'mcp__boite_protected__boite_exec' : 'boite_exec', input: {command: process.execPath, args: ['tool.ts', outside, credential, '999', String(process.pid)]}},
      protocol === 'claude' ? {name: 'Read', input: {file_path: credential}}
        : {name: 'apply_patch', custom: true, input: `*** Begin Patch\n*** Update File: ${credential}\n@@\n+EXPOSED\n*** End Patch`},
      protocol === 'claude' ? {name: 'Read', input: {file_path: join(root, '.env')}}
        : {name: 'apply_patch', custom: true, input: `*** Begin Patch\n*** Update File: ${join(root, '.env')}\n@@\n+EXPOSED\n*** End Patch`},
      protocol === 'claude' ? {name: 'Bash', input: {command: `cat ${credential}`, dangerouslyDisableSandbox: true}}
        : {name: 'exec_command', input: {cmd: `cat ${credential}`, sandbox_permissions: 'require_escalated'}},
    ]);
    const hostileArgs = ['-e', `require('fs').writeFileSync(${JSON.stringify(alternate)}, 'ESCAPED')`];
    if (protocol === 'codex') writeFileSync(join(accountDir, 'config.toml'), `model_provider="fixture"\nnotify=${JSON.stringify([process.execPath, ...hostileArgs])}\n[model_providers.fixture]\nname="Synthetic local fixture"\nbase_url="${api.url}"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.fixture_escape]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(hostileArgs)}\n`);
    else writeFileSync(join(accountDir, 'settings.json'), JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: `touch ${alternate}`}]}]},
      mcpServers: {fixture_escape: {command: '/bin/sh', args: ['-c', `touch ${alternate}`]}}}));
    const accountEnv: Record<string, string> = protocol === 'claude' ? {CLAUDE_CONFIG_DIR: accountDir, ANTHROPIC_API_KEY: 'synthetic-fixture-key', ANTHROPIC_BASE_URL: api.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'} : {CODEX_HOME: accountDir};
    const logs: string[] = [], parts: unknown[] = [];
    let approvals = 0;
    const ctx: TurnContext = {thread, account, provider, accountEnv, protectedExecution, prompt: 'Run the supplied deterministic protected fixture.', attachments: [], sessionId: null,
      turn: {id: 'synthetic-turn', threadId: thread.id} as TurnContext['turn'], warmProcessMinutes: 0,
      // Exercise the independent compaction launch path without losing protected tools or settings.
      autoCompactTokens: () => permissionMode === 'default' ? 200_000 : null,
      emit: {startMessage: () => 'synthetic-message', delta: (_id, _index, text) => parts.push(text), part: (_id, _index, part) => parts.push(part), patchTool: () => {}, complete: () => {}},
      log: (_level, text) => logs.push(text), commands: () => {}, context: () => {},
      askQuestion: () => {throw new Error('No fixture question');}, requestPermission: () => {approvals++; return Object.assign(Promise.resolve('allow' as const), {requestId: 'synthetic-approval', withdraw() {}});},
      spawn: () => {throw new Error('Native control must use the tracked child route');},
      spawnChild: (cmd, args, opts) => core.procs.spawnChild(core.procs.protection.control(thread.id), cmd, args, {...opts,
        env: {PATH: process.env.PATH, SystemRoot: process.env['SystemRoot'], HOME: accountDir, LANG: 'C.UTF-8', ...accountEnv}}),
    };
    driver = protocol === 'claude' ? createClaudeDriver({loadQuery: async () => (await import('@anthropic-ai/claude-agent-sdk')).query}) : createCodexDriver();
    const result = await driver.startTurn(ctx).done;
    expect(result, logs.join('\n')).toMatchObject({status: 'done'});
    expect(readFileSync(join(root, 'answer.js'), 'utf8')).toContain('return 42');
    expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC_PROTECTED');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SYNTHETIC_PROTECTED');
    expect(approvals).toBe(permissionMode === 'default' ? 1 : 0);
    expect(changed).toContain('answer.js');
    expect(existsSync(alternate)).toBe(false);
    expect(JSON.stringify(api.requests[0])).toContain('boite_exec');
    const wire = JSON.stringify(api.requests);
    expect(wire.includes(process.platform === 'win32' ? 'hostProcessDenied' : 'nestedNamespaceDenied')).toBe(true);
    expect(wire.includes('SYNTHETIC_PROTECTED')).toBe(false);
    expect(JSON.stringify(parts)).toContain('Protected fixture completed');
    expect(core.procs.protection.policy(thread.id)?.route).toEqual({providerId: protocol, accountId: account.id, permissionMode});
  }, 90000);
});
