import { describe, expect, test, vi } from 'vitest';
import type { Message } from '@boite/contracts';
import { RangeAsk, gapHeight, wantedRange, withGaps } from './history-gaps';
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
    const load = vi.fn();
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
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
    // Cancelled before its frame, by the effect running again.
    ask.soon(() => ({ top: 80, range: { from: 0, limit: 120 } }), load)();
    await frame();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
