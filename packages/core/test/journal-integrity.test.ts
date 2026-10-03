import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Journal } from '../src/journal.ts';
import { inspectJournal } from '../src/journal/integrity.ts';
import { connect } from '../src/client.ts';
import { startTestCore } from './harness.ts';
describe('historical journal inspection', () => {
  let dir: string, journal: Journal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boite-inspect-'));
    const file = join(dir,'journal.db'); const raw = new Database(file);
    // Bootstrap the immutable fixture in one transaction, before exercising migration.
    raw.transaction(() => raw.exec(readFileSync(new URL('./fixtures/journal-v27.sql', import.meta.url),'utf8')))();
    raw.close(); journal = new Journal(file);
  });
  afterEach(() => { journal.close(); rmSync(dir,{recursive:true,force:true}); });
  test('bounded indexed pages preserve journal and return metadata without stored text', () => {
    const before = journal.db.query('SELECT total_changes() AS n').get();
    let cursor = null, checked = 0;
    do {
      const page = inspectJournal(journal, { cursor, limit: 2 });
      expect(page.checked).toBeLessThanOrEqual(2);
      expect(page.issues).toEqual([]); expect(page.truncated).toBe(page.cursor !== null);
      expect(JSON.stringify(page)).not.toContain('Synthetic'); checked += page.checked; cursor = page.cursor;
    } while (cursor);
    expect(checked).toBe(15); expect(journal.db.query('SELECT total_changes() AS n').get()).toEqual(before);
  });
  test('concrete broken ownership, terminal streaming and started queue hold are diagnosed', () => {
    journal.db.exec("UPDATE turns SET status='done',queue_hold='{\"reason\":\"core-restarted\",\"since\":100}' WHERE id='turn_running'; UPDATE messages SET thread_id='missing-thread' WHERE id='msg_queued'; UPDATE turn_requests SET message_id='msg_answer' WHERE request_id='accepted'; UPDATE threads SET fork_origin='{\"threadId\":\"thr_deleted\",\"messageId\":\"msg_prompt\",\"turnId\":null,\"mode\":\"seeded\"}' WHERE id='thr_fixture'");
    const result = inspectJournal(journal,{ limit:500 });
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['invalid-queue-hold','missing-thread','terminal-streaming-message','request-message-mismatch','fork-origin-owner-mismatch']));
    expect(JSON.stringify(result)).not.toContain('msg_prompt');
  });
  test('oversized JSON is not parsed and malformed history metadata does not leak', () => {
    journal.db.query('UPDATE threads SET fork_origin=? WHERE id=?').run('PRIVATE_PAYLOAD'.repeat(1000),'thr_fixture');
    journal.db.query('INSERT INTO background_observations VALUES (?,?,?,?,?,?)').run('thr_fixture','echo',0,'turn_done','task','["PRIVATE_PAYLOAD"]');
    const result = inspectJournal(journal,{limit:500});
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['oversized-json','malformed-json']));
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PAYLOAD');
  });
  test('untrusted cursor and limits reject before interpolating SQL', () => {
    for (const params of [{limit:501},{limit:0},{limit:1.5},{cursor:{table:'threads;DROP TABLE threads',afterRowid:0}},{cursor:{table:'threads',afterRowid:-1}},{cursor:{table:'threads',afterRowid:Number.MAX_SAFE_INTEGER+1}}]) {
      expect(() => inspectJournal(journal,params as never)).toThrow();
    }
    expect(journal.db.query('SELECT COUNT(*) AS n FROM threads').get()).toEqual({n:2});
  });
  test('a 500-row page never loads message parts and resumes strictly after its cursor', () => {
    journal.db.transaction(() => {
      const insert = journal.db.query("INSERT INTO messages(id,thread_id,turn_id,role,parts,state,created_at) VALUES (?,'thr_fixture','turn_done','assistant',?,'complete',200)");
      for (let index=0;index<501;index++) insert.run(`synthetic-${index}`,index===0 ? JSON.stringify([{type:'text',text:'PRIVATE_PAYLOAD'.repeat(100000)}]) : '[]');
    })();
    const hydration = spyOn(journal,'listMessages').mockImplementation(() => { throw new Error('Unexpected transcript hydration'); });
    try {
      const first = inspectJournal(journal,{cursor:{table:'messages',afterRowid:0},limit:500});
      expect(first.checked).toBe(500); expect(first.truncated).toBe(true);
      expect(first.cursor?.table).toBe('messages'); expect(JSON.stringify(first)).not.toContain('PRIVATE_PAYLOAD');
      const next = inspectJournal(journal,{cursor:first.cursor,limit:500});
      expect(next.checked).toBe(11); expect(next.truncated).toBe(false);
      expect(hydration).not.toHaveBeenCalled();
    } finally { hydration.mockRestore(); }
  });
});

test('inspection RPC is owner only for paired devices and scoped agents', async () => {
  const h = await startTestCore(); const owner = await h.connect();
  const grant = await owner.call('pairing.grant',{}); const phone = await connect(h.url,'',{grant:grant.grant});
  const agent = await connect(h.url,h.core.agents.tokenFor('synthetic-agent'));
  try {
    expect((await owner.call('journal.inspect',{limit:1})).checked).toBeLessThanOrEqual(1);
    await expect(phone.call('journal.inspect',{})).rejects.toThrow('owner');
    await expect(agent.call('journal.inspect',{})).rejects.toThrow('agent');
  } finally { phone.close(); agent.close(); await h.stop(); }
});
