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

test.each([
  { direction: 'incoming', self: received.to, label: 'From the steward', title: received.from.title },
  { direction: 'outgoing', self: received.from, label: 'Steward sent to', title: received.toTitle },
])('a steward letter reads as the steward\'s, $direction, never on the user\'s side', ({ self, label, title }) => {
  component = mount(ForwardedAgentMessage, { target: document.body, props: { letter: { ...received, origin: 'steward' }, self } });
  flushSync();
  const bubble = document.querySelector<HTMLElement>('[data-testid="forwarded-agent-message"]')!;
  expect(bubble.classList.contains('steward')).toBe(true);
  expect(bubble.classList.contains('user')).toBe(false);
  expect(bubble.querySelector('.forward-label')?.textContent).toBe(label);
  expect(bubble.querySelector('strong')?.textContent).toBe(title);
  expect(bubble.querySelector('svg.lucide-user-cog')).not.toBeNull();
});

test('a notice is a compact event line naming the thread it is about, and opens it', () => {
  const onopen = vi.fn();
  const notice: AgentLetter = { ...received, origin: 'notice', text: 'Turn done in "Deployment agent".\nBranch pushed.' };
  component = mount(ForwardedAgentMessage, { target: document.body, props: { letter: notice, self: received.to, onopen } });
  flushSync();
  expect(document.querySelector('[data-testid="forwarded-agent-message"]')).toBeNull();
  const line = document.querySelector<HTMLElement>('[data-testid="agent-notice"]')!;
  expect(line.querySelector('svg.lucide-bell-ring')).not.toBeNull();
  expect(line.querySelector('[data-testid="agent-letter-open"]')?.textContent?.trim()).toBe('Notice from Deployment agent');
  expect(line.querySelector('.notice-body')?.textContent).toBe(notice.text);
  expect(line.querySelector('[data-testid="agent-letter-status"]')).toBeNull();
  line.querySelector<HTMLButtonElement>('[data-testid="agent-letter-open"]')!.click();
  expect(onopen).toHaveBeenCalledWith(received.from);
});
