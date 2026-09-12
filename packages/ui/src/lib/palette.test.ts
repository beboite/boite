import { describe, expect, test } from 'vitest';
import { rankItems, scoreMatch, type PaletteItem } from './palette';

describe('scoreMatch', () => {
  test('a prefix beats a word start, which beats a substring, which beats scattered letters', () => {
    const prefix = scoreMatch('port', 'Port the scheduler') ?? -1;
    const wordStart = scoreMatch('sched', 'Port the scheduler') ?? -1;
    const inside = scoreMatch('hedul', 'Port the scheduler') ?? -1;
    const scattered = scoreMatch('pts', 'Port the scheduler') ?? -1;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  test('nothing typed matches everything at zero, and a letter that is not there matches nothing', () => {
    expect(scoreMatch('', 'anything')).toBe(0);
    expect(scoreMatch('   ', 'anything')).toBe(0);
    expect(scoreMatch('xyz', 'Port the scheduler')).toBeNull();
    expect(scoreMatch('schedulers', 'scheduler')).toBeNull();
  });

  test('an abbreviation lands on word starts, letters merely in order do not', () => {
    expect(scoreMatch('ftt', 'Finish the trace tab')).not.toBeNull();
    expect(scoreMatch('fin tr', 'Finish the trace tab')).not.toBeNull();
    expect(scoreMatch('sett', 'Finish the trace tab')).toBeNull();
    expect(scoreMatch('ihe', 'Finish the trace tab')).toBeNull();
  });

  test('case and accents do not count', () => {
    expect(scoreMatch('ÉCHO', 'echo provider')).toBe(100);
  });
});

describe('rankItems', () => {
  const items: PaletteItem[] = [
    { id: 't-1', kind: 'thread', label: 'Finish the trace tab', hint: 'boite' },
    { id: 't-2', kind: 'thread', label: 'Port the scheduler', hint: 'boite' },
    { id: 't-3', kind: 'thread', label: 'Review the descriptor loader', hint: 'notes' },
    { id: 'new', kind: 'command', label: 'New thread', hint: 'Ctrl+N', keywords: 'draft start' },
    { id: 'settings', kind: 'command', label: 'Open settings', hint: 'Ctrl+,' }
  ];

  test('nothing typed keeps the given order, cut at the limit', () => {
    expect(rankItems('', items).map((item) => item.id)).toEqual(['t-1', 't-2', 't-3', 'new', 'settings']);
    expect(rankItems('', items, 2).map((item) => item.id)).toEqual(['t-1', 't-2']);
  });

  test('a query ranks by score and drops what does not match', () => {
    // "the" is a word start in three titles, the earlier the better; "New
    // thread" has t, h and e in order but the e sits mid-word after a gap.
    expect(rankItems('the', items).map((item) => item.id)).toEqual(['t-2', 't-1', 't-3']);
    expect(rankItems('notes', items).map((item) => item.id)).toEqual(['t-3']);
    expect(rankItems('draft', items).map((item) => item.id)).toEqual(['new']);
    expect(rankItems('zzz', items)).toEqual([]);
  });

  test('a label hit outranks a hint hit on the same query', () => {
    const rows: PaletteItem[] = [
      { id: 'a', kind: 'thread', label: 'Something else', hint: 'boite' },
      { id: 'b', kind: 'thread', label: 'Boite release notes', hint: 'notes' }
    ];
    expect(rankItems('boite', rows).map((item) => item.id)).toEqual(['b', 'a']);
  });
});
