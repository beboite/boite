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

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test('a line split across three byte chunks, a multi-byte character cut in two, comes out whole', async () => {
  const bytes = new TextEncoder().encode('{"text":"café \u{1F600}"}\nsign in at https://example.invalid\n');
  const cut = bytes.indexOf(0xf0) + 2;
  const others: string[] = [];
  const output = await new Response(
    jsonLinesOnly(streamOf([bytes.slice(0, 5), bytes.slice(5, cut), bytes.slice(cut)]), (line) => others.push(line)),
  ).text();
  expect(output).toBe('{"text":"café \u{1F600}"}\n');
  expect(others).toEqual(['sign in at https://example.invalid']);
});

test('a 15 MiB protocol line read in 64 KiB chunks reassembles under the cap', async () => {
  const line = `{"data":"${'b'.repeat(15 * 1024 * 1024)}"}`;
  const bytes = new TextEncoder().encode(`${line}\n{"id":2}\n`);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += 64 * 1024) chunks.push(bytes.slice(at, at + 64 * 1024));
  const others: string[] = [];
  const output = await new Response(jsonLinesOnly(streamOf(chunks), (text) => others.push(text))).text();
  expect(output.length).toBe(line.length + '\n{"id":2}\n'.length);
  expect(output.endsWith('"}\n{"id":2}\n')).toBe(true);
  expect(others).toEqual([]);
});
