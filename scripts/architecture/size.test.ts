import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exemptBy, lineCount, rebaselinedBudget, shrunkBudget, sizeSlack, sizeViolations, type SizeBudget } from './size.ts';

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

const tables: SizeBudget = { ceiling: 10, allow: { 'big.ts': 20 }, exempt: { 'contract.ts': 'grows first', 'lib/strings.*.ts': 'one per sentence' } };

test('an exempt table may grow past the ceiling, a star matching within one segment', () => {
  const lines = new Map([['big.ts', 20], ['contract.ts', 500], ['lib/strings.en.ts', 400], ['lib/strings.fr.ts', 401]]);
  expect(sizeViolations(lines, tables)).toEqual([]);
  expect(exemptBy('lib/strings.en.ts', tables)).toBe('lib/strings.*.ts');
  expect(exemptBy('lib/strings/en.ts', tables)).toBeUndefined();
  expect(exemptBy('lib/stringsXen.ts', tables)).toBeUndefined();
  expect(sizeViolations(new Map([...lines, ['lib/strings/big.ts', 11]]), tables)).toEqual([
    'lib/strings/big.ts: 11 lines, above the 10-line ceiling; split it',
  ]);
});

test('an exempt entry that matches nothing, or a file both allowed and exempt, fails', () => {
  expect(sizeViolations(new Map([['big.ts', 20], ['contract.ts', 5]]), tables)).toEqual([
    'lib/strings.*.ts: exempt in size-budget.json but matches no production source; remove the entry',
  ]);
  const both: SizeBudget = { ceiling: 10, allow: { 'contract.ts': 30 }, exempt: { 'contract.ts': 'grows first' } };
  expect(sizeViolations(new Map([['contract.ts', 30]]), both)).toEqual([
    'contract.ts: both allowed and exempt (contract.ts) in size-budget.json; keep one',
  ]);
});

test('shrinking lowers entries, drops the ones under the ceiling and never raises one', () => {
  const budgetWithTables: SizeBudget = { ...tables, allow: { 'big.ts': 20, 'mid.ts': 15, 'small.ts': 12 } };
  const lines = new Map([['big.ts', 25], ['mid.ts', 13], ['small.ts', 9]]);
  expect(shrunkBudget(lines, budgetWithTables)).toEqual({ ...tables, allow: { 'big.ts': 20, 'mid.ts': 13 } });
});

test('a rebaseline pins every non-exempt file above the ceiling at its size and names each raise', () => {
  const lines = new Map([['big.ts', 25], ['new.ts', 12], ['small.ts', 4], ['contract.ts', 500], ['lib/strings.en.ts', 400]]);
  expect(rebaselinedBudget(lines, tables)).toEqual({
    budget: { ...tables, allow: { 'big.ts': 25, 'new.ts': 12 } },
    raised: ['big.ts: raised from 20 to 25 lines', 'new.ts: added at 12 lines'],
  });
  expect(rebaselinedBudget(new Map([['big.ts', 18]]), budget).raised).toEqual([]);
});

test('the checked-in budget keeps the 900-line ceiling, allows nothing under it and says why each table is exempt', () => {
  const checkedIn = JSON.parse(readFileSync(join(import.meta.dir, 'size-budget.json'), 'utf8')) as SizeBudget;
  expect(checkedIn.ceiling).toBe(900);
  for (const allowed of Object.values(checkedIn.allow)) expect(allowed).toBeGreaterThan(checkedIn.ceiling);
  for (const reason of Object.values(checkedIn.exempt ?? {})) expect(reason.length).toBeGreaterThan(20);
  for (const file of ['packages/contracts/src/index.ts', 'packages/ui/src/lib/strings.en.ts', 'packages/ui/src/lib/strings.fr.ts']) {
    expect(exemptBy(file, checkedIn)).toBeDefined();
  }
});
