import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import { setLocaleSetting } from '../lib/i18n.svelte';
import ForwardedAgentMessage from './ForwardedAgentMessage.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
  await setLocaleSetting('en');
});

test('a failed delivery keeps its reason behind a touch-friendly status disclosure', async () => {
  const letter: AgentLetter = {
    id: 'letter-failed',
    from: { coreId: 'remote', threadId: 'deploy', title: 'Deployment agent', machine: 'Build PC', resources: '', status: 'idle', mode: 'team' },
    to: { coreId: 'local', threadId: 'current' },
    toTitle: 'Current agent',
    text: 'Wait before restart.',
    replyTo: null,
    createdAt: 20,
    expiresAt: 1000,
    status: 'rejected',
    error: 'The recipient revoked coordination.',
  };
  component = mount(ForwardedAgentMessage, {
    target: document.body,
    props: { letter, self: { coreId: 'local', threadId: 'current' } },
  });
  flushSync();

  const summary = document.querySelector<HTMLElement>('[data-testid="agent-letter-status"]')!;
  const details = summary.closest('details');
  expect(summary.textContent).toBe('Failed');
  expect(details?.open).toBe(false);
  summary.click();
  expect(details?.open).toBe(true);
  expect(details?.textContent).toContain('The recipient revoked coordination.');
});

const received: AgentLetter = {
  id: 'letter-delivered',
  from: { coreId: 'source', threadId: 'sender', title: 'Deployment agent', project: 'Release tools', machine: 'Build PC', resources: '', status: 'idle', mode: 'team' },
  to: { coreId: 'destination', threadId: 'recipient' }, toTitle: 'Maintenance agent', toProject: 'Infrastructure', toMachine: 'Server',
  text: 'Please wait before restarting.', replyTo: null, createdAt: 20, expiresAt: 1000, status: 'delivered', error: null,
};

test('mail shows its age and exact timestamp, updates the age and follows the app language', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  const letter = { ...received, createdAt: Date.now() - 120_000 };
  component = mount(ForwardedAgentMessage, { target: document.body, props: { letter, self: received.to } });
  flushSync();
  const time = document.querySelector<HTMLTimeElement>('[data-testid="agent-letter-age"]');
  expect(time).not.toBeNull();
  expect(time!.dateTime).toBe('2026-10-02T11:58:00.000Z');
  // The title is in the machine's time zone and clock, whatever it is.
  const at = new Date(letter.createdAt);
  expect(time!.title).toMatch(new RegExp(`\\b(${at.getHours()}|${at.getHours() % 12 || 12}):58\\b`));
  expect(time!.textContent).toBe('2 min. ago');

  await vi.advanceTimersByTimeAsync(60_000);
  flushSync();
  expect(time!.textContent).toBe('3 min. ago');
  await setLocaleSetting('fr');
  flushSync();
  expect(time!.textContent?.replace(/\s/g, ' ')).toBe('il y a 3 min');

  await unmount(component);
  component = undefined;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { direction: 'incoming', self: received.to, title: received.from.title, project: 'Release tools', machine: 'Build PC', address: received.from },
  { direction: 'outgoing', self: received.from, title: received.toTitle, project: 'Infrastructure', machine: 'Server', address: received.to },
])('$direction mail shows the project and two checks, and opens the other thread', ({ self, title, project, machine, address }) => {
  const onopen = vi.fn();
  component = mount(ForwardedAgentMessage, { target: document.body, props: { letter: received, self, onopen } });
  flushSync();
  const link = document.querySelector<HTMLButtonElement>('[data-testid="agent-letter-open"]')!;
  expect(link.textContent).toContain(title);
  expect(link.textContent).toContain(machine);
  expect(document.querySelector('[data-testid="agent-letter-project"]')?.textContent).toBe(project);
  const status = document.querySelector('[data-testid="agent-letter-status"]')!;
  expect(status.querySelector('svg.lucide-check-check')).not.toBeNull();
  expect(status.textContent?.trim()).toBe('');
  expect(status.getAttribute('aria-label')).toBe('Submitted to the recipient agent');
  link.click();
  expect(onopen).toHaveBeenCalledWith(address);
});
