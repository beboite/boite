import { expect, test } from 'vitest';
import { alignLoop, LOOP_TICK_MS } from './loop-phase';

test('a loop starts on the 60 Hz grid, moved by half a tick at most, and one not playing is left alone', () => {
  const loop = (startTime: number | null) => ({ startTime }) as Animation;
  const late = loop(10 * LOOP_TICK_MS + 7);
  alignLoop(late);
  expect(late.startTime).toBeCloseTo(10 * LOOP_TICK_MS, 9);
  const early = loop(10 * LOOP_TICK_MS - 7);
  alignLoop(early);
  expect(early.startTime).toBeCloseTo(10 * LOOP_TICK_MS, 9);
  // A paused loop has no start: it gets one, on the grid again, when it resumes.
  const paused = loop(null);
  alignLoop(paused);
  expect(paused.startTime).toBeNull();
});
