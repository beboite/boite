import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { homePath } from '../src/paths.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

/** An installed binary, a local API and disposable homes: no account or paid model is used. */
const binary = process.env['BOITE_E2E_OPENCODE2_BINARY'];
const compat = binary ? test : test.skip;

compat('OpenCode 2 runs tools, resumes cold, changes mode and stops beside a locked v1 profile', async () => {
  const route = 'openrouter/minimax/minimax-m3.1-flash:free';
  const captured: { model: string; messages?: { role: string; content: unknown }[]; tools?: { function: { name: string; parameters: unknown } }[] }[] = [];
  let hold = false;
  let toolAsked = false;
  let steeringProbe = true;
  let projectDir = '';
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/models') return Response.json({ data: [{ id: route, name: 'MiniMax local', supported_endpoint_types: ['openai'], context_length: 196608, max_output_tokens: 4096 }] });
    if (path !== '/v1/chat/completions') return new Response('Unexpected API path', { status: 404 });
    const body = await request.json() as (typeof captured)[number];
    captured.push(body);
    const interactive = (body.tools?.length ?? 0) > 0;
    if (hold && interactive) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'compat', object: 'chat.completion.chunk', created: 1, model: route, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const content = JSON.stringify(body.messages);
    const receivedSteering = content.includes('boundary-marker') && content.includes('immediate-marker');
    const tool = interactive && (!toolAsked || (steeringProbe && !receivedSteering));
    if (tool) toolAsked = true;
    return new Response(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-probe', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(projectDir, 'probe.txt') }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: 'pong' }) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  let harness: TestCore | undefined;
  let legacyDb: Database | undefined;
  const inherited = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map(key => [key, process.env[key]]));
  try {
    harness = await startTestCore({ settings: { warmProcessMinutes: 0, subscriptionProxy: { enabled: true, kind: 'douane', mode: 'remote', baseUrl: `http://127.0.0.1:${gateway.port}/v1`, dashboardUrl: `http://127.0.0.1:${gateway.port}/admin/` } } });
    const root = harness.dataDir;
    const legacy = join(root, 'v1');
    mkdirSync(join(legacy, 'opencode', 'plugins'), { recursive: true });
    writeFileSync(join(legacy, 'opencode', 'plugins', 'legacy.ts'), 'export const Plugin = async () => ({});');
    legacyDb = new Database(join(legacy, 'opencode', 'opencode.db'));
    legacyDb.exec('CREATE TABLE v1_marker (value TEXT); BEGIN EXCLUSIVE; INSERT INTO v1_marker VALUES (\'keep\')');
    for (const key of Object.keys(inherited)) process.env[key] = legacy;
    const provider = harness.core.providers.require('opencode-v2');
    for (const profile of Object.values(provider.profiles)) {
      if (!profile) continue;
      profile.executable = [{ kind: 'file', value: binary! }];
      profile.env = Object.fromEntries(Object.entries(profile.env ?? {}).map(([key, value]) => [key, value.split(homePath()).join(join(root, 'v2-home'))]));
    }
    const client = await harness.connect();
    const logs: string[] = [];
    client.on('core.log', entry => logs.push(`${entry.level}: ${entry.message}`));
    await client.call('providers.setEnabled', { providerId: provider.id, enabled: true });
    const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === provider.id)!;
    expect(account.status).toBe('ok');
    projectDir = join(root, 'project');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'probe.txt'), 'compat-tool-ok');
    const project = await client.call('projects.add', { path: projectDir, name: 'Compatibility' });
    const probe = await client.call('providers.probe', { providerId: provider.id, accountId: account.id });
    expect(probe.models.some(model => model.id === `douane/${route}`)).toBe(true);
    const thread = await client.call('threads.create', { projectId: project.id, providerId: provider.id, accountId: account.id, title: 'Compatibility', model: `douane/${route}` });
    const turn = async (prompt: string) => {
      const finished = client.next('turn.finished', done => done.threadId === thread.id, 45_000);
      await client.call('turns.start', { threadId: thread.id, prompt });
      const result = await finished;
      if (result.status !== 'done') console.error(logs.slice(-30).join('\n'));
      expect(result).toMatchObject({ status: 'done', error: null });
      return client.call('threads.get', { threadId: thread.id });
    };
    const boundary = client.next('turn.toolCompleted', event => event.threadId === thread.id, 45_000);
    const finished = client.next('turn.finished', done => done.threadId === thread.id, 45_000);
    const active = await client.call('turns.start', { threadId: thread.id, prompt: 'Read probe.txt, then reply pong' });
    await boundary;
    expect(await client.call('turns.steer', { threadId: thread.id, turnId: active.id, prompt: 'boundary-marker', clientRequestId: 'native_boundary_marker' })).toEqual({ accepted: true });
    expect(await client.call('turns.steer', { threadId: thread.id, turnId: active.id, prompt: 'immediate-marker', clientRequestId: 'native_immediate_marker' })).toEqual({ accepted: true });
    expect(await finished).toMatchObject({ status: 'done', error: null });
    steeringProbe = false;
    const first = await client.call('threads.get', { threadId: thread.id });
    expect(first.turns).toHaveLength(1);
    expect(captured.some(body => JSON.stringify(body.messages).includes('boundary-marker') && JSON.stringify(body.messages).includes('immediate-marker'))).toBe(true);
    const read = first.messages.flatMap(message => message.parts).find(part => part.type === 'tool' && part.status === 'done');
    expect(read).toMatchObject({ name: 'read', output: expect.stringContaining('compat-tool-ok') });
    expect(first.sessionId).not.toBeNull();
    expect(first.messages.some(message => message.parts.some(part => part.type === 'text' && part.text.includes('pong')))).toBe(true);
    expect(captured.some(body => body.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('compat-tool-ok')))).toBe(true);
    expect((await turn('Repeat pong')).sessionId).toBe(first.sessionId);
    await client.call('threads.update', { threadId: thread.id, permissionMode: 'plan' });
    expect((await turn('Reply pong without tools')).sessionId).toBe(first.sessionId);
    hold = true;
    const stopped = client.next('turn.finished', done => done.threadId === thread.id, 20_000);
    const before = captured.length;
    await client.call('turns.start', { threadId: thread.id, prompt: 'Wait' });
    await waitFor(() => captured.slice(before).some(body => (body.tools?.length ?? 0) > 0), 20_000);
    await client.call('turns.stop', { threadId: thread.id });
    expect(await stopped).toMatchObject({ status: 'stopped', error: null });
    hold = false;
    expect((await turn('Reply pong again')).sessionId).toBe(first.sessionId);
    expect(captured.every(body => body.model === route)).toBe(true);
    expect(legacyDb.query('SELECT value FROM v1_marker').get()).toEqual({ value: 'keep' });
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    legacyDb?.close();
    gateway.stop(true);
    await harness?.stop();
  }
}, 150_000);
