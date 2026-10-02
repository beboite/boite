import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import AgentMessagesSurface from './AgentMessagesSurface.svelte';
import { RightPanelStore } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; });

test('the messages tab filters live mail, retains failures and opens the owning remote conversation', () => {
  const self = { coreId: 'local-core', threadId: 'same-thread-id' };
  const peer = { coreId: 'remote-core', threadId: 'same-thread-id' };
  const letters: AgentLetter[] = [
    { id: 'in', from: { ...peer, title: 'Remote deployment', project: 'Release tools', machine: 'Build PC', resources: '', status: 'idle', mode: 'brief' },
      to: self, toTitle: 'Current agent', text: 'Please wait.', createdAt: 10, expiresAt: 1000, replyTo: null, status: 'delivered', error: null },
    { id: 'out', from: { ...self, title: 'Current agent', machine: 'This PC', resources: '', status: 'idle', mode: 'brief' },
      to: peer, toTitle: 'Remote deployment', toProject: 'Release tools', text: 'Restart postponed.', createdAt: 20, expiresAt: 1000, replyTo: 'in', status: 'rejected', error: 'The recipient revoked coordination.' }
  ];
  const store = new Store();
  store.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false }, messages: letters, sent: 1, sendLimit: null, wakes: 0, wakeLimit: null };
  const panel = new RightPanelStore().for('messages-test');
  panel.openMessages('in', 'incoming');
  const context = {
    get coordination() { return store.coordination; }, delegation: null, threads: [], projects: [],
    openThread: { id: self.threadId }, loadCoordination: vi.fn()
  } as unknown as Store;
  component = mount(AgentMessagesSurface, { target: document.body, props: { store: context, panel, get surface() { return panel.active!; } } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=forwarded-agent-message]')).toHaveLength(1);
  expect(document.body.textContent).toContain('Please wait.');
  expect(document.body.textContent).not.toContain('Restart postponed.');
  expect(document.querySelector('[data-testid=agent-letter-project]')?.textContent).toBe('Release tools');
  const open = vi.spyOn(workspace, 'openAgentThread').mockResolvedValue();
  try {
    document.querySelector<HTMLButtonElement>('[data-testid=agent-letter-open]')!.click();
    expect(open).toHaveBeenCalledWith(context, self, expect.objectContaining(peer));
  } finally { open.mockRestore(); }
  document.querySelector<HTMLButtonElement>('[data-testid=agent-messages-filter][data-direction=outgoing]')!.click();
  flushSync();
  expect(document.querySelector('[data-testid=agent-messages-filter][data-direction=outgoing]')?.getAttribute('aria-pressed')).toBe('true');
  expect(document.body.textContent).toContain('Restart postponed.');
  expect(document.body.textContent).not.toContain('Please wait.');
  document.querySelector<HTMLElement>('[data-testid=agent-letter-status]')!.click();
  expect(document.querySelector('details')?.open).toBe(true);
  expect(document.body.textContent).toContain('The recipient revoked coordination.');
  store.coordination!.messages.push({ ...letters[1]!, id: 'new', text: 'New live message', createdAt: 30, status: 'delivered', error: null });
  flushSync();
  expect(document.querySelectorAll('[data-testid=forwarded-agent-message]')).toHaveLength(2);
  expect(document.body.textContent).toContain('New live message');
  document.querySelector<HTMLButtonElement>('[data-testid=agent-messages-filter][data-direction=all]')!.click();
  flushSync();
  expect(document.querySelectorAll('[data-testid=forwarded-agent-message]')).toHaveLength(3);
  expect([...document.querySelectorAll('[data-letter-id]')].map(node => node.getAttribute('data-letter-id'))).toEqual(['in', 'out', 'new']);
});
