import { describe, expect, test } from 'bun:test';
import { Journal } from '../src/journal.ts';
import { AgentsRepository } from '../src/agents/repository.ts';

const routine = { agentId: 'agt_profile_x', name: 'Morning', prompt: 'Read the news', schedule: { kind: 'interval' as const, everyMinutes: 60 }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null };

describe('persistent agent records', () => {
  test('a routine exists without a project and reloads from its journal', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const saved = records.create('routine', routine);
      expect(journal.listProjects()).toEqual([]);
      expect(new AgentsRepository(journal).get('routine', saved.id)).toEqual(saved);
      expect(records.revision()).toBeGreaterThan(0);
    } finally { journal.close(); }
  });

  test('find answers null for a missing record and still throws on a bad kind or a failing database', () => {
    const journal = new Journal(':memory:');
    const records = new AgentsRepository(journal);
    const saved = records.create('routine', routine);
    expect(records.find('routine', 'agt_routine_missing')).toBeNull();
    expect(() => records.find('mission' as 'routine', 'agt_mission_1')).toThrow();
    journal.close();
    // A closed database is a failure the routine tick must see, not a missing routine.
    expect(() => records.find('routine', saved.id)).toThrow();
  });

  test('optimistic revisions refuse lost edits and keep the first update', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const saved = records.create('routine', routine);
      const next = records.update('routine', saved.id, saved.revision, { ...routine, name: 'First edit' });
      expect(() => records.update('routine', saved.id, saved.revision, { ...routine, name: 'Lost edit' })).toThrow('revision');
      expect(records.get('routine', saved.id)).toEqual(next);
    } finally { journal.close(); }
  });

  test('a retried command returns its original result without duplicating its effects', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      let executed = 0;
      const submit = () => records.command('owner', 'request_123', { text: 'hello' }, () => {
        executed++;
        return records.create('routine', routine);
      });
      const first = submit();
      expect(submit()).toEqual(first);
      expect(executed).toBe(1);
      expect(records.list('routine')).toHaveLength(1);
      expect(() => records.command('owner', 'request_123', { text: 'different' }, () => null)).toThrow('different');
    } finally { journal.close(); }
  });

  test('a removed record is gone, and old kinds stay in the table unread', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const saved = records.create('routine', routine);
      journal.db.query("INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES ('mission', 'agt_mission_old', 1, 1, 1, '{}')").run();
      records.remove('routine', saved.id);
      expect(records.list('routine')).toEqual([]);
      expect(records.find('routine', saved.id)).toBeNull();
      expect(journal.db.query("SELECT id FROM agent_entities WHERE kind = 'mission'").all()).toEqual([{ id: 'agt_mission_old' }]);
      expect(() => records.list('mission' as 'routine')).toThrow('unknown agent record kind');
    } finally { journal.close(); }
  });

  test('a failed command rolls back both records and its request receipt', () => {
    const journal = new Journal(':memory:');
    try {
      const records = new AgentsRepository(journal);
      const before = records.revision();
      expect(() => records.command('owner', 'request_123', {}, () => {
        records.create('routine', routine);
        throw new Error('interrupted');
      })).toThrow('interrupted');
      expect(records.list('routine')).toEqual([]);
      expect(records.revision()).toBe(before);
      expect(records.command('owner', 'request_123', {}, () => 'retry')).toBe('retry');
    } finally { journal.close(); }
  });
});
