import { expect, test } from 'vitest';
import { outlineEntries, outlineUnfold, outlineWave } from './message-outline';

test('the rail opens around the pointer and stays inside its room', () => {
  const center = (offsets: number[], i: number) => (i + 0.5) * 6 + offsets[i]!;
  for (const at of [0, 3, 27, 41.5, 60]) {
    const offsets = outlineUnfold(10, 6, 14, at);
    for (let i = 1; i < 10; i++) expect(center(offsets, i) - center(offsets, i - 1)).toBeCloseTo(14, 6);
    // The entry under the pointer does not slide away from it.
    const held = Math.min(9, Math.floor(at / 6));
    expect(Math.abs(center(offsets, held) - at)).toBeLessThanOrEqual(7);
  }
  const offsets = outlineUnfold(10, 6, 14, 60, { min: -20, max: 200 });
  expect(center(offsets, 0) - 7).toBeCloseTo(-20, 6);
  expect(center(offsets, 9) + 7).toBeLessThanOrEqual(200);
});

test('the wave peaks under the pointer and fades with distance', () => {
  const wave = outlineWave([7, 21, 35, 49], 21, 20);
  expect(wave[1]).toBe(1);
  expect(wave[0]).toBeCloseTo(wave[2]!, 6);
  expect(wave[2]).toBeGreaterThan(wave[3]!);
});

test('long outlines stay bounded and keep every prompt reachable exactly once', () => {
  for (const count of [0, 1, 8, 13, 14, 200, 1000]) for (const active of [-1, 0, 6, 80, count - 1]) {
    const entries = outlineEntries(count, active);
    expect(entries.length).toBeLessThanOrEqual(13);
    expect(entries.flatMap(entry => Array.from({length:entry.end-entry.start+1},(_,i)=>entry.start+i))).toEqual(Array.from({length:count},(_,i)=>i));
    if (active >= 0 && active < count) expect(entries).toContainEqual({start:active,end:active});
  }
});
