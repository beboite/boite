import { expect, test } from 'vitest';
import { outlineEntries } from './message-outline';

test('long outlines stay bounded and keep every prompt reachable exactly once', () => {
  for (const count of [0, 1, 8, 13, 14, 200, 1000]) for (const active of [-1, 0, 6, 80, count - 1]) {
    const entries = outlineEntries(count, active);
    expect(entries.length).toBeLessThanOrEqual(13);
    expect(entries.flatMap(entry => Array.from({length:entry.end-entry.start+1},(_,i)=>entry.start+i))).toEqual(Array.from({length:count},(_,i)=>i));
    if (active >= 0 && active < count) expect(entries).toContainEqual({start:active,end:active});
  }
});
