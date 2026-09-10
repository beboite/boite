import { expect, test } from 'bun:test';
import { jsonLinesOnly } from '../src/drivers/acp.ts';

test('a large chunk keeps complete protocol lines and discards the whole oversized line', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    '{"id":1}\n' + 'x'.repeat(16 * 1024 * 1024 + 1),
    '{"not":"a real new line"}\n{"id":2}\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const warnings: string[] = [];
  const output = await new Response(jsonLinesOnly(source, (line) => warnings.push(line))).text();
  expect(output).toBe('{"id":1}\n{"id":2}\n');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('too large');
});
