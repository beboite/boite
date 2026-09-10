import { describe, expect, test } from 'vitest';
import { isQuitChord, QuitHold } from './quit-hold';

/** A clock and a timer queue the test advances by hand. */
function harness(options: { holdMs?: number; doubleMs?: number } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const quits: number[] = [];
  const holding: boolean[] = [];
  const hold = new QuitHold({
    ...options,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((t) => t.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
    onQuit: () => quits.push(now),
    onHolding: (state) => holding.push(state)
  });
  const advance = (ms: number) => {
    const target = now + ms;
    while (true) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = target;
  };
  return { hold, advance, quits, holding, timers };
}

describe('QuitHold', () => {
  test('a single press shows the hint and quits nothing', () => {
    const { hold, advance, quits, holding } = harness();
    hold.press();
    expect(hold.holding).toBe(true);
    advance(500);
    hold.release();
    advance(5000);
    expect(quits).toEqual([]);
    expect(holding).toEqual([true, false]);
  });

  test('a hold of 1.2 seconds quits, and the hint goes away with it', () => {
    const { hold, advance, quits, holding } = harness();
    hold.press();
    advance(1199);
    expect(quits).toEqual([]);
    advance(1);
    expect(quits).toEqual([1200]);
    expect(hold.holding).toBe(false);
    expect(holding).toEqual([true, false]);
  });

  test('key repeat during the hold neither restarts nor shortens it', () => {
    const { hold, advance, quits, timers } = harness();
    hold.press();
    advance(600);
    hold.press();
    hold.press();
    expect(timers).toHaveLength(1);
    advance(599);
    expect(quits).toEqual([]);
    advance(1);
    expect(quits).toEqual([1200]);
  });

  test('two presses within 500 ms quit at once', () => {
    const { hold, advance, quits } = harness();
    hold.press();
    advance(100);
    hold.release();
    advance(400);
    hold.press();
    expect(quits).toEqual([500]);
  });

  test('two presses 501 ms apart are two single presses', () => {
    const { hold, advance, quits } = harness();
    hold.press();
    advance(100);
    hold.release();
    advance(501);
    hold.press();
    advance(100);
    hold.release();
    advance(5000);
    expect(quits).toEqual([]);
  });

  test('it quits once, and nothing fires after dispose', () => {
    const { hold, advance, quits } = harness();
    hold.press();
    advance(1200);
    hold.press();
    advance(1200);
    expect(quits).toEqual([1200]);

    const second = harness();
    second.hold.press();
    second.hold.dispose();
    second.advance(5000);
    expect(second.quits).toEqual([]);
    expect(second.hold.holding).toBe(false);
  });
});

describe('isQuitChord', () => {
  test('matches Ctrl+Q and Cmd+Q and nothing with Alt or Shift on it', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isQuitChord(key({ key: 'q', ctrlKey: true }))).toBe(true);
    expect(isQuitChord(key({ key: 'Q', metaKey: true }))).toBe(true);
    expect(isQuitChord(key({ key: 'q' }))).toBe(false);
    expect(isQuitChord(key({ key: 'q', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isQuitChord(key({ key: 'q', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isQuitChord(key({ key: 'w', ctrlKey: true }))).toBe(false);
  });
});
