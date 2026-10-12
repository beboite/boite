import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import AgentMessagesSurface from './AgentMessagesSurface.svelte';
import { RightPanelStore } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; });

test('the tab lists one discussion per conversation, opens its back and forth live, reaches the remote thread and goes back', async () => {
  const self = { coreId: 'local-core', threadId: 'same-thread-id' };
  // Thread ids collide between machines: the remote one shares this thread's id.
  const remote = { coreId: 'remote-core', threadId: 'same-thread-id' };
  const started = { coreId: 'local-core', threadId: 't-notes' };
  const letters: AgentLetter[] = [
    { id: 'in', from: { ...remote, title: 'Remote deployment', project: 'Release tools', machine: 'Build PC', resources: '', status: 'idle', mode: 'brief' },
      to: self, toTitle: 'Current agent', text: 'Please wait.', createdAt: 10, expiresAt: 1000, replyTo: null, status: 'delivered', error: null, relation: 'machine' },
    { id: 'out', from: { ...self, title: 'Current agent', machine: 'This PC', resources: '', status: 'idle', mode: 'brief' },
      to: remote, toTitle: 'Remote deployment', toProject: 'Release tools', toMachine: 'Build PC', text: 'Restart postponed.', createdAt: 20, expiresAt: 1000, replyTo: 'in', status: 'rejected', error: 'The recipient revoked coordination.', relation: 'machine' },
    { id: 'notes', from: { ...started, title: 'Release notes', project: 'Notes', machine: 'This PC', resources: 'Owns the 2.4 notes', status: 'running', mode: 'brief', agent: 'codex gpt-6' },
      to: self, toTitle: 'Current agent', text: 'Draft ready.', createdAt: 30, expiresAt: 1000, replyTo: null, status: 'delivered', error: null, relation: 'started' }
  ];
  const store = new Store();
  store.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false }, messages: letters, sent: 1, sendLimit: null, wakes: 0, wakeLimit: null };
  const panel = new RightPanelStore().for('messages-test');
  panel.openMessages();
  const context = {
    get coordination() { return store.coordination; }, delegation: null, threads: [], projects: [],
    openThread: { id: self.threadId }, loadCoordination: vi.fn()
  } as unknown as Store;
  component = mount(AgentMessagesSurface, { target: document.body, props: { store: context, panel, get surface() { return panel.active!; } } });
  flushSync();

  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid=agent-discussion]')];
  // The most recent discussion first; the thread this one started carries its tag, the remote one its project and machine.
  expect(rows().map(row => row.dataset.peer)).toEqual(['here/t-notes', 'remote-core/same-thread-id']);
  expect(rows()[0]!.querySelector('.tag')?.textContent).toBe('Started from here');
  expect(rows()[0]!.textContent).toContain('Draft ready.');
  expect(rows()[1]!.querySelector('.where')?.textContent).toBe('Release tools · Build PC');
  // Another machine is said by its place, not by a tag.
  expect(rows()[1]!.querySelector('.tag')).toBeNull();
  expect(rows()[1]!.querySelector('.count')?.textContent).toBe('2');
  expect(document.querySelector('[data-testid=agent-discussion-view]')).toBeNull();

  rows()[1]!.click();
  flushSync();
  await tick();
  expect(panel.active).toMatchObject({ peer: 'remote-core/same-thread-id' });
  const view = document.querySelector<HTMLElement>('[data-testid=agent-discussion-view]')!;
  // Focus follows into the discussion, where a narrow panel shows it alone.
  expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-discussion-heading');
  expect(view.querySelector('[data-testid=agent-discussion-heading]')?.textContent).toBe('Remote deployment');
  expect([...view.querySelectorAll<HTMLElement>('[data-testid=agent-discussion-message]')].map(node => [node.dataset.letterId, node.classList.contains('right')]))
    .toEqual([['in', true], ['out', false]]);
  expect(view.textContent).not.toContain('Draft ready.');
  const open = vi.spyOn(workspace, 'openAgentThread').mockResolvedValue();
  try {
    view.querySelector<HTMLButtonElement>('[data-testid=agent-letter-open]')!.click();
    expect(open).toHaveBeenCalledWith(context, self, expect.objectContaining(remote));
  } finally { open.mockRestore(); }

  store.coordination!.messages.push({ ...letters[0]!, id: 'live', text: 'Clear now.', createdAt: 40 });
  flushSync();
  expect(view.querySelector('[data-letter-id="live"]')?.textContent).toContain('Clear now.');
  expect(rows()[0]!.dataset.peer).toBe('remote-core/same-thread-id');

  document.querySelector<HTMLButtonElement>('[data-testid=agent-discussion-back]')!.click();
  flushSync();
  await tick();
  expect(panel.active).toMatchObject({ peer: undefined });
  expect(document.querySelector('[data-testid=agent-discussion-view]')).toBeNull();
  // Back lands on the row it came from.
  expect((document.activeElement as HTMLElement | null)?.dataset.peer).toBe('remote-core/same-thread-id');
  // A wide panel has no back arrow: a second click on the open row closes it.
  rows()[0]!.click();
  flushSync();
  expect(panel.active).toMatchObject({ peer: 'remote-core/same-thread-id' });
  rows()[0]!.click();
  flushSync();
  expect(panel.active).toMatchObject({ peer: undefined });
});
