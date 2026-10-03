import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';
import { FakeContext } from './fake-client/context';
import { seed } from './fake-client/seed';
import { journalInspectionMethods } from './fake-client/journal-inspection';
test('fake journal inspection is bounded and owner only', async () => {
  const client = new FakeClient({delayMs:0,long:true}); await client.connect();
  try {
    const first = await client.call('journal.inspect',{limit:2});
    expect(first.checked).toBe(2); expect(first.truncated).toBe(true);
    const next = await client.call('journal.inspect',{limit:2,cursor:first.cursor}); expect(next.checked).toBe(2);
    expect(JSON.stringify(first)).not.toContain('parts');
    await expect(client.call('journal.inspect',{limit:501})).rejects.toThrow();
    client.becomes('session'); await expect(client.call('journal.inspect',{})).rejects.toThrow('owner');
    client.becomes('agent'); await expect(client.call('journal.inspect',{})).rejects.toThrow('owner');
  } finally { client.close(); }
});
test('fake detects terminal streaming messages without returning their text', async () => {
  const ctx = new FakeContext(); seed(ctx);
  const thread = [...ctx.threads.values()].find(thread => thread.turns.length && thread.messages.length)!;
  const turn = thread.turns[0]!; turn.status='done';
  const message = thread.messages.find(message => message.turnId === turn.id)!; message.state='streaming'; message.parts=[{type:'text',text:'PRIVATE_PAYLOAD'}];
  const result = await journalInspectionMethods(ctx)['journal.inspect']({limit:500});
  expect(result.issues.some(issue => issue.code === 'terminal-streaming-message')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PAYLOAD');
});
