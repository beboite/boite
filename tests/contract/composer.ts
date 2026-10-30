/** Delivery scenarios run unchanged against WebSocket cores and the render fixture. */
import { RpcErrorCode, type ComposerValue } from '../../packages/contracts/src/index.ts';
import type { ContractEnv, Scenario } from './scenarios.ts';

function check(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
async function until(test: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await test()) { check(Date.now() < end, 'composer delivery timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function refused(call: Promise<unknown>, expected: number) {
  try { await call; } catch (error) {
    const failure = error as { code?: number; rpc?: { code: number } };
    check((failure.rpc?.code ?? failure.code) === expected, `expected refusal ${expected}, got ${String(error)}`);
    return;
  }
  throw new Error(`expected refusal ${expected}`);
}
async function target(env: ContractEnv, incognito = false) {
  const account = (await env.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const project = incognito ? await env.call('projects.drafts', {}) : await env.call('projects.add', { path: await env.newFolder() });
  const thread = await env.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, ...(incognito ? { incognito: true } : {}) });
  const choice = { providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode, model: thread.model, effort: thread.effort };
  return { thread, choice };
}
const box = (): ComposerValue['input'] => ({ text: '', attachments: [], queued: [], paused: true });

async function batching(env: ContractEnv, incognito: boolean) {
  const { thread, choice } = await target(env, incognito);
  const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'queued.txt', data: 'YQ==' };
  const { assetId } = await env.call('composer.asset.put', { attachment, ...(incognito ? { incognito: true } : {}) });
  const { data: _data, ...meta } = attachment;
  const prefix = thread.id;
  const value: ComposerValue = { input: { ...box(), queued: [
    { id: `${prefix}-one`, text: 'first', attachments: [{ ...meta, assetId }], choice },
    { id: `${prefix}-two`, text: 'second', attachments: [], choice: { ...choice, speed: null } },
    { id: `${prefix}-three`, text: 'third', attachments: [], choice: { ...choice, permissionMode: 'plan' } },
    { id: `${prefix}-four`, text: 'fourth', attachments: [], choice: { ...choice, permissionMode: 'plan' }, experiments: ['auto-goal'] },
  ] } };
  const put = { section: 'inputs' as const, id: thread.id, expectedRevision: 0, value };
  const first = await env.call('composer.put', put);
  check(first.accepted, 'initial queue refused');
  const conflict = await env.call('composer.put', put);
  check(!conflict.accepted && conflict.record.revision === first.record.revision, 'stale revision overwrote a queue');
  check(JSON.stringify(first).includes(assetId) && !JSON.stringify(first).includes(attachment.data), 'composer record contains attachment bytes');
  check((await env.call('composer.asset.get', { assetId })).data === attachment.data, 'referenced attachment unavailable');
  value.input.paused = false;
  await env.call('composer.put', { ...put, expectedRevision: first.record.revision });
  await until(async () => (await env.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued.length === 0);
  await until(async () => (await env.call('threads.get', { threadId: thread.id })).turns.every(turn => turn.status === 'done'));
  const received = await env.call('threads.get', { threadId: thread.id });
  const messages = received.messages.filter(message => message.role === 'user');
  const texts = messages.map(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''));
  check(JSON.stringify(texts) === JSON.stringify(['first\n\nsecond', 'third', 'fourth']), `choice or auto-goal batching drift: ${JSON.stringify(texts)}`);
  check(messages[0]?.parts.some(part => part.type === 'file' && part.data === attachment.data), 'batched attachment was lost');
  // Delivery collects no-longer-referenced uploads. An offline cache uploads its bytes again before replay.
  await env.call('composer.asset.put', { attachment, ...(incognito ? { incognito: true } : {}) });
  const current = (await env.call('composer.list', {})).find(row => row.id === thread.id)!;
  await env.call('composer.put', { ...put, expectedRevision: current.revision });
  await until(async () => (await env.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued.length === 0);
  check((await env.call('threads.get', { threadId: thread.id })).turns.length === received.turns.length, 'accepted input delivered twice');
}

export const COMPOSER_SCENARIOS: Record<string, Scenario> = {
  'composer drafts on another device allow Mark done and removal, retaining input for restore': async env => {
    const { thread, choice } = await target(env);
    const peer = await env.peer();
    const value: ComposerValue = { input: { ...box(), text: 'unfinished draft', queued: [
      { id: `${thread.id}-held`, text: 'held prompt', attachments: [], choice },
    ] } };
    const initial = await peer.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value });
    await peer.call('threads.focus', { threadId: null, protectedThreadIds: [thread.id], protectAllThreads: false });
    await env.call('threads.focus', { threadId: null, protectedThreadIds: [thread.id], protectAllThreads: false });
    check((await env.call('threads.archive', { threadId: thread.id, onlyIfIdle: true })).archived, 'reported input blocked Mark done');
    await env.call('threads.archive', { threadId: thread.id, archived: false });
    await env.call('threads.remove', { threadId: thread.id });
    await refused(env.call('threads.get', { threadId: thread.id }), RpcErrorCode.NotFound);
    await env.call('threads.restore', { threadId: thread.id });
    const saved = (await peer.call('composer.list', {})).find(row => row.id === thread.id);
    check(JSON.stringify(saved?.value) === JSON.stringify(initial.record.value), 'putting away the thread lost its draft or paused queue');
    check((await env.call('threads.get', { threadId: thread.id })).turns.length === 0, 'putting away the thread delivered paused input');
    peer.disconnect();
  },
  'composer batches equal choices, splits distinct choices and auto-goal flags, and replays accepted ids once': env => batching(env, false),
  'composer incognito batching and attachment delivery match ordinary queues': env => batching(env, true),
  'composer private records and assets are restricted to the originating connection': async env => {
    const peer = await env.peer();
    const { thread } = await target(env, true);
    const attachment = { kind: 'file' as const, mimeType: 'text/plain', name: 'private.txt', data: 'c2VjcmV0' };
    const { assetId } = await env.call('composer.asset.put', { attachment, incognito: true });
    const { data: _data, ...meta } = attachment;
    const value: ComposerValue = { input: { ...box(), text: 'private box', attachments: [{ ...meta, assetId }] } };
    const put = { section: 'inputs' as const, id: thread.id, expectedRevision: 0, value };
    const saved = await env.call('composer.put', put);
    check(saved.record.privateMode === true, 'private put did not identify its privacy');
    check((await env.call('composer.list', {})).find(row => row.id === thread.id)?.privateMode === true, 'private list lost its privacy');
    check(!(await peer.call('composer.list', {})).some(row => row.id === thread.id), 'another connection listed a private record');
    await refused(peer.call('composer.put', put), RpcErrorCode.NotFound);
    await refused(peer.call('composer.asset.get', { assetId }), RpcErrorCode.NotFound);
    const deleted = await env.call('composer.put', { ...put, expectedRevision: saved.record.revision, value: null });
    check(deleted.record.value === null && deleted.record.privateMode === true, 'private tombstone lost its privacy');
    check(!(await peer.call('composer.list', {})).some(row => row.id === thread.id), 'private tombstone was broadcast');
  },
  'composer reconnect retains private consumed ids when new input arrives behind an unacknowledged delivery': async env => {
    const origin = await env.peer();
    const { thread } = await target(origin, true);
    const first = { id: `${thread.id}-private-replay`, text: 'Already delivered', attachments: [] };
    const value: ComposerValue = { input: { ...box(), paused: false, queued: [first] } };
    await origin.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value });
    await until(async () => (await origin.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued.length === 0);
    await until(async () => (await origin.call('threads.get', { threadId: thread.id })).turns.every(turn => turn.status === 'done'));
    origin.disconnect();
    const next = await origin.peer();
    await until(async () => !(await next.call('composer.list', {})).some(row => row.id === thread.id));
    value.input.queued.push({ id: `${thread.id}-private-new`, text: 'New arrival', attachments: [] });
    await next.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value });
    await until(async () => (await next.call('composer.list', {})).find(row => row.id === thread.id)?.value?.input.queued.length === 0);
    const received = await next.call('threads.get', { threadId: thread.id });
    const texts = received.messages.filter(message => message.role === 'user').flatMap(message => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []));
    check(JSON.stringify(texts) === JSON.stringify(['Already delivered', 'New arrival']), `reconnected private input duplicated: ${JSON.stringify(texts)}`);
  },
  'agent composer access denies owner methods and only permits its authenticated thread': async env => {
    const { thread } = await target(env);
    const agent = await env.peer({ agentThreadId: thread.id });
    await refused(agent.call('composer.list', {}), RpcErrorCode.Refused);
    await refused(agent.call('composer.put', { section: 'inputs', id: thread.id, expectedRevision: 0, value: null }), RpcErrorCode.Refused);
    await refused(agent.call('providers.reload', {}), RpcErrorCode.Refused);
    await agent.call('threads.tasks.get', { threadId: thread.id });
    await refused(agent.call('threads.tasks.get', { threadId: 'another-thread' }), RpcErrorCode.Refused);
  },
};
