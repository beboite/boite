import { afterEach, expect, test } from 'vitest';
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
