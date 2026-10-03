import { afterEach, expect, spyOn, test } from 'bun:test';
import { deriveThreadCapabilities, type Protocol, type ThreadCapabilitySnapshot } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { assertAllowed } from '../src/access.ts';
import type { Connection } from '../src/router.ts';
import { threadCapabilities } from '../src/threads/capabilities.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

function snapshot(protocol: Protocol | null): ThreadCapabilitySnapshot {
  return { threadId: 't', providerId: 'p', protocol, selectionVersion: 0,
    providerCapabilities: protocol === null ? null : { approvals: true, images: true, planMode: true, checkpoint: false, resume: true, hooks: false },
    runtimeReason: null, conversationReason: null, busy: false, steeringSupported: protocol !== 'agy' && protocol !== 'acp' && protocol !== null,
    steeringReason: 'not-running', compactionReason: 'no-session', preparationSupported: protocol === 'claude-sdk' || protocol === 'codex-appserver',
    pendingApprovals: false, pendingQuestions: false, hasForkHistory: true, hasRewindHistory: true,
    nativeForkSupported: protocol === 'claude-sdk', nativeForkAvailable: false, nativeRewindSupported: protocol === 'claude-sdk', nativeRewindAvailable: false,
    backgroundSupported: protocol === 'claude-sdk' };
}

test('capability mapping covers every protocol without inventing interactive agy compaction', () => {
  for (const protocol of ['echo', 'claude-sdk', 'codex-appserver', 'acp', 'pi', 'muse', 'agy', null] as const) {
    const result = deriveThreadCapabilities(snapshot(protocol));
    expect(result.protocol).toBe(protocol);
    expect(result.compaction.reason).toBe(protocol === 'agy' || protocol === null ? 'unsupported' : 'no-session');
    expect(result.steering.available).toBe(false);
    expect(result.sessionPreparation.supported).toBe(protocol === 'claude-sdk' || protocol === 'codex-appserver');
    expect(result.fork.native.available).toBe(false);
  }
});

test('runtime readiness separates support from available actions and gives stable reasons', () => {
  const base = snapshot('claude-sdk');
  expect(deriveThreadCapabilities({ ...base, busy: true }).plan.reason).toBe('busy');
  expect(deriveThreadCapabilities({ ...base, compactionReason: null }).compaction.available).toBe(true);
  expect(deriveThreadCapabilities({ ...base, steeringReason: 'selection-changed' }).steering.reason).toBe('selection-changed');
  expect(deriveThreadCapabilities({ ...base, runtimeReason: 'provider-unavailable' }).images).toEqual({ supported: true, available: false, reason: 'provider-unavailable' });
  expect(deriveThreadCapabilities({ ...base, conversationReason: 'archived' }).rewind.seeded.reason).toBe('archived');
  expect(deriveThreadCapabilities({ ...base, conversationReason: 'agent-session' }).fork.seeded.reason).toBe('agent-session');
  expect(deriveThreadCapabilities({ ...base, nativeForkAvailable: true }).fork.native.available).toBe(true);
  expect(deriveThreadCapabilities({ ...base, pendingApprovals: true }).approvals.available).toBe(true);
  expect(deriveThreadCapabilities({ ...base, pendingQuestions: true }).questions.available).toBe(true);
});

test('real capability RPC is read-only, reflects current selection and scopes agent access', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const spawn = spyOn(h.core.procs, 'spawn');
  try {
    const before = await owner.call('threads.capabilities', { threadId });
    expect(before).toMatchObject({ threadId, protocol: 'echo', steering: { supported: true, available: false, reason: 'not-running' }, compaction: { reason: 'no-session' } });
    expect(threadCapabilities(h.core, threadId)).toEqual(before);
    const agent = await connect(h.url, h.core.agents.tokenFor(threadId));
    const { grant } = await owner.call('pairing.grant', {});
    const paired = await connect(h.url, '', { grant });
    try {
      expect(await agent.call('threads.capabilities', { threadId })).toEqual(before);
      await expect(agent.call('threads.capabilities', { threadId: 'other' })).rejects.toThrow('not thread other');
      expect(await paired.call('threads.capabilities', { threadId })).toEqual(before);
    } finally { agent.close(); paired.close(); }

    const thread = h.core.threads.require(threadId);
    h.core.journal.putThread({ ...thread, providerId: 'removed-provider', selectionVersion: 2 });
    const changed = await owner.call('threads.capabilities', { threadId });
    expect(changed).toMatchObject({ protocol: null, selectionVersion: 2, images: { supported: false, available: false } });
    expect(spawn).not.toHaveBeenCalled();
    const connection = { identity: { principal: 'agent', sessionId: null, threadId } } as Connection;
    expect(() => assertAllowed('threads.capabilities', connection, { threadId })).not.toThrow();
    expect(() => assertAllowed('threads.capabilities', connection, { threadId: 'other' })).toThrow('not thread other');
    expect(() => assertAllowed('threads.capabilities', { identity: { principal: 'session', sessionId: 's', threadId: null } } as Connection, { threadId })).not.toThrow();
  } finally { spawn.mockRestore(); owner.close(); }
});

test('registered protocol metadata stays cold and live steering uses the action gate', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const provider = h.core.providers.require('echo');
  const get = spyOn(h.core.providers, 'get');
  const spawn = spyOn(h.core.procs, 'spawn');
  const child = spyOn(h.core.procs, 'spawnChild');
  const piped = spyOn(h.core.procs, 'spawnPiped');
  try {
    for (const protocol of ['echo', 'claude-sdk', 'codex-appserver', 'acp', 'pi', 'muse', 'agy'] as const) {
      get.mockImplementation(() => ({ ...provider, protocol }));
      const result = threadCapabilities(h.core, threadId);
      expect(result.protocol).toBe(protocol);
      expect(result.sessionPreparation.supported).toBe(protocol === 'claude-sdk' || protocol === 'codex-appserver');
      expect(result.steering.supported).toBe(protocol !== 'acp' && protocol !== 'agy');
      expect(result.steering.available).toBe(false);
    }
    get.mockRestore();
    const original = h.core.threads.require(threadId);
    h.core.journal.putThread({ ...original, status: 'running' });
    const turn = { id: 'trn_capability', threadId, status: 'running' as const, queuedAt: 1, startedAt: 1, finishedAt: null, usage: null, error: null };
    h.core.journal.putTurn(turn);
    h.core.threads.runner.handles.set(threadId, { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop: () => undefined, steer: async () => true });
    expect(threadCapabilities(h.core, threadId).steering.available).toBe(true);
    h.core.journal.putThread({ ...original, status: 'running', selectionVersion: 1 });
    expect(threadCapabilities(h.core, threadId).steering.reason).toBe('selection-changed');
    h.core.threads.runner.handles.delete(threadId);
    h.core.journal.putThread(original);
    h.core.journal.putTurn({ ...turn, status: 'done', finishedAt: 2 });
    expect(spawn).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    expect(piped).not.toHaveBeenCalled();
  } finally { get.mockRestore(); spawn.mockRestore(); child.mockRestore(); piped.mockRestore(); owner.close(); }
});

test('real and fake capability RPCs agree on echo facts and idle steering for every protocol', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const real = await owner.call('threads.capabilities', { threadId });
  const { capabilityMethods } = await import(new URL('../../ui/src/lib/fake-client/capabilities.ts', import.meta.url).href);
  const full = h.core.threads.get(threadId);
  const ctx = { thread: () => full, providers: h.core.providers.list().loaded, accounts: h.core.accounts.list(),
    inFlight: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map() };
  expect(await capabilityMethods(ctx)['threads.capabilities']({ threadId })).toEqual(real);
  const provider = h.core.providers.require('echo');
  const get = spyOn(h.core.providers, 'get');
  try {
    for (const protocol of ['echo', 'claude-sdk', 'codex-appserver', 'acp', 'pi', 'muse', 'agy'] as const) {
      get.mockImplementation(() => ({ ...provider, protocol }));
      const fake = await capabilityMethods({ ...ctx, providers: ctx.providers.map(item => ({ ...item, protocol })) })['threads.capabilities']({ threadId });
      expect(fake.steering).toEqual(threadCapabilities(h.core, threadId).steering);
    }
  } finally { get.mockRestore(); }
  owner.close();
});
