import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.ts';
import { BackgroundHistory } from '../src/threads/background-history.ts';
let dir: string;
let journal: Journal;
let history: BackgroundHistory;
const owner = { providerId: 'claude', sessionGeneration: 1, parentTurnId: 'turn-1' };
const task = { id: 'native-1', kind: 'agent' as const, description: 'Review', toolId: 'tool-1', startedAt: 10 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-background-'));
  journal = new Journal(join(dir, 'journal.db'));
  journal.db.query(`INSERT INTO threads (id,title,provider_id,account_id,cwd,permission_mode,status,unread,archived,created_at,updated_at,session_generation) VALUES ('thread','Review','claude','account','/tmp','default','idle',0,0,1,1,1)`).run();
  history = new BackgroundHistory(journal);
});
afterEach(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
test('explicit completion survives reconnect and restart; live work is cancelled', () => {
  history.observe('thread', [task], owner, 20);
  history.finish('thread', task.id, owner, 'completed', 30);
  history.observe('thread', [{ ...task, id: 'native-2' }], { ...owner, parentTurnId: 'turn-2' }, 40);
  expect(new BackgroundHistory(journal).list('thread').map(t => t.state)).toEqual(['completed', 'running']);
  journal.close(); journal = new Journal(join(dir, 'journal.db')); history = new BackgroundHistory(journal);
  history.interruptLive(50);
  expect(history.list('thread').map(t => [t.state, t.reason])).toEqual([['completed', 'provider-reported'], ['cancelled', 'core-restarted']]);
});
test('stale generations and providers cannot change newer observations', () => {
  journal.db.query('UPDATE threads SET session_generation = 2').run();
  const newer = { ...owner, sessionGeneration: 2 };
  expect(history.observe('thread', [task], newer, 20)).toBe(true);
  expect(history.observe('thread', [], owner, 30)).toBe(false);
  expect(history.finish('thread', task.id, owner, 'completed', 30)).toBe(false);
  expect(history.observe('thread', [], { ...newer, providerId: 'codex' }, 30)).toBe(false);
  expect(history.list('thread')[0]?.state).toBe('running');
});
test('disappearance is unknown, reused ids retain distinct turns, deletion cleans history', () => {
  history.observe('thread', [task], owner, 20);
  history.observe('thread', [], owner, 30);
  history.observe('thread', [task], { ...owner, parentTurnId: 'turn-2' }, 40);
  expect(history.list('thread').map(t => [t.parentTurnId,t.state])).toEqual([['turn-1','ended'], ['turn-2','running']]);
  journal.deleteThreads(['thread']);
  expect(history.list('thread')).toEqual([]);
});

test('root completion and a new turn keep running native work attached to its origin', () => {
  history.observe('thread', [task], owner, 20);
  history.observe('thread', [task], { ...owner, parentTurnId: 'turn-2' }, 30);
  expect(history.list('thread')[0]?.parentTurnId).toBe('turn-1');
  expect(history.list('thread')[0]?.state).toBe('running');
  history.observe('thread', [], owner, 25);
  expect(history.list('thread')[0]?.state).toBe('running');
  history.cancelSession('thread', owner, 40);
  expect(history.list('thread')[0]?.reason).toBe('session-ended');
});
test('terminal tasks cannot be resurrected by a delayed snapshot of the same turn', () => {
  history.observe('thread', [task], owner, 20);
  history.finish('thread', task.id, owner, 'completed', 30);
  history.observe('thread', [task], owner, 40);
  expect(history.list('thread')[0]?.state).toBe('completed');
});

test('an explicit provider result can refine disappearance without changing newer work', () => {
  history.observe('thread', [task], owner, 20);
  history.observe('thread', [], owner, 30);
  history.observe('thread', [task], { ...owner, parentTurnId: 'turn-2' }, 40);
  expect(history.finish('thread', task.id, owner, 'completed', 50)).toBe(true);
  expect(history.list('thread').map(t => [t.parentTurnId, t.state])).toEqual([['turn-2', 'running'], ['turn-1', 'completed']]);
});

test('snapshot history caps newest observations deterministically without capping recovery', () => {
  const tasks = Array.from({ length: 105 }, (_, index) => ({ ...task, id: `native-${index}` }));
  history.observe('thread', tasks, owner, 20);
  expect(history.list('thread')).toHaveLength(100);
  expect(history.list('thread')[0]?.id).toBe('native-5');
  expect(history.list('thread')[99]?.id).toBe('native-104');
  history.interruptLive(30);
  expect(history.list('thread').every(entry => entry.state === 'cancelled')).toBe(true);
  expect(history.finish('thread', 'native-104', owner, 'completed', 40)).toBe(false);
  expect(journal.db.query(`SELECT COUNT(*) AS count FROM background_observations WHERE json_extract(payload, '$.state') = 'cancelled'`).get()).toEqual({ count: 105 });
});
