import { expect, test } from 'bun:test';
import { COORDINATION_RECENT_COMPLETION_MS, type AgentContact } from '@boite/contracts';
import { contactLine } from '../src/agents-cli.ts';

const now = 1_800_000_000_000;
const contact: AgentContact = { coreId: 'here', threadId: 'thread', title: 'Worker', machine: 'Test machine', resources: '', status: 'idle', mode: 'brief', activeAt: now };

test('activity advice uses successful completion, warns on unknown history and allows a recent follow-up', () => {
  expect(contactLine(contact, 'here', now)).toContain('not working');
  expect(contactLine(contact, 'here', now)).toContain('discouraged');
  expect(contactLine({ ...contact, lastCompletedAt: null }, 'here', now)).toContain('no completed turn');
  expect(contactLine({ ...contact, lastCompletedAt: now - COORDINATION_RECENT_COMPLETION_MS }, 'here', now)).not.toContain('warning:');
  expect(contactLine({ ...contact, lastCompletedAt: now - COORDINATION_RECENT_COMPLETION_MS - 1 }, 'here', now)).toContain('discouraged');
  expect(contactLine({ ...contact, lastCompletedAt: now + 1 }, 'here', now)).toContain('discouraged');
  // A crashed thread is unfinished work, not a finished one to leave alone.
  expect(contactLine({ ...contact, lastCompletedAt: now - COORDINATION_RECENT_COMPLETION_MS - 1, status: 'error' }, 'here', now)).toContain('note: its last turn failed; a message wakes it to resume.');
  for (const status of ['running', 'queued', 'waiting'] as const) expect(contactLine({ ...contact, status }, 'here', now)).not.toContain('warning:');
});

test('contact output exposes project restoration and an automatic delivery pause', () => {
  const line = contactLine({ ...contact, projectArchived: true, paused: true }, 'here', now);
  expect(line).toContain('project archived; delivery will restore it');
  expect(line).toContain('coordination paused');
});
