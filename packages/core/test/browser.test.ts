import { afterEach, beforeEach, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
beforeEach(async () => {
  harness = await startTestCore(); owner = await harness.connect();
  ({ threadId } = await echoThread(harness, owner));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
});
afterEach(async () => { agent?.close(); owner?.close(); await harness?.stop(); });

test('an agent controls only its conversation; only the registered owner socket can answer', async () => {
  await expect(agent.call('browser.command', { threadId, action: { kind: 'snapshot' } })).rejects.toThrow('desktop app');
  await owner.call('threads.subscribe', { threadId });
  await expect(owner.call('browser.host', { threadId, enabled: true })).rejects.toThrow('explicit consent');
  await expect(owner.call('browser.host', { threadId, enabled: true, allowAgentControl: false })).rejects.toThrow('explicit consent');
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  await expect(agent.call('browser.host', { threadId, enabled: true })).rejects.toThrow("agent's methods");
  await expect(agent.call('browser.command', { threadId: 'another-thread', action: { kind: 'snapshot' } })).rejects.toThrow('not thread');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'file:///secret' } })).rejects.toThrow('HTTP');
  const requested = owner.next('browser.requested', () => true);
  const reply = agent.call('browser.command', { threadId, action: { kind: 'snapshot' } });
  const request = await requested;
  const stranger = await harness.connect();
  try {
    await expect(stranger.call('browser.complete', { requestId: request.requestId, result: { value: 'spoof' } })).rejects.toThrow('does not belong');
    await expect(agent.call('browser.complete', { requestId: request.requestId, result: { value: 'spoof' } })).rejects.toThrow("agent's methods");
    await owner.call('browser.complete', { requestId: request.requestId, result: { tabId: 'browser:test', value: { text: 'Rendered page' } } });
    expect(await reply).toEqual({ tabId: 'browser:test', value: { text: 'Rendered page' } });
    await expect(owner.call('browser.complete', { requestId: request.requestId, result: {} })).rejects.toThrow('does not belong');
  } finally { stranger.close(); }
});

test('leaving or losing the host settles in-flight work and requires a fresh registration', async () => {
  await owner.call('threads.subscribe', { threadId });
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  const requested = owner.next('browser.requested', () => true);
  const reply = agent.call('browser.command', { threadId, action: { kind: 'screenshot' } });
  const rejected = reply.catch(error => error as Error);
  const request = await requested;
  await owner.call('browser.host', { threadId, enabled: false });
  expect((await rejected as Error).message).toContain('host left');
  await expect(owner.call('browser.complete', { requestId: request.requestId, result: {} })).rejects.toThrow('does not belong');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'evaluate', expression: 'document.cookie' } })).rejects.toThrow('enable Agent browser control');
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  const again = owner.next('browser.requested', () => true);
  const lost = agent.call('browser.command', { threadId, action: { kind: 'snapshot' } }).catch(error => error as Error);
  await again; owner.close(); expect((await lost as Error).message).toContain('host left');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'status' } })).rejects.toThrow('desktop app');
});
