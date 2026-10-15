import { afterEach, expect } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ContextControl from './ContextControl.svelte';
import { fill, strings } from '../lib/strings';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function openPopup() { q('context-trigger')!.click(); flushSync(); }

test('a Claude thread opens what its last request carried from the context meter, an echo thread has no entry', async ({ ready }) => {
  const { store, client } = await ready();
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-opus-5-5' });
  await store.open(thread.id);
  const composer = document.createElement('textarea');
  composer.dataset['testid'] = 'composer-input';
  document.body.append(composer);
  view = mount(ContextControl, { target: document.body, props: { store } });
  flushSync(); openPopup();

  q('context-agent-shape')!.click(); flushSync();
  expect(q('context-popup')?.classList.contains('closing') ?? true).toBe(true);
  await expect.poll(() => q('agent-shape-empty')?.dataset['status']).toBe('no-session');
  expect(q('agent-shape-empty')!.textContent).toBe(strings.agentShape.noSession);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await expect.poll(() => q('agent-shape')).toBeNull();
  // The button that opened it went with the popup: the keyboard lands on the composer, not the page.
  expect(document.activeElement).toBe(composer);

  await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
  await expect.poll(async () => (await client.call('threads.get', { threadId: thread.id })).status).toBe('idle');
  openPopup();
  q('context-agent-shape')!.click(); flushSync();
  await expect.poll(() => q('agent-shape-summary')).not.toBeNull();
  const shape = await client.call('threads.agentShape', { threadId: thread.id });
  const tools = [...document.querySelectorAll('[data-testid="agent-shape-tool"] .name')].map(node => node.textContent);
  expect(tools).toEqual(shape.tools.map(tool => tool.name));
  expect(shape.tools.map(tool => tool.chars)).toEqual([...shape.tools.map(tool => tool.chars)].sort((a, b) => b - a));
  expect(document.body.textContent).toContain(fill(strings.agentShape.estimate, { tokens: shape.estimatedTokens.toLocaleString('en') }));
  const blocks = document.querySelectorAll<HTMLDetailsElement>('[data-testid="agent-shape-block"]');
  expect(blocks).toHaveLength(shape.system.length);
  const cut = blocks[shape.system.findIndex(block => block.truncated)]!;
  cut.open = true; flushSync();
  expect(cut.textContent).toContain(fill(strings.agentShape.truncated, { chars: shape.system.find(block => block.truncated)!.chars.toLocaleString('en') }));
  expect(q('agent-shape-params')!.textContent).toContain('claude-opus-5-5');
  q('agent-shape-close')!.click();
  await expect.poll(() => q('agent-shape')).toBeNull();

  await store.open('t-trace'); flushSync();
  openPopup();
  expect(q('context-agent-shape')).toBeNull();
  await expect(client.call('threads.agentShape', { threadId: 't-trace' })).rejects.toMatchObject({ data: { field: 'providerId' } });
});
