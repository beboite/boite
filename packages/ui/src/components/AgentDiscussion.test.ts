import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import AgentDiscussion from './AgentDiscussion.svelte';
import { agentMailFor, discussionsOf } from '../lib/agent-mail';
import type { Store } from '../lib/store.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; });

const self = { coreId: 'core-local', threadId: 't-current' };
const peer = { coreId: 'core-build', threadId: 't-deploy' };
const MIN = 60_000;
const contact = { ...peer, title: 'Deployment agent', project: 'Release tools', machine: 'Build PC', resources: 'Owns restarts', status: 'running' as const, mode: 'brief' as const, agent: 'claude claude-opus-5-5' };
const mine = { ...self, title: 'Current agent', machine: 'This PC', resources: '', status: 'idle' as const, mode: 'brief' as const };
function letter(id: string, minute: number, incoming: boolean, extra: Partial<AgentLetter> = {}): AgentLetter {
  return { id, from: incoming ? contact : mine, to: incoming ? self : peer, toTitle: incoming ? 'Current agent' : 'Deployment agent',
    text: `Text ${id}`, replyTo: null, createdAt: minute * MIN, expiresAt: Number.MAX_SAFE_INTEGER, status: 'delivered', error: null, ...extra };
}
function show(letters: AgentLetter[]): HTMLElement {
  const store = { coordination: { self, config: { mode: 'brief', resources: '', remote: true, paused: false }, messages: letters, sent: 0, sendLimit: null, wakes: 0, wakeLimit: null },
    delegation: null, threads: [], projects: [] } as unknown as Store;
  const [discussion] = discussionsOf(agentMailFor(store, self.threadId), store);
  component = mount(AgentDiscussion, { target: document.body, props: { store, discussion: discussion!, onback: () => {} } });
  flushSync();
  return document.querySelector<HTMLElement>('[data-testid=agent-discussion-view]')!;
}
const message = (view: HTMLElement, id: string) => view.querySelector<HTMLElement>(`[data-letter-id="${id}"]`)!;

test('the back and forth groups each side, stamps long silences, quotes an earlier message and shows delivery', () => {
  const view = show([
    letter('ask', 0, true),
    letter('ask-more', 1, true),
    letter('answer', 2, false, { replyTo: 'ask', status: 'received' }),
    letter('later', 40, false, { status: 'rejected', error: 'The recipient revoked coordination.' }),
    letter('again', 41, true, { replyTo: 'answer' })
  ]);
  expect(view.querySelector('[data-testid=agent-discussion-heading]')?.textContent).toBe('Deployment agent');
  expect(view.querySelector('[data-testid=agent-discussion-where]')?.textContent).toBe('Release tools · Build PC');
  expect(view.querySelector('.model')?.textContent).toBe('claude-opus-5-5');
  expect(view.querySelector('.about')?.textContent).toContain('Owns restarts');
  // The letters say "running": that was when the remote agent wrote, not now. No live state, no dot.
  expect(view.querySelector('header [data-status]')).toBeNull();
  // What reaches this agent sits on the user's side, its own words on the agent's.
  expect(['ask', 'ask-more', 'answer', 'later', 'again'].map(id => message(view, id).classList.contains('right'))).toEqual([true, true, false, false, true]);
  // Two letters of one side a minute apart share one time stamp; forty minutes of silence get a line.
  expect(message(view, 'ask').classList.contains('first')).toBe(true);
  expect(message(view, 'ask-more').classList.contains('first')).toBe(false);
  expect(message(view, 'ask').querySelector('[data-testid=agent-letter-age]')).toBeNull();
  expect(message(view, 'ask-more').querySelector('[data-testid=agent-letter-age]')).not.toBeNull();
  expect(view.querySelectorAll('.stretch')).toHaveLength(2);
  // A reply to the message just before it needs no quote; one to an earlier message shows it.
  expect(message(view, 'answer').querySelector('[data-testid=agent-discussion-quote]')?.textContent).toContain('Text ask');
  expect(message(view, 'again').querySelector('[data-testid=agent-discussion-quote]')?.textContent).toContain('Text answer');
  const acknowledged = message(view, 'answer').querySelector('[data-testid=agent-letter-status]')!;
  expect(acknowledged.querySelector('svg.lucide-check-check')).not.toBeNull();
  expect(acknowledged.getAttribute('aria-label')).toBe('Received by the recipient core');
  // A failure keeps its reason behind a tap, for a phone without hover.
  const failed = message(view, 'later').querySelector<HTMLElement>('[data-testid=agent-letter-status]')!;
  expect(failed.textContent).toBe('Failed');
  expect(failed.closest('details')?.open).toBe(false);
  failed.click();
  expect(failed.closest('details')?.open).toBe(true);
  expect(failed.closest('details')?.textContent).toContain('The recipient revoked coordination.');
  expect(view.querySelector('.tally')?.textContent).toBe('2 sent, 3 received');
});

test('a steward letter reads as the steward\'s, never on the user\'s side, and a notice is a quiet line', () => {
  const view = show([
    letter('steer', 0, true, { origin: 'steward', text: 'Open the pull request.' }),
    letter('notice', 1, true, { origin: 'notice', text: 'Turn done in "Deployment agent".' })
  ]);
  const steer = message(view, 'steer');
  expect(steer.classList.contains('steward')).toBe(true);
  expect(steer.classList.contains('right')).toBe(false);
  expect(steer.querySelector('.label')?.textContent).toBe('Steward');
  expect(view.querySelector('header .tag')?.getAttribute('data-relation')).toBe('steward');
  expect(view.querySelector('header svg.lucide-user-cog')).not.toBeNull();
  const notice = message(view, 'notice');
  expect(notice.getAttribute('data-testid')).toBe('agent-notice');
  expect(notice.textContent).toBe('Turn done in "Deployment agent".');
  expect(notice.querySelector('[data-testid=agent-letter-status]')).toBeNull();
});
