import { expect, test } from 'bun:test';
import { INITIAL_MESSAGE_PAGE, TOOL_OUTPUT_PREVIEW_CHARS, type Message } from '@boite/contracts';
import { echoThread, startTestCore } from './harness';

test('a compact first page keeps complete history and retrieves tool output on demand over RPC', async () => {
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const output = 'command output\n'.repeat(160_000);
    harness.core.journal.append({ type: 'message.started', threadId, version: 1, payload: {} }, () => {
      for (let index = 0; index < 150; index++) {
        const message: Message = { id: `history-${index}`, threadId, turnId: 'history-turn', role: 'assistant', state: 'complete', createdAt: index,
          parts: index === 149 ? [{ type: 'tool', toolId: 'big', name: 'Bash', input: { command: 'report' }, output, status: 'done' }] : [{ type: 'text', text: `Message ${index}` }] };
        harness.core.journal.putMessage(message);
      }
    });
    const page = await client.call('threads.get', { threadId, limit: INITIAL_MESSAGE_PAGE, compactTools: true });
    expect(page.messages).toHaveLength(40);
    expect(page.messagesBefore).toBe('history-110');
    expect(page.messages.at(-1)!.parts[0]).toMatchObject({ outputDeferred: true, output: output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) });
    expect(JSON.stringify(page).length).toBeLessThan(20_000);
    expect(await client.call('messages.toolOutput', { threadId, messageId: 'history-149', toolId: 'big' })).toEqual({ output });
    const older = await client.call('messages.list', { threadId, before: page.messagesBefore!, compactTools: true });
    expect(older.messages).toHaveLength(110);
    expect(older.before).toBeNull();
    // The journal and callers that did not request a preview retain the complete output.
    const complete = await client.call('threads.get', { threadId });
    expect(complete.messages).toHaveLength(120);
    expect(complete.messages.at(-1)!.parts[0]).toMatchObject({ output });
    expect(harness.core.journal.getMessage('history-149')!.parts[0]).not.toHaveProperty('outputDeferred');
    const other = await echoThread(harness, client);
    await expect(client.call('messages.toolOutput', { threadId: other.threadId, messageId: 'history-149', toolId: 'big' })).rejects.toThrow('not a message of thread');
    await expect(client.call('messages.toolOutput', { threadId, messageId: 'history-149', toolId: 'missing' })).rejects.toThrow('not a tool of message');
  } finally { await harness.stop(); }
});
