import { expect, test } from 'bun:test';
import { boundedMessageWindow, type Message } from '@boite/contracts';

test('a centred page counts empty object syntax in tool inputs against its byte budget', () => {
  const messages: Message[] = ['older', 'anchor', 'newer'].map(id => ({
    id, threadId: 'thread', turnId: 'turn', role: 'assistant', state: 'complete', createdAt: 0,
    parts: [{ type: 'tool', toolId: id, name: 'Read', status: 'done', output: null, input: Array.from({ length: 5000 }, () => ({})) }],
  }));
  const budget = 40_000;
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(budget);
  const { start, end } = boundedMessageWindow(messages, 1, budget, messages.length);
  const page = messages.slice(start, end);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(budget);
  expect(page.map(message => message.id)).toContain('anchor');
  expect(page).toHaveLength(2);
});
