import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineCount, sizeSlack, sizeViolations, type SizeBudget } from './size.ts';

const budget: SizeBudget = { ceiling: 10, allow: { 'big.ts': 20 } };

test('counts lines with or without a final newline, and CRLF the same as LF', () => {
  expect(lineCount('')).toBe(0);
  expect(lineCount('a')).toBe(1);
  expect(lineCount('a\nb\n')).toBe(2);
  expect(lineCount('a\r\nb\r\nc')).toBe(3);
});

test('an unlisted file above the ceiling fails, one at it passes', () => {
  expect(sizeViolations(new Map([['new.ts', 11], ['big.ts', 20]]), budget)).toEqual([
    'new.ts: 11 lines, above the 10-line ceiling; split it',
  ]);
  expect(sizeViolations(new Map([['new.ts', 10], ['big.ts', 20]]), budget)).toEqual([]);
});

test('a listed file may shrink but not grow past its allowance', () => {
  expect(sizeViolations(new Map([['big.ts', 21]]), budget)).toEqual([
    'big.ts: 21 lines, grown past the 20 it is allowed in size-budget.json; split it instead',
  ]);
  expect(sizeViolations(new Map([['big.ts', 15]]), budget)).toEqual([]);
  expect(sizeSlack(new Map([['big.ts', 15]]), budget)).toEqual([
    'big.ts: 15 lines, allowed 20; lower its entry in size-budget.json',
  ]);
});

test('an entry for a file split under the ceiling or removed must go', () => {
  expect(sizeViolations(new Map([['big.ts', 9]]), budget)).toEqual([
    'big.ts: 9 lines, under the 10-line ceiling now; remove its entry from size-budget.json',
  ]);
  expect(sizeViolations(new Map(), budget)).toEqual([
    'big.ts: listed in size-budget.json (20 lines) but not a production source any more; remove the entry',
  ]);
});

test('the checked-in budget keeps the 900-line ceiling and allows nothing under it', () => {
  const checkedIn = JSON.parse(readFileSync(join(import.meta.dir, 'size-budget.json'), 'utf8')) as SizeBudget;
  expect(checkedIn.ceiling).toBe(900);
  for (const allowed of Object.values(checkedIn.allow)) expect(allowed).toBeGreaterThan(checkedIn.ceiling);
});
