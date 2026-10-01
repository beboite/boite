import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AgentLetter } from '@boite/contracts';
import ForwardedAgentMessage from './ForwardedAgentMessage.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
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
