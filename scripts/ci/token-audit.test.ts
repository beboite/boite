import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'boite-token-audit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const audit = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../token-audit.ts'), ...args]);
const output = (result: ReturnType<typeof audit>) => result.stdout.toString() + result.stderr.toString();

test('the audit rejects invalid options and reports empty or missing input clearly', () => {
  for (const [name, value] of [['days', '0'], ['days', 'NaN'], ['chars-per-token', 'Infinity'], ['chars-per-token', '-2']]) {
    const result = audit(`--${name}`, value, '--root', root);
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain(`--${name} must be a finite positive number`);
  }
  const empty = audit('--root', root);
  expect(empty.exitCode).not.toBe(0);
  expect(output(empty)).toContain('no model calls in the requested period');
  const missing = audit('--root', join(root, 'missing'));
  expect(missing.exitCode).not.toBe(0);
  expect(output(missing)).toContain('cannot read transcript root');
});

test('old calls supply context state but stay outside the requested interval, with a trailing root slash', () => {
  const fixture = join(root, 'interval'); mkdirSync(join(fixture, 'example'), { recursive: true });
  const call = (id: string, age: number, input: number) => ({ type: 'assistant', timestamp: new Date(Date.now() - age * 86400000).toISOString(),
    message: { id, model: 'fixture', usage: { input_tokens: input, output_tokens: 10 }, content: [{ type: 'text', text: 'fixture' }] } });
  writeFileSync(join(fixture, 'example/session.jsonl'), [call('old', 3, 500), call('new', 0, 600)].map(value => JSON.stringify(value)).join('\n'));
  const result = audit('--root', fixture + '/', '--days', '1');
  expect(result.exitCode).toBe(0);
  expect(output(result)).toContain('calls 1,');
  expect(output(result)).toContain('- example:');
  expect(output(result)).toContain('compaction replay unavailable: no post-compaction sample in the requested period');
  expect(output(result)).not.toContain('compact at 60k');
});
