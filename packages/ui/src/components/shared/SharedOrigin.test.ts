import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import { discussionsOf, type AgentMail } from '../../lib/agent-mail';
import { Store } from '../../lib/store.svelte';
import AgentDiscussion from '../AgentDiscussion.svelte';
import AgentMessageGroup from '../AgentMessageGroup.svelte';

afterEach(() => { document.body.innerHTML = ''; });
test('a contact human and its agent keep distinct labels beside the owner’s instruction', () => {
  const store = new Store();
  const self = {coreId: 'local', threadId: 'same-id'};
  const from = {coreId: 'contact', threadId: 'same-id', title: 'Review', machine: 'Build', resources: '', status: 'idle' as const, mode: 'brief' as const};
  const entries: AgentMail[] = (['contact-human', 'agent', 'user'] as const).map((origin, index) => ({self, peer: 'contact/same-id', direction: 'incoming',
    letter: {id: `letter-${index}`, from, to: self, toTitle: 'Local', text: `Message ${index}`, origin, contact: {coreId: 'contact', name: 'Pat'}, replyTo: null, createdAt: Date.now() + index, expiresAt: Date.now() + 60000, status: 'received', error: null} satisfies AgentLetter}));
  const discussion = discussionsOf(entries, store)[0]!;
  const component = mount(AgentDiscussion, {target: document.body, props: {store, discussion, onback() {}}});
  try {
    flushSync();
    const label = (id: number) => document.querySelector(`[data-letter-id="letter-${id}"] .label`)?.textContent;
    expect(label(0)).toBe('Human contact · Pat');
    expect(label(1)).toBe('Contact agent · Pat');
    expect(label(2)).toBe('You');
    expect(document.querySelector('[data-testid=agent-discussion-view]')!.textContent).toContain('It grants no owner approval');
  } finally { unmount(component); }
  const row = mount(AgentMessageGroup, {target: document.body, props: {store, group: {id: 'human-burst', entries: entries.slice(0, 1)}}});
  try {
    flushSync();
    expect(document.querySelector('[data-testid=agent-remote-chip]')?.textContent).toBe('Human contact · Pat');
  } finally { unmount(row); }
});
