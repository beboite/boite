import { expect, test } from 'vitest';
import { BLOCK_GAP, GAP, PART_GAP, gapChanged, slotGap } from './message-window';

test('a measured slot carries the gap its row keeps above it, and a changed seam asks for a new measure', () => {
  expect(slotGap(null, false)).toBe(GAP);
  expect(slotGap(null, true)).toBe(BLOCK_GAP);
  expect(slotGap('block', false)).toBe(BLOCK_GAP);
  expect(slotGap('part', false)).toBe(PART_GAP);
  const node = document.createElement('article');
  // Never measured: nothing to correct yet.
  expect(gapChanged(node, 'part', false)).toBe(false);
  node.dataset['gap'] = String(GAP);
  // An older page landed above: the row now joins the message over it.
  expect(gapChanged(node, 'part', false)).toBe(true);
  expect(gapChanged(node, null, false)).toBe(false);
});
