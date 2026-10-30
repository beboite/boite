import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedProjectRef } from '@boite/contracts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { connect } from '../src/client.ts';
import { thrown } from './settle.ts';
import { waitForComputeJob } from './shared-compute-fixture.ts';
import { sharedExecutionProtection } from '../src/contacts/compute-policy.ts';
import { snapshot } from '../src/threads/checkpoint-files.ts';
import {protectedProviderApi} from './fixtures/protected-provider-api.ts';
import {museExecutable} from '../src/drivers/muse/mapping.ts';
import { COMPACTION_TAIL_PREFIX } from '../src/threads/background-compact.ts';

const cores: TestCore[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const h of cores.splice(0).reverse()) await h.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function git(h: TestCore, cwd: string, ...args: string[]) {
  const p = h.core.procs.spawn('thr_fixture', 'git', args, {cwd, env: {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(h.dataDir, 'no-global-gitconfig')}});
  const [out, err, code] = await Promise.all([new Response(p.proc.stdout).text(), new Response(p.proc.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err}`);
  return out.trim();
}
async function side() {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-access-')); dirs.push(dataDir);
  const h = await startTestCore({ dataDir }); cores.push(h);
  h.core.contacts.selfUrl = async () => h.url;
  const client = await h.connect();
  const path = join(dataDir, 'project'); mkdirSync(path);
  await git(h, path, 'init', '-b', 'main');
  await git(h, path, 'config', '--local', 'user.name', 'Fixture');
  await git(h, path, 'config', '--local', 'user.email', 'fixture@example.invalid');
  await git(h, path, 'remote', 'add', 'origin', 'https://example.invalid/fixtures/shared.git');
  await git(h, path, 'commit', '--allow-empty', '-m', 'base');
  const project = await client.call('projects.add', { path });
  const account = h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id });
  h.core.contacts.setSettings({ minTier: 2 });
  const coreId = h.core.coordination.card().coreId;
  const ref: SharedProjectRef = { ownerCoreId: coreId, coreId, projectId: project.id };
  return { h, client, path, ref, coreId, threadId: thread.id };
}
async function fixture() {
  const a = await side(), b = await side();
  await git(b.h, b.path, 'fetch', a.path, 'main'); await git(b.h, b.path, 'reset', '--hard', 'FETCH_HEAD');
  await b.client.call('contacts.join', { link: (await a.client.call('contacts.invite', {})).link });
  await waitFor(() => a.h.core.contacts.linked(b.coreId));
  await a.client.call('contacts.grant', { coreId: b.coreId, projectId: a.ref.projectId, readThreads: true });
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1);
  const offered = await a.client.call('sharedProjects.offer', { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'offer' });
  const sharedProjectId = offered.shared.id;
  await b.client.call('sharedProjects.decide', { sharedProjectId, accept: true, requestId: 'accept' });
  await b.client.call('sharedProjects.configure', { sharedProjectId, computeThreadId: b.threadId, compute: {enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent: null} });
  const job = await a.client.call('sharedCompute.start', {threadId: a.threadId, sharedProjectId, requestId: 'job', host: b.ref, profileId: 'conversation', baseCommit: await git(a.h, a.path, 'rev-parse', 'HEAD'), task: '[sleep:90000]'});
  expect((await waitForComputeJob(b.h, job.id, ['running'])).status).toBe('running');
  const worker = b.h.core.threads.require(job.worker!.threadId);
  const agent = await connect(b.h.url, b.h.core.agents.tokenFor(worker.id));
  return {a, b, sharedProjectId, job, worker, agent};
}

test('shared fixture commits are consumable without a host Git identity', async () => {
  const a = await side(), b = await side();
  try {
    await git(b.h, b.path, 'fetch', a.path, 'main');
    await git(b.h, b.path, 'reset', '--hard', 'FETCH_HEAD');
    writeFileSync(join(b.path, 'answer.txt'), '42');
    await git(b.h, b.path, 'add', 'answer.txt');
    await git(b.h, b.path, 'commit', '-m', 'Fixture edit');
    await git(a.h, a.path, 'fetch', b.path, 'main');
    await git(a.h, a.path, 'cherry-pick', 'FETCH_HEAD');
    expect(readFileSync(join(a.path, 'answer.txt'), 'utf8')).toBe('42');
    expect(await git(a.h, a.path, 'log', '-1', '--format=%cn <%ce>')).toBe('Fixture <fixture@example.invalid>');
  } finally {a.client.close(); b.client.close();}
});

test('shared compaction tails enforce upload policy before materializing historical files', async () => {
  const {a, b, worker, agent} = await fixture();
  try {
    const journal = b.h.core.journal, source = journal.lastTurn(worker.id)!;
    const history = {...source, id: 'trn_shared_tail_history', status: 'done' as const, finishedAt: Date.now()};
    const current = {...source, id: 'trn_shared_tail_current', execution: undefined};
    journal.putTurn(history);
    journal.putMessage({id: 'msg_shared_tail_file', threadId: worker.id, turnId: history.id, role: 'user', state: 'complete', createdAt: Date.now(),
      parts: [{type: 'file', name: '.env', mimeType: 'text/plain', data: Buffer.from('ordinary historical bytes').toString('base64')}]});
    journal.putTurn(current);
    journal.putMessage({id: 'msg_shared_tail_current', threadId: worker.id, turnId: current.id, role: 'user', state: 'complete', createdAt: Date.now(), parts: [{type: 'text', text: 'continue after compaction'}]});
    const thread = {...b.h.core.threads.require(worker.id), sessionId: 'shared-compacted-session', sessionGeneration: 1};
    journal.setSetting(COMPACTION_TAIL_PREFIX + worker.id, {generation: 1, after: source.id});
    const provider = b.h.core.providers.require(thread.providerId), account = b.h.core.accounts.require(thread.accountId);
    const context = () => b.h.core.threads.contexts.makeContext(thread, provider, account, current);
    expect(() => context()).toThrow('shared file policy: secret uploads require publication from an exact authorized host source');
    journal.setMessagePart('msg_shared_tail_file', 0, {type: 'file', name: 'ordinary-tail.txt', mimeType: 'text/plain', data: Buffer.from('ordinary historical bytes').toString('base64')});
    const allowed = context();
    expect(allowed.prompt).toContain('<recent-history>');
    expect(allowed.prompt).toContain('ordinary-tail.txt');
    expect(allowed.prompt).toContain('continue after compaction');
  } finally {agent.close(); a.client.close(); b.client.close();}
}, 30000);

type NativeProvider = 'claude' | 'codex' | 'muse' | 'opencode' | 'pi';
const nativePlatforms = ['linux', 'win32'];
const nativeProviders: NativeProvider[] = ['claude', 'codex', 'muse', 'opencode', 'pi'];
const nativeMode = (protocol: NativeProvider) => protocol === 'opencode' ? 'default' as const : 'yolo' as const;
const nativeName = (protocol: NativeProvider, commit = false) => `${protocol === 'claude' ? 'mcp__boite_protected__' : protocol === 'muse' ? 'mcp__boite_protected.' : protocol === 'opencode' ? 'boite_protected_' : ''}boite_${commit ? 'commit' : 'exec'}`;
const nativeCommand = (script: string) => ({command: process.execPath, args: ['-e', script]});
const nativeRead = (file: string): [string, string[]] => [process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'))`]];

async function nativeHost(b: Awaited<ReturnType<typeof side>>, protocol: NativeProvider, api: ReturnType<typeof protectedProviderApi>) {
  if (protocol === 'muse' && !process.env.BOITE_TEST_MUSE_CLI) throw new Error('Native Muse fixture requires task-owned BOITE_TEST_MUSE_CLI 1.4.13');
  const account = await b.client.call('accounts.add', {providerId: protocol, label: 'Synthetic native account'});
  b.h.core.journal.putAccount({...account, status: 'ok'});
  const accountDir = account.isolationDir!;
  if (protocol === 'codex') writeFileSync(join(accountDir, 'config.toml'), `model_provider="fixture"\n[model_providers.fixture]\nname="Synthetic fixture"\nbase_url="${api.url}"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  if (protocol === 'muse') {
    mkdirSync(join(accountDir, 'muse'), {recursive: true});
    writeFileSync(join(accountDir, 'muse/auth.json'), JSON.stringify({schema_version: 1, providers: {meta: {api_key: 'synthetic-fixture-key'}}}));
    writeFileSync(join(accountDir, 'muse/settings.json'), JSON.stringify({schema_version: 1, model: 'protected-model', endpoint_transport: {base_url: api.url, auth: 'bearer'}, run: {subagent_delegation_mode: 'off', reminder_roster: {agents: []}}}));
  }
  if (protocol === 'pi') {
    writeFileSync(join(accountDir, 'auth.json'), JSON.stringify({fixture: {type: 'api_key', key: 'synthetic-fixture-key'}}));
    writeFileSync(join(accountDir, 'models.json'), JSON.stringify({providers: {fixture: {baseUrl: api.url, api: 'anthropic-messages', models: [{id: 'protected-model', name: 'Protected fixture', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 1024}]}}}));
  }
  if (protocol === 'opencode') {
    mkdirSync(join(accountDir, 'opencode'), {recursive: true});
    writeFileSync(join(accountDir, 'opencode/auth.json'), JSON.stringify({fixture: {type: 'api', key: 'synthetic-fixture-key'}}));
    writeFileSync(join(accountDir, 'opencode/opencode.json'), JSON.stringify({provider: {fixture: {npm: '@ai-sdk/anthropic', options: {baseURL: api.url + '/v1'}, models: {'protected-model': {name: 'Protected fixture', limit: {context: 200000, output: 1024}}}}}, model: 'fixture/protected-model'}));
    b.h.core.bus.onAny((name, request) => {if (name === 'permission.requested') void b.client.call('permissions.answer', {requestId: (request as {id: string}).id, decision: 'allow'});});
  }
  const provider = b.h.core.providers.require(protocol);
  const model = protocol === 'claude' ? 'claude-sonnet-5' : protocol === 'muse' ? 'protected-model' : protocol === 'codex' ? 'gpt-6.1-sol' : 'fixture/protected-model';
  provider.models = [{id: model, name: 'Synthetic fixture', default: true}];
  for (const profile of Object.values(provider.profiles)) if (profile) {
    profile.executable = [{kind: 'file', value: (process.env[`BOITE_TEST_${protocol.toUpperCase()}_CLI`] || Bun.which(protocol)) ?? (() => {throw new Error(`Native fixture requires installed ${protocol}`);})()}];
    if (protocol === 'pi' && process.platform === 'win32') profile.executable = [{kind: 'npm', value: '@earendil-works/pi-coding-agent#pi'}];
    profile.isolation = {...profile.isolation, HOME: accountDir, ...(protocol === 'pi' ? {PI_CODING_AGENT_DIR: accountDir} : protocol === 'opencode' ? {XDG_CONFIG_HOME: accountDir, XDG_DATA_HOME: accountDir} : {}), ...(protocol === 'claude' ? {ANTHROPIC_API_KEY: 'synthetic-fixture-key', ANTHROPIC_BASE_URL: api.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'} : {})};
  }
  if (protocol === 'muse') {
    // Resolve an official Windows .cmd launcher to its actual versioned program.
    const executable = museExecutable(provider);
    for (const profile of Object.values(provider.profiles)) if (profile) profile.executable = [{kind: 'file', value: executable}];
  }
  await b.client.call('threads.update', {threadId: b.threadId, accountId: account.id, model, permissionMode: nativeMode(protocol)});
  return account;
}

test.skipIf(!nativePlatforms.includes(process.platform) || process.env.BOITE_TEST_NATIVE_EXECUTION !== '1').each(nativeProviders)('protected %s remote jobs preserve the host route and return a real consumable commit', async protocol => {
  const {a, b, sharedProjectId, job, agent} = await fixture(); agent.close();
  await a.client.call('sharedCompute.cancel', {sharedProjectId, threadId: a.threadId, jobId: job.id, requestId: 'cancel-initial'});
  writeFileSync(join(a.path, 'answer.js'), 'export const answer = 41;\n');
  writeFileSync(join(a.path, 'answer.test.js'), "import {test, expect} from 'bun:test'; import {answer} from './answer.js'; test('answer', () => expect(answer).toBe(42));\n");
  writeFileSync(join(a.path, '.gitignore'), 'dist/\n');
  await git(a.h, a.path, 'add', 'answer.js', 'answer.test.js', '.gitignore');
  await git(a.h, a.path, 'commit', '-m', 'Fixture source');
  await git(b.h, b.path, 'fetch', a.path, 'main'); await git(b.h, b.path, 'reset', '--hard', 'FETCH_HEAD');
  const api = protectedProviderApi(protocol === 'pi' || protocol === 'opencode' ? 'claude' : protocol, [
    {name: nativeName(protocol), input: nativeCommand(`const fs=require('fs'); if(fs.existsSync('.git')||process.env.BOITE_TOKEN) throw new Error('ambient authority'); fs.writeFileSync('answer.js',fs.readFileSync('answer.js','utf8').replace('41','42')); for (const args of [['build','answer.js','--outdir','dist'],['test','answer.test.js']]) {const p=Bun.spawnSync([process.execPath,...args]); if(p.exitCode) throw new Error(p.stderr.toString());}`)},
    {name: nativeName(protocol, true), input: {message: 'Apply validated fixture edit'}},
  ], body => protocol === 'opencode' && !(body as {tools?: unknown[]}).tools?.length);
  try {
    const account = await nativeHost(b, protocol, api);
    await b.client.call('sharedProjects.configure', {sharedProjectId, computeThreadId: b.threadId, compute: {enabled: true, profiles: ['conversation'], permissionMode: nativeMode(protocol), maxConcurrent: null}});
    const routes = await a.client.call('sharedCompute.models', {sharedProjectId, threadId: a.threadId, host: b.ref});
    expect(routes[0]).toMatchObject({protocol: b.h.core.providers.require(protocol).protocol, permissionMode: nativeMode(protocol), protection: {supported: true, boundary: 'isolated-process'}});
    const base = await git(a.h, a.path, 'rev-parse', 'HEAD');
    const started = await a.client.call('sharedCompute.start', {sharedProjectId, threadId: a.threadId, requestId: `native-${protocol}`, host: b.ref, profileId: 'conversation', baseCommit: base, task: 'Edit answer.js, run its test and commit the protected edits.'});
    await waitFor(() => ['done', 'failed'].includes(b.h.core.sharedCompute.journal.get(started.id, 'host')!.job.status), 30000);
    const finished = b.h.core.sharedCompute.journal.get(started.id, 'host')!.job;
    expect(finished).toMatchObject({status: 'done', providerId: protocol, permissionMode: nativeMode(protocol), result: {baseCommit: base, dirty: false}});
    expect(finished.result!.commit, JSON.stringify(api.requests.map(request => (request as {messages?: {role: string; content: unknown}[]}).messages?.filter(message => message.role === 'user').at(-1)))).not.toBe(base);
    const worker = b.h.core.threads.require(started.worker!.threadId);
    expect(worker.accountId).toBe(account.id);
    expect(readFileSync(join(worker.cwd, 'answer.js'), 'utf8')).toContain('42');
    await git(a.h, a.path, 'fetch', b.path, finished.result!.branch);
    expect(await git(a.h, a.path, 'rev-parse', 'FETCH_HEAD')).toBe(finished.result!.commit);
    await git(a.h, a.path, 'merge-base', '--is-ancestor', base, finished.result!.commit);
    await git(a.h, a.path, 'cherry-pick', finished.result!.commit);
    expect(readFileSync(join(a.path, 'answer.js'), 'utf8')).toContain('42');
  } finally {api.stop();}
}, 60000);

test.skipIf(!nativePlatforms.includes(process.platform) || process.env.BOITE_TEST_NATIVE_EXECUTION !== '1')('protected opencode remote jobs refuse an unavailable host model before any API call', async () => {
  const {a, b, sharedProjectId, job, agent} = await fixture(); agent.close();
  await a.client.call('sharedCompute.cancel', {sharedProjectId, threadId: a.threadId, jobId: job.id, requestId: 'cancel-initial'});
  const api = protectedProviderApi('claude', [], body => !(body as {tools?: unknown[]}).tools?.length);
  try {
    await nativeHost(b, 'opencode', api);
    const model = 'fixture/unoffered-model';
    b.h.core.providers.require('opencode').models = [{id: model, name: 'Unavailable native model', default: true}];
    await b.client.call('threads.update', {threadId: b.threadId, model});
    await b.client.call('sharedProjects.configure', {sharedProjectId, computeThreadId: b.threadId,
      compute: {enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent: null}});
    const started = await a.client.call('sharedCompute.start', {sharedProjectId, threadId: a.threadId, requestId: 'missing-model',
      host: b.ref, profileId: 'conversation', baseCommit: await git(a.h, a.path, 'rev-parse', 'HEAD'), task: 'Run using the host-selected model.'});
    await waitFor(() => ['done', 'failed'].includes(b.h.core.sharedCompute.journal.get(started.id, 'host')!.job.status), 30000);
    expect(b.h.core.sharedCompute.journal.get(started.id, 'host')!.job).toMatchObject({status: 'failed', model});
    expect(api.requests).toHaveLength(0);
  } finally {api.stop();}
}, 60000);

// Actual provider processes use the same scope preparation as ordinary turns.
test.skipIf(!nativePlatforms.includes(process.platform) || process.env.BOITE_TEST_NATIVE_EXECUTION !== '1').each(nativeProviders.flatMap(protocol => (['letter', 'board'] as const).map(route => [protocol, route] as const)))('protected %s %s scopes retire ordinary warm control, inherit, replace overrides and stop tools', async (protocol, route) => {
  const {a, b, sharedProjectId, job, agent} = await fixture(); agent.close();
  await a.client.call('sharedCompute.cancel', {sharedProjectId, threadId: a.threadId, jobId: job.id, requestId: 'cancel-initial'});
  const api = protectedProviderApi(protocol === 'pi' || protocol === 'opencode' ? 'claude' : protocol, [], body => protocol !== 'codex' && protocol !== 'muse' && !JSON.stringify((body as {tools?: unknown}).tools ?? []).includes('boite_exec'));
  try {
    const account = await nativeHost(b, protocol, api);
    await b.client.call('settings.set', {warmProcessMinutes: 5});
    writeFileSync(join(b.path, 'answer.txt'), '41');
    writeFileSync(join(b.path, '.env'), 'SYNTHETIC_EXACT_OVERRIDE');
    const ordinary = await b.client.call('turns.start', {threadId: b.threadId, prompt: 'Ordinary host turn'});
    await waitFor(() => b.h.core.journal.getTurn(ordinary.id)?.status === 'done', 30000).catch(error => {throw new Error(`Ordinary native turn did not finish: ${JSON.stringify(b.h.core.journal.getTurn(ordinary.id))}; requests: ${JSON.stringify(api.requests)}`, {cause: error});});
    expect(b.h.core.procs.liveCount(b.threadId)).toBeGreaterThan(0);
    const name = nativeName(protocol);
    api.enqueue({name, input: nativeCommand("const fs=require('fs'); if(fs.existsSync('.env')||fs.existsSync('.git')) throw new Error('hidden files'); fs.writeFileSync('answer.txt','42');")});
    if (route === 'letter') {
      await a.client.call('collaboration.send', {threadId: a.threadId, to: {coreId: b.coreId, threadId: b.threadId}, text: 'Edit the ordinary project file with protected tools', requestId: 'native-letter'});
    } else {
      for (const host of [a, b]) await host.client.call('sharedProjects.configure', {sharedProjectId, board: true});
      const scope = {threadId: b.threadId, sharedProjectId};
      const added = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', cardId: 'native', requestId: 'add', text: 'Edit the ordinary project file with protected tools'}});
      const claimed = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', cardId: 'native', requestId: 'claim', expectedRevision: added.card!.revision, worker: {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}}}});
      await b.client.call('sharedBoard.start', {...scope, cardId: 'native', claimId: claimed.card!.assignment!.claimId});
    }
    await waitFor(() => readFileSync(join(b.path, 'answer.txt'), 'utf8').trim() === '42', 30000).catch(error => {throw new Error(`Native scope did not publish edits: ${JSON.stringify(b.h.core.journal.lastTurn(b.threadId))}`, {cause: error});});
    await waitFor(() => b.h.core.threads.require(b.threadId).status === 'idle');
    if (route === 'board') b.h.core.activity.control({threadId: b.threadId, kind: 'goal', action: 'pause'});
    const execution = b.h.core.sharedAccess.execution.context(b.threadId)!;
    expect(b.h.core.procs.protection.policy(b.threadId)?.scope.kind).toBe(route);
    expect(b.h.core.threads.require(b.threadId)).toMatchObject({accountId: account.id, permissionMode: nativeMode(protocol)});
    await b.h.core.sharedAccess.execution.prepare(b.threadId);
    expect(b.h.core.sharedAccess.execution.context(b.threadId)?.fingerprint).toBe(execution.fingerprint);
    const child = b.h.core.threads.create({projectId: b.ref.projectId, providerId: protocol, accountId: account.id, permissionMode: nativeMode(protocol)}, {id: `thr_native_${protocol}_${route}`, branch: null, parentThreadId: b.threadId});
    await b.h.core.sharedAccess.execution.prepare(child.id);
    expect((await b.h.core.sharedAccess.execution.context(child.id)!.execute(...nativeRead('.env'))).code).not.toBe(0);
    if (protocol === 'claude') {
      const limited = b.h.core.threads.create({projectId: b.ref.projectId, providerId: protocol, accountId: account.id, context: {tools: ['Read']}}, {id: `thr_limited_${protocol}_${route}`, branch: null, parentThreadId: b.threadId});
      await b.h.core.sharedAccess.execution.prepare(limited.id);
      expect(await thrown(b.h.core.sharedAccess.execution.context(limited.id)!.execute(process.execPath, ['-e', '']))).toThrow('host context disables tools');
    }
    const override = await b.client.call('sharedAccess.override', {sharedProjectId, requestId: 'native-exact', override: {path: '.env', actions: ['read'], jobId: null, reason: 'Synthetic exact native read', expiresAt: Date.now() + 60000}});
    expect(() => execution.check()).toThrow();
    await b.h.core.sharedAccess.execution.prepare(b.threadId);
    const replaced = b.h.core.sharedAccess.execution.context(b.threadId)!;
    expect(replaced.fingerprint).not.toBe(execution.fingerprint);
    expect((await replaced.execute(...nativeRead('.env'))).stdout).toBe('SYNTHETIC_EXACT_OVERRIDE');
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: override.id});
    expect(() => replaced.check()).toThrow();
    await b.h.core.sharedAccess.execution.prepare(b.threadId);
    api.enqueue({name, input: nativeCommand("require('fs').writeFileSync('tool-active','running'); setInterval(()=>{},1000)")});
    const stopped = await b.client.call('turns.start', {threadId: b.threadId, prompt: 'Run the cancellable protected tool'});
    await waitFor(() => b.h.core.procs.liveCount(b.threadId) > 0, 15000).catch(error => {throw new Error(`Native scope did not start cancellable control: ${JSON.stringify(b.h.core.journal.getTurn(stopped.id))}`, {cause: error});});
    const active = b.h.core.sharedAccess.execution.context(b.threadId)!;
    b.h.core.threads.stopTurn(b.threadId);
    expect(() => active.check()).toThrow();
    await waitFor(() => b.h.core.procs.liveCount(b.threadId) === 0);
    await waitFor(() => b.h.core.journal.getTurn(stopped.id)?.finishedAt != null);
    if (route === 'board') {
      b.h.core.activity.set({threadId: b.threadId, goal: null});
      await b.h.core.sharedAccess.execution.prepare(b.threadId);
      expect(b.h.core.procs.protection.policy(b.threadId)).toBeNull();
      const local = b.h.core.procs.spawn(b.threadId, ...nativeRead('.env'), {cwd: b.path});
      expect(await new Response(local.proc.stdout).text()).toBe('SYNTHETIC_EXACT_OVERRIDE'); await local.exited;
      expect(() => b.h.core.sharedAccess.execution.context(child.id)).toThrow();
    } else {
      await b.h.core.sharedAccess.execution.prepare(b.threadId);
      const restored = b.h.core.sharedAccess.execution.context(b.threadId)!;
      await b.client.call('contacts.revoke', {coreId: a.coreId, projectId: b.ref.projectId});
      expect(() => restored.check()).toThrow();
    }
  } finally {api.stop();}
}, 90000);

test('shared file reads deny secret names and aliases while ordinary local work is unchanged', async () => {
  const {b, worker, agent} = await fixture();
  try {
    writeFileSync(join(worker.cwd, '.env.production'), 'TOKEN=fixture-secret-canary');
    writeFileSync(join(worker.cwd, 'readme.txt'), 'ordinary file');
    symlinkSync('.env.production', join(worker.cwd, 'alias.txt'));
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path: '.env.production'}))).toThrow('shared file policy');
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path: 'alias.txt'}))).toThrow('shared file policy');
    expect(await agent.call('files.read', {threadId: worker.id, path: 'readme.txt'})).toMatchObject({kind: 'text', text: 'ordinary file'});
    writeFileSync(join(b.path, '.env.production'), 'TOKEN=local-only-canary');
    expect(await b.client.call('files.read', {threadId: b.threadId, path: '.env.production'})).toMatchObject({text: 'TOKEN=local-only-canary'});
  } finally {agent.close();}
}, 30000);

test('a shared board goal and its tracker cannot escape the no-tools boundary', async () => {
  const {a, b, sharedProjectId, agent} = await fixture();
  try {
    for (const side of [a, b]) await side.client.call('sharedProjects.configure', {sharedProjectId, board: true});
    const scope = {threadId: b.threadId, sharedProjectId};
    const marker = join(b.path, 'board-shell-marker');
    const add = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', cardId: 'escape', requestId: 'add', text: `[spawn:touch ${marker}]`}});
    const claim = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', cardId: 'escape', requestId: 'claim', expectedRevision: add.card!.revision, worker: {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}}}});
    await b.client.call('sharedBoard.start', {...scope, cardId: 'escape', claimId: claim.card!.assignment!.claimId});
    await waitFor(() => b.h.core.journal.lastTurn(b.threadId)?.finishedAt !== null);
    expect(existsSync(marker)).toBe(false);
    for (const name of ['.env', 'ordinary-upload.txt']) {
      const attachments = [{kind: 'file' as const, name, mimeType: 'text/plain', data: Buffer.from('TOKEN=uploaded-secret-canary').toString('base64')}];
      expect(await thrown(b.client.call('turns.start', {threadId: b.threadId, prompt: 'Read attachment', attachments}))).toThrow('shared file policy');
    }
    const upload = await b.client.call('turns.start', {threadId: b.threadId, prompt: 'Read attachment', attachments: [{kind: 'file', name: 'ordinary-upload.txt', mimeType: 'text/plain', data: Buffer.from('ordinary upload').toString('base64')}]});
    await waitFor(() => b.h.core.journal.getTurn(upload.id)?.status === 'done');
    writeFileSync(join(b.path, '.env'), 'TOKEN=board-secret-canary');
    expect(await thrown(b.client.call('files.read', {threadId: b.threadId, path: '.env'}))).toThrow('shared file policy');
    const children = b.h.core.journal.listChildThreads().filter(t => t.parentThreadId === b.threadId && t.id !== b.h.core.sharedCompute.journal.worker(t.id)?.job.worker?.threadId);
    expect(children.length).toBeGreaterThan(0);
    // Capture a tracker scope before its parent is replaced. The old child never becomes a local unrestricted agent.
    const child = children[0]!;
    b.h.core.sharedAccess.bound(child.id);
    const dormant = b.h.core.threads.create({projectId: b.ref.projectId, providerId: 'echo', accountId: b.h.core.threads.require(b.threadId).accountId}, {id: 'thr_dormant_shared', branch: null, parentThreadId: b.threadId});
    const override = await b.client.call('sharedAccess.override', {sharedProjectId, requestId: 'board-override', override: {path: '.env', actions: ['read'], jobId: null, reason: 'fixture', expiresAt: Date.now() + 60000}});
    expect(await b.client.call('files.read', {threadId: b.threadId, path: '.env'})).toMatchObject({text: 'TOKEN=board-secret-canary'});
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: override.id});
    writeFileSync(join(b.path, 'board.png'), 'ordinary board publication');
    const published = await b.client.call('artifacts.publish', {threadId: b.threadId, path: 'board.png'});
    const attachment = {threadId: b.threadId, messageId: published.id, partIndex: 0, ticket: true};
    const ticket = await b.client.call('messages.attachment', attachment);
    b.h.core.activity.set({threadId: b.threadId, goal: null});
    expect(await b.client.call('files.read', {threadId: b.threadId, path: '.env'})).toMatchObject({text: 'TOKEN=board-secret-canary'});
    expect(await thrown(b.client.call('files.read', {threadId: child.id, path: '.env'}))).toThrow('shared file policy');
    expect(await thrown(b.client.call('files.read', {threadId: dormant.id, path: '.env'}))).toThrow('shared file policy');
    expect((await fetch(`${b.h.url}${ticket.url}`)).status).toBe(404);
    expect(await thrown(b.client.call('messages.attachment', attachment))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('shared attachments cannot publish a secret through the alternate snapshot route', async () => {
  const {b, worker, agent} = await fixture();
  try {
    await waitFor(() => b.h.core.journal.lastTurn(worker.id)?.status === 'running');
    writeFileSync(join(worker.cwd, '.env'), 'TOKEN=snapshot-secret-canary');
    expect(await thrown(agent.call('artifacts.publish', {threadId: worker.id, path: '.env'}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('shared inline pages cannot embed a credential file under a permitted JSON extension', async () => {
  const {b, job, worker, agent} = await fixture();
  try {
    await waitFor(() => b.h.core.journal.lastTurn(worker.id)?.status === 'running');
    writeFileSync(join(worker.cwd, 'credentials.json'), '{"password":"view-secret-canary"}');
    writeFileSync(join(worker.cwd, 'index.html'), '<html><script src="credentials.json"></script><body>Fixture</body></html>');
    b.h.core.browser.probe = async () => ({errors: [], heights: [100, 100]});
    expect(await thrown(agent.call('artifacts.view', {threadId: worker.id, path: 'index.html'}))).toThrow('shared file policy');
    b.h.core.browser.checkView = async () => ({errors: [], heights: [100, 100], captures: []});
    // The owner uses the same shared-thread file policy as the worker.
    expect(await thrown(b.client.call('artifacts.viewCheck', {threadId: worker.id, path: 'index.html'}))).toThrow('shared file policy');
    expect(await thrown(agent.call('artifacts.viewCheck', {threadId: worker.id, path: 'index.html'}))).toThrow('shared file policy');
    writeFileSync(join(worker.cwd, 'index.html'), '<html><body>Fixture</body></html>');
    expect((await agent.call('artifacts.viewCheck', {threadId: worker.id, path: 'index.html'})).checked).toBe(true);
    writeFileSync(join(worker.cwd, 'index.html'), '<html><script src="credentials.json"></script><body>Fixture</body></html>');
    const override = await b.client.call('sharedAccess.override', {sharedProjectId: job.sharedProjectId, requestId: 'draft', override: {
      path: 'credentials.json', actions: ['publish'], jobId: job.id, reason: 'fixture', expiresAt: Date.now() + 60000,
    }});
    b.h.core.browser.checkView = async () => {
      await b.client.call('sharedAccess.revokeOverride', {sharedProjectId: job.sharedProjectId, overrideId: override.id});
      return {errors: [], heights: [100, 100], captures: []};
    };
    expect(await thrown(agent.call('artifacts.viewCheck', {threadId: worker.id, path: 'index.html'}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('a shared worker cannot read historical secrets by asking for an ordinary Git diff', async () => {
  const {b, worker, agent} = await fixture();
  try {
    writeFileSync(join(worker.cwd, '.env'), 'TOKEN=git-secret-canary');
    await git(b.h, worker.cwd, 'add', '.env');
    await git(b.h, worker.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    rmSync(join(worker.cwd, '.env'));
    expect(await thrown(agent.call('git.diff', {threadId: worker.id, path: '.env'}))).toThrow('shared file policy');
    expect(await thrown(b.client.call('git.diff', {threadId: worker.id, path: '.env'}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('checked shared file tickets reject file and parent swaps instead of reading their replacement', async () => {
  const {b, worker, agent} = await fixture();
  try {
    mkdirSync(join(worker.cwd, 'assets'));
    writeFileSync(join(worker.cwd, 'assets', 'okay.png'), 'ordinary image');
    writeFileSync(join(worker.cwd, '.env'), 'TOKEN=swap-secret-canary');
    const first = await agent.call('files.read', {threadId: worker.id, path: 'assets/okay.png'});
    if (first.kind === 'text') throw new Error('fixture expected a ticket');
    rmSync(join(worker.cwd, 'assets', 'okay.png')); symlinkSync('../.env', join(worker.cwd, 'assets', 'okay.png'));
    expect((await fetch(`${b.h.url}${first.url}`)).status).toBe(404);
    rmSync(join(worker.cwd, 'assets', 'okay.png')); writeFileSync(join(worker.cwd, 'assets', 'okay.png'), 'ordinary image');
    const second = await agent.call('files.read', {threadId: worker.id, path: 'assets/okay.png'});
    if (second.kind === 'text') throw new Error('fixture expected a ticket');
    renameSync(join(worker.cwd, 'assets'), join(worker.cwd, 'held-assets'));
    symlinkSync(b.path, join(worker.cwd, 'assets'));
    expect((await fetch(`${b.h.url}${second.url}`)).status).toBe(404);
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path: 'assets/okay.png'}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('host audit pages and revoked overrides survive restart with association-bound cursors', async () => {
  const {a, b, worker, job, sharedProjectId, agent} = await fixture();
  try {
    const path = '.env'; writeFileSync(join(worker.cwd, path), 'TOKEN=restart-secret-canary');
    const value = await b.client.call('sharedAccess.override', {sharedProjectId, requestId: 'durable', override: {path, actions: ['read'], jobId: job.id, reason: 'fixture', expiresAt: Date.now() + 60000}});
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: value.id});
    const stop = b.h.core.sharedAccess.onEvent(() => {throw new Error('fixture unavailable reviewer');});
    for (let i = 0; i < 103; i++) expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    stop();
    const p = {threadId: b.threadId, sharedProjectId};
    const page = await b.client.call('sharedAccess.get', p);
    expect(page.events).toHaveLength(100); expect(page.next).not.toBeNull();
    const tail = await b.client.call('sharedAccess.get', {...p, after: page.next!});
    expect(tail.events.length).toBeGreaterThan(0);
    expect(tail.events.some(e => page.events.some(earlier => earlier.id === e.id))).toBe(false);
    expect(await thrown(a.client.call('sharedAccess.get', {threadId: a.threadId, sharedProjectId, after: page.next!}))).toThrow('cursor');
    agent.close(); await b.h.stop();
    const restarted = await startTestCore({dataDir: b.h.dataDir}); cores.push(restarted);
    const client = await restarted.connect();
    const afterRestart = await client.call('sharedAccess.get', p);
    expect(afterRestart).toEqual(page);
    expect((await client.call('sharedAccess.overrides', {sharedProjectId})).find(o => o.id === value.id)?.revokedAt).not.toBeNull();
    const last = tail.events.at(-1)!.id;
    const later = (await client.call('sharedAccess.get', {...p, after: last})).events;
    const earlierIds = new Set([...page.events, ...tail.events].map(e => e.id));
    expect(later.every(e => !earlierIds.has(e.id))).toBe(true);
    expect(JSON.stringify(later)).not.toContain('restart-secret-canary');
  } finally {agent.close();}
}, 30000);

test('provider protection capabilities are explicit and no external tool provider claims an unimplemented sandbox', () => {
  expect(sharedExecutionProtection('echo')).toEqual({supported: true, boundary: 'no-tools'});
  for (const protocol of ['claude-sdk', 'codex-appserver', 'acp', 'muse', 'pi'] as const) {
    const protection = sharedExecutionProtection(protocol);
    expect(protection.supported).toBe(false);
    if (!protection.supported) expect(protection.reason.length).toBeGreaterThan(20);
  }
});

test('shared file checkpoints retain ordinary files and never snapshot protected file bytes', async () => {
  const {b, worker, agent} = await fixture();
  try {
    for (const name of ['.env', 'server.pem', 'credentials.json', 'copied.txt']) writeFileSync(join(worker.cwd, name), 'TOKEN=checkpoint-secret-canary');
    writeFileSync(join(worker.cwd, 'ordinary.txt'), 'normal checkpoint');
    const saved = await snapshot(b.h.core, worker.id, worker.cwd, join(b.h.dataDir, 'fixture-checkpoint'));
    expect(Object.keys(saved)).toContain('ordinary.txt');
    for (const name of ['.env', 'server.pem', 'credentials.json', 'copied.txt']) expect(Object.keys(saved)).not.toContain(name);
  } finally {agent.close();}
}, 30000);

test('binary and large-file tickets cannot slice around credential detection with Range', async () => {
  const {worker, agent} = await fixture();
  try {
    writeFileSync(join(worker.cwd, 'report.png'), 'TOKEN=range-secret-canary');
    writeFileSync(join(worker.cwd, 'report.log'), `${'ordinary line\n'.repeat(30000)}TOKEN=large-secret-canary`);
    for (const path of ['report.png', 'report.log']) expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('remote transcript and search cannot republish a local credential-like answer', async () => {
  const {a, b, sharedProjectId, agent} = await fixture();
  try {
    await b.client.call('turns.start', {threadId: b.threadId, prompt: 'TOKEN=transcript-secret-canary'});
    await waitFor(() => b.h.core.journal.lastTurn(b.threadId)?.status === 'done').catch(error => {
      throw new Error(`Transcript fixture did not finish: ${JSON.stringify({turn: b.h.core.journal.lastTurn(b.threadId), scheduler: b.h.core.scheduler.state()})}`, {cause: error});
    });
    const listed = await a.client.call('sharedProjects.threads', {threadId: a.threadId, sharedProjectId});
    const target = listed.threads.find(t => t.ref.project.ownerCoreId === b.coreId && t.ref.threadId === b.threadId)!.ref;
    const read = await a.client.call('sharedProjects.read', {threadId: a.threadId, sharedProjectId, target});
    expect(JSON.stringify(read)).not.toContain('transcript-secret-canary');
    const search = await a.client.call('sharedProjects.search', {threadId: a.threadId, sharedProjectId, query: 'transcript-secret-canary'});
    expect(search.matches).toEqual([]);
  } finally {agent.close();}
}, 30000);

test('canonical file admission covers secret variants, Windows spellings, traversal, symlinks and hard links', async () => {
  const {b, worker, agent} = await fixture();
  try {
    const names = ['.env', '.env.example', '.env.local', '.env.production.local', '.envrc', '.dev.vars', 'id_ed25519', 'server.pem', 'server.key', 'credentials.json', 'secrets.yaml', '.npmrc', 'terraform.tfstate'];
    for (const path of names) {
      writeFileSync(join(worker.cwd, path), 'fixture');
      expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    }
    writeFileSync(join(worker.cwd, 'okay.txt'), 'fixture');
    writeFileSync(join(worker.cwd, 'copied.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----');
    mkdirSync(join(worker.cwd, '.aws')); writeFileSync(join(worker.cwd, '.aws', 'config'), 'fixture');
    symlinkSync(b.path, join(worker.cwd, 'outside'));
    symlinkSync('.aws', join(worker.cwd, 'aws-alias'));
    linkSync(join(worker.cwd, '.env'), join(worker.cwd, 'hard-alias.txt'));
    for (const path of ['.aws/config', 'aws-alias/config', 'hard-alias.txt', 'copied.txt', '../.env', 'outside/.env', 'C:\\project\\.env', 'C:okay.txt', '\\\\server\\share\\.env', '\\\\?\\C:\\project\\.env', 'okay.txt:secret', '.env. ', '.env\\..\\okay.txt'])
      expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    const listed = await agent.call('files.list', {threadId: worker.id});
    expect(listed.map(f => f.name)).toContain('okay.txt');
    for (const name of [...names, '.aws', 'outside', 'aws-alias', 'hard-alias.txt']) expect(listed.map(f => f.name)).not.toContain(name);
    expect(await thrown(agent.call('files.list', {threadId: worker.id, path: '.aws'}))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);

test('host overrides are exact, action/job/grant bound, expiring, revocable and durable without leaking paths', async () => {
  const {a, b, sharedProjectId, job, worker, agent} = await fixture();
  try {
    const path = '.env.private.png'; writeFileSync(join(worker.cwd, path), 'TOKEN=override-secret-canary');
    const input = {sharedProjectId, requestId: 'override', override: {path, actions: ['read' as const], jobId: job.id, reason: 'fixture owner consent', expiresAt: Date.now() + 60000}};
    expect(await thrown(agent.call('sharedAccess.override', input))).toThrow('agent');
    const override = await b.client.call('sharedAccess.override', input);
    expect((await b.client.call('sharedAccess.override', input)).id).toBe(override.id);
    expect((await b.client.call('sharedProjects.get', {threadId: b.threadId, sharedProjectId})).protection.activeOverrides).toBe(1);
    expect((await a.client.call('sharedAccess.overrides', {sharedProjectId}))).toEqual([]);
    const file = await agent.call('files.read', {threadId: worker.id, path});
    if (file.kind === 'text') throw new Error('fixture expected a ticket');
    expect(await (await fetch(`${b.h.url}${file.url}`)).text()).toBe('TOKEN=override-secret-canary');
    expect(await thrown(agent.call('artifacts.publish', {threadId: worker.id, path}))).toThrow('shared file policy');
    expect(await thrown(b.client.call('sharedAccess.override', {...input, requestId: 'execute', override: {...input.override, actions: ['execute']}}))).toThrow('execute');
    expect(await thrown(b.client.call('sharedAccess.override', {...input, requestId: 'outside', override: {...input.override, path: '../outside.key'}}))).toThrow('shared file policy');
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: override.id});
    expect((await fetch(`${b.h.url}${file.url}`)).status).toBe(404);
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    expect((await b.client.call('sharedAccess.override', input)).revokedAt).not.toBeNull();
    const replacement = await b.client.call('sharedAccess.override', {...input, requestId: 'replacement'});
    const stored = b.h.core.sharedAccess.journal.overrides(sharedProjectId).find(o => o.value.id === replacement.id)!;
    stored.value.expiresAt = Date.now() - 1; b.h.core.sharedAccess.journal.putOverride(stored);
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    const changed = await b.client.call('sharedAccess.override', {...input, requestId: 'changed'});
    writeFileSync(join(worker.cwd, path), 'TOKEN=changed-version');
    expect(await thrown(agent.call('files.read', {threadId: worker.id, path}))).toThrow('shared file policy');
    expect(changed.path).toBe(path);
    const page = await agent.call('sharedAccess.get', {threadId: worker.id, sharedProjectId});
    const wire = JSON.stringify(page);
    for (const secret of ['override-secret-canary', 'changed-version', path, worker.cwd, 'fixture owner consent']) expect(wire).not.toContain(secret);
    expect(page.events.some(e => e.decision === 'denied' && e.classification === 'environment')).toBe(true);
    const denied = page.events.find(e => e.decision === 'denied' && e.classification)!;
    expect(b.h.core.sharedAccess.confirmed(denied.id, sharedProjectId)).toBe(true);
    expect(b.h.core.sharedAccess.confirmed(denied.id, 'other')).toBe(false);
  } finally {agent.close();}
}, 30000);

test.each(['.env.png', 'report.png'])('published %s tickets lose authority on override or grant revoke', async path => {
  const {b, sharedProjectId, job, worker, agent} = await fixture();
  try {
    await waitFor(() => b.h.core.journal.lastTurn(worker.id)?.status === 'running');
    const content = 'TOKEN=publication-secret-canary\n' + (path === 'report.png' ? 'x'.repeat(2 * 1024 * 1024) : '');
    writeFileSync(join(worker.cwd, path), content);
    const override = await b.client.call('sharedAccess.override', {sharedProjectId, requestId: 'publish', override: {path, actions: ['publish'], jobId: job.id, reason: 'fixture', expiresAt: Date.now() + 60000}});
    const message = await agent.call('artifacts.publish', {threadId: worker.id, path});
    const params = {threadId: worker.id, messageId: message.id, partIndex: 0, ticket: true};
    const attachment = await b.client.call('messages.attachment', params);
    expect(await (await fetch(`${b.h.url}${attachment.url}`)).text()).toBe(content);
    expect((await fetch(`${b.h.url}${attachment.url}`)).headers.get('cache-control')).toBe('no-store');
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: override.id});
    expect((await fetch(`${b.h.url}${attachment.url}`)).status).toBe(404);
    expect(await thrown(b.client.call('messages.attachment', params))).toThrow('shared file policy');
    writeFileSync(join(worker.cwd, 'okay.png'), 'ordinary bytes');
    const file = await agent.call('files.read', {threadId: worker.id, path: 'okay.png'});
    if (file.kind === 'text') throw new Error('fixture expected a ticket');
    expect((await fetch(`${b.h.url}${file.url}`, {headers: {range: 'bytes=0-3'}})).status).toBe(206);
    await b.client.call('sharedProjects.revoke', {sharedProjectId, requestId: 'revoke'});
    expect((await fetch(`${b.h.url}${file.url}`)).status).toBe(404);
  } finally {agent.close();}
}, 30000);


test('a published view keeps each source content override through ticket renewal', async () => {
  const {b, sharedProjectId, job, worker, agent} = await fixture();
  try {
    writeFileSync(join(worker.cwd, 'index.html'), '<!doctype html><img src="report.png">');
    writeFileSync(join(worker.cwd, 'report.png'), 'TOKEN=view-secret-canary');
    const override = await b.client.call('sharedAccess.override', {sharedProjectId, requestId: 'view-publish', override: {path: 'report.png', actions: ['publish'], jobId: job.id, reason: 'fixture', expiresAt: Date.now() + 60000}});
    b.h.core.browser.probe = async () => ({errors: [], heights: [100, 100]});
    const {message} = await agent.call('artifacts.view', {threadId: worker.id, path: 'index.html'});
    const part = message.parts[0];
    if (part?.type !== 'artifact') throw new Error('fixture expected a published view');
    const params = {threadId: worker.id, messageId: message.id, artifactId: part.id, view: true as const};
    const ticket = await b.client.call('artifacts.read', params);
    expect(await (await fetch(`${b.h.url}${ticket.url}`)).text()).toContain(Buffer.from('TOKEN=view-secret-canary').toString('base64'));
    await b.client.call('sharedAccess.revokeOverride', {sharedProjectId, overrideId: override.id});
    expect((await fetch(`${b.h.url}${ticket.url}`)).status).toBe(404);
    expect(await thrown(b.client.call('artifacts.read', params))).toThrow('shared file policy');
  } finally {agent.close();}
}, 30000);


test('a disappeared shared checkout returns a policy refusal', async () => {
  const {b, worker, agent} = await fixture();
  // The job is admitted before turn preparation finishes. On Windows its Git
  // processes still hold the checkout until the driver starts its response.
  const turn = b.h.core.journal.lastTurn(worker.id)!;
  await waitFor(() => [...b.h.core.journal.walkTurnMessages(worker.id, turn.id)].some(message => message.role === 'assistant'));
  const moved = worker.cwd + '-removed';
  renameSync(worker.cwd, moved);
  try {
    expect(() => b.h.core.sharedAccess.file(worker.id, 'ordinary.txt')).toThrow('shared file policy: expected the captured job checkout');
  } finally {renameSync(moved, worker.cwd); agent.close();}
}, 30000);
