import { expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import WorkflowRunPane from './WorkflowRunPane.svelte';

test('the graph shows effort and cumulative tokens for each step and the run, including zero', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  const [run] = await client.call('workflows.list', { threadId: 't-trace' });
  const review = run!.nodes.find(node => node.id === 'review')!;
  Object.assign(review.instances[0]!, { effort: 'high', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 30, costUsdEquivalent: null } });
  Object.assign(review.instances[1]!, { effort: 'high', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null } });
  run!.usage = { inputTokens: 110, outputTokens: 25, cacheReadTokens: 200, cacheWriteTokens: 30, costUsdEquivalent: null };
  const target = document.createElement('div'); document.body.append(target);
  let component = mount(WorkflowRunPane, { target, props: { store, run: run!, onback() {} } });
  try {
    flushSync();
    expect(target.querySelector('[data-node-id="review"] [data-testid="workflow-effort"]')?.textContent).toBe('High');
    expect(target.querySelector('[data-node-id="review"] [data-testid="workflow-node-tokens"]')?.textContent).toBe('365 tokens');
    expect(target.querySelector('[data-testid="workflow-meta"]')?.textContent).toContain('365 tokens');
    await unmount(component);
    const empty = structuredClone(run!); empty.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null };
    component = mount(WorkflowRunPane, { target, props: { store, run: empty, onback() {} } });
    flushSync();
    expect(target.querySelector('[data-testid="workflow-meta"]')?.textContent).toContain('0 tokens');
  } finally {
    await unmount(component); target.remove(); store.detach(); client.close();
  }

});
