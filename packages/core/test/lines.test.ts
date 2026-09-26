import { describe, expect, test } from 'bun:test';
import { LineSplitter } from '../src/drivers/lines.ts';

const CHUNK = 64 * 1024;

function chunksOf(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

function split(chunks: string[], maxLine?: number): { lines: string[]; overflows: number } {
  const lines: string[] = [];
  let overflows = 0;
  const splitter = new LineSplitter((line) => lines.push(line), {
    ...(maxLine === undefined ? {} : { maxLine }),
    onOverflow: () => {
      overflows += 1;
    },
  });
  for (const chunk of chunks) splitter.feed(chunk);
  splitter.end();
  return { lines, overflows };
}

describe('LineSplitter', () => {
  test('a record split across many chunks comes out whole', () => {
    const record = JSON.stringify({ type: 'message_end', text: 'a'.repeat(1000) });
    expect(split([...chunksOf(record, 7), '\n']).lines).toEqual([record]);
  });

  test('several records in one chunk come out in order', () => {
    expect(split(['{"a":1}\n{"b":2}\n{"c":3}\n']).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('a CRLF ending loses its carriage return, and a blank line is skipped', () => {
    expect(split(['{"a":1}\r\n\r\n   \n{"b":2}\r\n']).lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('a newline as the first or the last character of a chunk', () => {
    expect(split(['{"a":', '1}', '\n{"b":2}\n', '\n{"c"', ':3}\n']).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('only LF ends a record: U+2028 and U+2029 stay inside it', () => {
    const record = '{"text":"one two three"}';
    expect(split([`${record}\n`]).lines).toEqual([record]);
  });

  test('a multi-byte character cut by a chunk boundary is reassembled', () => {
    const record = '{"text":"café \u{1F600}"}';
    const at = record.indexOf('\u{1F600}') + 1;
    // A surrogate pair cut in two, as a string chunk boundary can do.
    expect(split([record.slice(0, at), record.slice(at), '\n']).lines).toEqual([record]);
  });

  test('a last line with no newline is kept by end()', () => {
    expect(split(['{"a":1}\n{"b":2}']).lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('a line past the cap is dropped once and the next line still arrives', () => {
    const max = 1024;
    const huge = 'x'.repeat(max * 20);
    const { lines, overflows } = split([...chunksOf(`{"id":1}\n${huge}\n{"id":2}\n`, 100)], max);
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
    expect(overflows).toBe(1);
  });

  test('a complete line past the cap inside one chunk is dropped too', () => {
    const { lines, overflows } = split([`${'y'.repeat(50)}\n{"id":2}\n`], 10);
    expect(lines).toEqual(['{"id":2}']);
    expect(overflows).toBe(1);
  });

  test('a 20 MiB line in 64 KiB chunks is dropped by a 16 MiB cap', () => {
    const huge = `{"data":"${'z'.repeat(20 * 1024 * 1024)}"}`;
    const { lines, overflows } = split([...chunksOf(`${huge}\n{"id":2}\n`, CHUNK)], 16 * 1024 * 1024);
    expect(lines).toEqual(['{"id":2}']);
    expect(overflows).toBe(1);
  });

  test('a 32 MiB line in 64 KiB chunks is scanned once, not once per chunk', () => {
    const huge = `{"data":"${'q'.repeat(32 * 1024 * 1024)}"}`;
    const chunks = chunksOf(`${huge}\n`, CHUNK);
    const started = performance.now();
    const { lines } = split(chunks);
    const elapsed = performance.now() - started;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(huge.length);
    // The old rescan took about 690 ms here on a Ryzen 9800X3D, this one about 10.
    expect(elapsed).toBeLessThan(300);
  });
});
