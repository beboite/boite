import { expect, test } from 'bun:test';
import { INITIAL_MESSAGE_PAGE, MESSAGE_PAGE_MAX_BYTES, MESSAGE_SENT_MAX_BYTES, RPC_MAX_FRAME_BYTES, TOOL_OUTPUT_PREVIEW_CHARS, type Message } from '@boite/contracts';
import { echoThread, startTestCore } from './harness';

test('a saved reading position shares one byte budget across both halves and keeps every history cursor', async () => {
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const text = '\n'.repeat(2 * 1024 * 1024);
    const ids = Array.from({ length: 12 }, (_, index) => `heavy-${index}`);
    harness.core.journal.append({ type: 'message.started', threadId, version: 1, payload: {} }, () => {
      for (const [index, id] of ids.entries()) harness.core.journal.putMessage({
        id, threadId, turnId: 'history-turn', role: 'assistant', state: 'complete', createdAt: index,
        parts: [{ type: 'text', text }],
      });
    });
    const options = { compactToolParts: true, limit: 6 };
    const opened = await client.call('threads.get', { threadId, around: 'heavy-5', ...options, open: {} });
    expect(opened.messages.some(message => message.id === 'heavy-5')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(opened.messages))).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
    expect(opened.messagesBefore).not.toBeNull();
    expect(opened.messagesAfter).toBeDefined();
    const complete = (messages: Message[]) => {
      for (const message of messages) expect(message.parts[0]).toEqual({ type: 'text', text });
    };
    complete(opened.messages);
    const walked = opened.messages.map(message => message.id);
    let pages = 0;
    for (let before = opened.messagesBefore; before;) {
      const page = await client.call('messages.list', { threadId, before, ...options });
      expect(page.messages.length).toBeGreaterThan(0);
      complete(page.messages);
      expect(page.before).not.toBe(before);
      expect(++pages).toBeLessThan(ids.length);
      walked.unshift(...page.messages.map(message => message.id));
      before = page.before;
    }
    for (let after = opened.messagesAfter; after;) {
      const page = await client.call('messages.list', { threadId, after, ...options });
      expect(page.messages.length).toBeGreaterThan(0);
      complete(page.messages);
      expect(page.after).not.toBe(after);
      expect(++pages).toBeLessThan(ids.length);
      walked.push(...page.messages.map(message => message.id));
      after = page.after ?? undefined;
    }
    expect(walked).toEqual(ids);
    expect(harness.core.journal.getMessage('heavy-5')!.parts[0]).toEqual({ type: 'text', text });

    // Ordinary pages allow one legal message above 12 MiB. A centred page
    // must keep that anchor alone rather than dropping it or adding a neighbour.
    const singleThread = await echoThread(harness, client);
    const largeText = 'x'.repeat(13 * 1024 * 1024);
    harness.core.journal.append({ type: 'message.started', threadId: singleThread.threadId, version: 1, payload: {} }, () => {
      for (let index = 0; index < 12; index++) harness.core.journal.putMessage({
        id: `single-${index}`, threadId: singleThread.threadId, turnId: 'single-turn', role: 'assistant', state: 'complete', createdAt: index,
        parts: [{ type: 'text', text: index === 5 ? largeText : 'neighbour' }],
      });
    });
    const single = await client.call('threads.get', { threadId: singleThread.threadId, around: 'single-5', limit: 6 });
    expect(single.messages.map(message => message.id)).toEqual(['single-5']);
    expect(single.messagesBefore).toBe('single-5');
    expect(single.messagesAfter).toBe('single-5');
    expect(single.messages[0]!.parts[0]).toEqual({ type: 'text', text: largeText });
    const bytes = Buffer.byteLength(JSON.stringify(single.messages));
    expect(bytes).toBeGreaterThan(MESSAGE_PAGE_MAX_BYTES);
    expect(bytes).toBeLessThan(RPC_MAX_FRAME_BYTES);
  } finally { await harness.stop(); }
});

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

test('a message whose stored tool outputs exceed one frame opens compacted and refuses only an uncompacted read', async () => {
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    // Claude's Read of a screenshot stores the image block as base64 JSON text.
    const image = JSON.stringify({ type: 'image', source: { type: 'base64', data: 'A'.repeat(600_000) } });
    const tools = Array.from({ length: 30 }, (_, index) => ({ type: 'tool' as const, toolId: `read-${index}`, name: 'Read', input: { file_path: `shot-${index}.png` }, output: image, status: 'done' as const }));
    harness.core.journal.append({ type: 'message.started', threadId, version: 1, payload: {} }, () => {
      for (const [index, id] of ['before-images', 'images', 'after-images'].entries()) {
        harness.core.journal.putMessage({ id, threadId, turnId: 'images-turn', role: 'assistant', state: 'complete', createdAt: index,
          parts: id === 'images' ? tools : [{ type: 'text', text: id }] });
      }
    });
    expect(Buffer.byteLength(JSON.stringify(harness.core.journal.getMessage('images')))).toBeGreaterThan(RPC_MAX_FRAME_BYTES);
    const opened = await client.call('threads.get', { threadId, limit: INITIAL_MESSAGE_PAGE, compactTools: true });
    expect(opened.messages.map(message => message.id).slice(-3)).toEqual(['before-images', 'images', 'after-images']);
    expect(opened.messages.at(-2)!.parts[0]).toMatchObject({ outputDeferred: true, output: image.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) });
    const newest = await client.call('threads.get', { threadId, limit: 1, compactTools: true });
    const older = await client.call('messages.list', { threadId, before: newest.messagesBefore!, compactTools: true });
    expect(older.messages.map(message => message.id).slice(-2)).toEqual(['before-images', 'images']);
    const resumed = await client.call('threads.get', { threadId, after: 'images', compactTools: true });
    expect(resumed.messagesFrom).toBe('images');
    expect(resumed.messages.map(message => message.id)).toEqual(['images', 'after-images']);
    expect(await client.call('messages.toolOutput', { threadId, messageId: 'images', toolId: 'read-29' })).toEqual({ output: image });
    await expect(client.call('messages.list', { threadId, before: 'after-images' })).rejects.toThrow('message images is');
  } finally { await harness.stop(); }
});

test('no message keeps a thread from opening: heavy inputs, documents and texts are deferred or cut, and live parts follow', async () => {
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    // A Write carries the whole file in its input, and its diff carries it again.
    const file = 'generated line\n'.repeat(400_000);
    const writes = Array.from({ length: 4 }, (_, index) => ({ type: 'tool' as const, toolId: `write-${index}`, name: 'Write', status: 'done' as const,
      input: { file_path: `out-${index}.txt`, content: file }, output: 'written',
      documents: [{ kind: 'diff' as const, path: `out-${index}.txt`, oldText: '', newText: file }] }));
    // Calls under every per-call threshold whose sum still outweighs a message's budget.
    const many = Array.from({ length: 300 }, (_, index) => ({ type: 'tool' as const, toolId: `grep-${index}`, name: 'Grep', status: 'done' as const,
      input: { pattern: `p${index}`, note: 'n'.repeat(15_000) }, output: 'o'.repeat(15_000) }));
    const parts: Record<string, Message['parts']> = { writes, many, prose: [{ type: 'text', text: 'é'.repeat(9_000_000) }], last: [{ type: 'text', text: 'last' }] };
    harness.core.journal.append({ type: 'message.started', threadId, version: 1, payload: {} }, () => {
      for (const [index, id] of Object.keys(parts).entries()) {
        harness.core.journal.putMessage({ id, threadId, turnId: 'heavy-turn', role: 'assistant', state: 'complete', createdAt: index, parts: parts[id]! });
      }
    });
    expect(Buffer.byteLength(JSON.stringify(harness.core.journal.getMessage('writes')))).toBeGreaterThan(2 * RPC_MAX_FRAME_BYTES);
    // Before `compactToolParts`, the whole thread failed on the first heavy message.
    await expect(client.call('threads.get', { threadId, compactTools: true })).rejects.toThrow('message ');

    const light = { compactTools: true, compactToolParts: true } as const;
    const opened = await client.call('threads.get', { threadId, limit: 1, ...light, open: {} });
    const pages = [opened.messages];
    for (let before = opened.messagesBefore; before;) {
      const page = await client.call('messages.list', { threadId, before, limit: 1, ...light });
      pages.unshift(page.messages);
      before = page.before;
    }
    const sent = pages.flat();
    expect(sent.map(message => message.id).slice(-4)).toEqual(['writes', 'many', 'prose', 'last']);
    for (const message of sent) expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(MESSAGE_SENT_MAX_BYTES);
    const write = sent.find(message => message.id === 'writes')!.parts[0]!;
    expect(write).toMatchObject({ inputDeferred: true, documentsDeferred: true, documents: [{ kind: 'diff', path: 'out-0.txt', oldText: '', newText: '' }] });
    expect(write.type === 'tool' && (write.input as { file_path: string }).file_path).toBe('out-0.txt');
    // Each call alone was light: only the message's total deferred them.
    expect(sent.find(message => message.id === 'many')!.parts.every(part => part.type === 'tool' && part.outputDeferred && part.inputDeferred)).toBe(true);
    const prose = sent.find(message => message.id === 'prose')!.parts[0]!;
    expect(prose.type === 'text' && prose.omitted! > 0 && prose.text.length + prose.omitted! === 9_000_000).toBe(true);
    // Two bytes a character: about half of the 18 MB fits, not none of it.
    expect(prose.type === 'text' && prose.text.length).toBeGreaterThan(3_500_000);

    const full = await client.call('messages.toolPart', { threadId, messageId: 'writes', toolId: 'write-3' });
    expect(full.part).toMatchObject({ input: { content: file }, documents: [{ newText: file }], output: 'written' });
    expect(full.part).not.toHaveProperty('inputDeferred');
    await expect(client.call('messages.toolPart', { threadId, messageId: 'writes', toolId: 'missing' })).rejects.toThrow('not a tool of message');

    // A call that finishes while the thread is open reaches this socket the same way.
    const live = client.next('message.part', event => event.messageId === 'last');
    harness.core.bus.emit('message.part', { threadId, messageId: 'last', partIndex: 1, part: writes[0]! });
    expect((await live).part).toMatchObject({ inputDeferred: true, documentsDeferred: true });
  } finally { await harness.stop(); }
});
