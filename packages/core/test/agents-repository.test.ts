import { describe, expect, test } from 'bun:test';
import { Journal } from '../src/journal.ts';
import { AgentsRepository } from '../src/agents/repository.ts';

const group = { name: 'Discussion', memberIds: [], mode: 'mentions' as const, maxTurns: 6, maxTurnsPerAgent: 2, paused: false };

describe('persistent agent records', () => {
  test('a group exists without a project and reloads from its journal', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const saved = records.create('group', group);
      expect(journal.listProjects()).toEqual([]);
      expect(new AgentsRepository(journal).get('group', saved.id)).toEqual(saved);
      expect(records.revision()).toBeGreaterThan(0);
    } finally { journal.close(); }
  });

  test('optimistic revisions refuse lost edits and keep the first update', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const saved = records.create('group', group);
      const next = records.update('group', saved.id, saved.revision, { ...group, name: 'First edit' });
      expect(() => records.update('group', saved.id, saved.revision, { ...group, name: 'Lost edit' })).toThrow('revision');
      expect(records.get('group', saved.id)).toEqual(next);
    } finally { journal.close(); }
  });

  test('a retried command returns its original result without duplicating its effects', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      let executed = 0;
      const submit = () => records.command('owner', 'request_123', { text: 'hello' }, () => {
        executed++;
        return records.create('group', group);
      });
      const first = submit();
      expect(submit()).toEqual(first);
      expect(executed).toBe(1);
      expect(records.list('group')).toHaveLength(1);
      expect(() => records.command('owner', 'request_123', { text: 'different' }, () => null)).toThrow('different');
    } finally { journal.close(); }
  });

  test('a failed command rolls back both records and its request receipt', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const before = records.revision();
      expect(() => records.command('owner', 'request_123', {}, () => {
        records.create('group', group);
        throw new Error('interrupted');
      })).toThrow('interrupted');
      expect(records.list('group')).toEqual([]);
      expect(records.revision()).toBe(before);
      expect(records.command('owner', 'request_123', {}, () => 'retry')).toBe('retry');
    } finally { journal.close(); }
  });
});
