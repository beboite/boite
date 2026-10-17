import { describe, expect, test, vi } from 'vitest';
import type { Message } from '@boite/contracts';
import { RangeAsk, gapHeight, loadKeepingReader, rowOnScreen, wantedRange, withGaps } from './history-gaps';
import { TimelineRows } from './timeline-rows';
import { ESTIMATE } from './message-window';

function message(id: string, createdAt: number, role: Message['role'] = 'user'): Message {
  return { id, threadId: 't', turnId: id, role, parts: [{ type: 'text', text: id }], state: 'complete', createdAt };
}

describe('history gaps', () => {
  test('a gap row goes after the rows of the messages held above it, and a card from the stretch waits below it', () => {
    const held = [message('m-40', 40), message('m-41', 41), message('m-90', 90)];
    // A card written while messages 42 to 89 were going on sorts between m-41 and m-90.
    const card = message('workflow:run', 60, 'system');
    const rows = new TimelineRows().build([held[0]!, held[1]!, card, held[2]!]);
    const gaps = new Map([['m-40', { from: 0, count: 40 }], ['m-90', { from: 42, count: 48 }]]);
    const placed = withGaps(rows, held, gaps);
    expect(placed.rows.map((row) => row.id)).toEqual(['gap:0:40', 'm-40', 'm-41', 'gap:42:48', 'workflow:run', 'm-90']);
    expect(placed.gaps).toEqual([{ index: 0, from: 0, count: 40 }, { index: 3, from: 42, count: 48 }]);
    // Indices of the rows before the gaps went in, after.
    expect([0, 1, 2, 3].map(placed.at)).toEqual([1, 2, 4, 5]);
    // No gap, the very same rows.
    expect(withGaps(rows, held, new Map()).rows).toBe(rows);
  });

  test('the page asked for is the stretch on screen, or the one beside what is held', () => {
    const total = [0, gapHeight(280)];
    const gaps = [{ index: 0, from: 0, count: 280 }];
    const bottom = gapHeight(280);
    // Scrolling up into the gap: the page right above the first message held.
    expect(wantedRange(total, gaps, bottom - 500, bottom + 1_000, 120)).toEqual({ from: 160, limit: 120 });
    // Dragged to the top: the thread's first page.
    expect(wantedRange(total, gaps, -800, 1_800, 120)).toEqual({ from: 0, limit: 120 });
    // Dropped in the middle: the stretch on screen.
    const middle = 140 * ESTIMATE;
    const asked = wantedRange(total, gaps, middle - 1_000, middle + 1_000, 120)!;
    expect(asked.from).toBeLessThanOrEqual(140 - 12);
    expect(asked.from + asked.limit).toBeGreaterThanOrEqual(140 + 12);
    // Away from every gap: nothing.
    expect(wantedRange(total, gaps, bottom + 2_000, bottom + 3_000, 120)).toBeNull();
    // A gap shorter than a page is asked for whole.
    expect(wantedRange([0, gapHeight(30)], [{ index: 0, from: 5, count: 30 }], 0, 500, 120)).toEqual({ from: 5, limit: 30 });
  });

  test('a range is asked a frame later with the view as it is then, once per place the reader stands', async () => {
    const ask = new RangeAsk();
    const load = vi.fn(async () => 1);
    const frame = () => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => setTimeout(resolve, 0)), 0));
    let view: { top: number; range: { from: number; limit: number } | null } | null = { top: 0, range: { from: 0, limit: 120 } };
    ask.soon(() => view, load);
    // The list scrolled itself away before the frame: nothing is asked.
    view = null;
    await frame();
    expect(load).not.toHaveBeenCalled();
    view = { top: 0, range: { from: 0, limit: 120 } };
    ask.soon(() => view, load);
    await frame();
    ask.soon(() => view, load);
    await frame();
    expect(load).toHaveBeenCalledTimes(1);
    view = { top: 40, range: { from: 0, limit: 120 } };
    ask.soon(() => view, load);
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
    // Dropped before its frame, with the list.
    ask.soon(() => ({ top: 80, range: { from: 0, limit: 120 } }), load);
    ask.stop();
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a page that lands nothing is asked again after a pause that grows, never every frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      const ask = new RangeAsk();
      const load = vi.fn(async () => 0);
      const view = () => ({ top: 0, range: { from: 0, limit: 120 } });
      ask.soon(view, load);
      await vi.advanceTimersByTimeAsync(20);
      expect(load).toHaveBeenCalledTimes(1);
      // The effect runs again at once (the flight ended): nothing before the second.
      ask.soon(view, load);
      await vi.advanceTimersByTimeAsync(900);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(load).toHaveBeenCalledTimes(2);
      ask.soon(view, load);
      await vi.advanceTimersByTimeAsync(1_900);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('two stretches around a message that draws no row keep a row each', () => {
    const held = [message('m-10', 10), message('m-20', 20), message('m-30', 30)];
    // m-20 draws nothing of its own (folded into a group): its rows are those of m-10 and m-30 only.
    const rows = new TimelineRows().build([held[0]!, held[2]!]);
    const gaps = new Map([['m-20', { from: 11, count: 9 }], ['m-30', { from: 21, count: 9 }]]);
    expect(withGaps(rows, held, gaps).rows.map((row) => row.id)).toEqual(['m-10', 'gap:11:9', 'gap:21:9', 'm-30']);
  });

  test('a page landing above the reader moves the view by what the row drifted on screen, and only then', async () => {
    const view = document.createElement('div');
    const row = document.createElement('article');
    row.dataset['mid'] = 'm-2';
    view.append(row);
    let rowTop = 20;
    view.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 80 }) as DOMRect;
    expect(rowOnScreen(view)).toEqual({ id: 'm-2', offset: 20 });
    const moved = vi.fn();
    // The rows drawn above it pushed it 340 px down, and nothing anchored it: the view follows.
    expect(await loadKeepingReader(async (landing) => { landing(); rowTop = 360; return 3; }, () => view, async () => {}, moved)).toBe(3);
    expect(view.scrollTop).toBe(340);
    // Anchored by the browser already: nothing moves.
    expect(await loadKeepingReader(async (landing) => { landing(); return 3; }, () => view, async () => {}, moved)).toBe(3);
    expect(moved).toHaveBeenCalledTimes(1);
  });
});
