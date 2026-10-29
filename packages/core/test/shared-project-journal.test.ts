import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createSharedProjects, fingerprint, SharedProjectJournal } from '../src/contacts/project-journal.ts';

test('content receipts use code-unit key ordering, including nested and non-ASCII keys', () => {
  const input = { z: [{ ä: 1, z: 2 }], ä: 3, Z: 4 };
  const expected = createHash('sha256').update('{"Z":4,"z":[{"z":2,"ä":1}],"ä":3}').digest('hex');
  expect(fingerprint(input)).toBe(expected);
  const db = new Database(':memory:');
  try {
    createSharedProjects(db);
    const journal = new SharedProjectJournal(db);
    expect(journal.once('actor', 'request', input, () => 'receipt')).toBe('receipt');
    expect(journal.once<string>('actor', 'request', { ä: 3, Z: 4, z: [{ z: 2, ä: 1 }] }, () => { throw new Error('replayed'); })).toBe('receipt');
    expect(() => journal.once('actor', 'request', { ...input, Z: 5 }, () => 'changed')).toThrow('different');
  } finally { db.close(); }
});
