import { expect, test } from 'bun:test';
import { screenTurns, takeTurn } from '../src/browser/frames.ts';

// A scaled capture puts back the page size it found when its shot ends. On a
// loaded Windows runner one ran past the 5 s that lets the next capture go, a
// preset started under it, and the capture then undid the preset: the page
// read 1264 x 705 instead of 393 x 852 (browser-sharing test, 2026-10-15).
test('a size change waits for a capture that runs late, while the next capture may go', async () => {
  const turns = screenTurns();
  const order: string[] = [];
  let finishCapture!: () => void;
  const stuck = takeTurn(turns, false, () => new Promise<void>(resolve => { order.push('capture start'); finishCapture = () => { order.push('capture end'); resolve(); }; }), 30);
  const resize = takeTurn(turns, true, async () => { order.push('resize'); }, 30);
  const after = takeTurn(turns, false, async () => { order.push('capture after resize'); }, 30);
  await Bun.sleep(120);
  // Late by four times the allowance: still nothing changes the size under it.
  expect(order).toEqual(['capture start']);
  finishCapture();
  await Promise.all([stuck, resize, after]);
  expect(order).toEqual(['capture start', 'capture end', 'resize', 'capture after resize']);

  // Captures alone still pass a late one, so frames never freeze behind it.
  order.length = 0;
  let release!: () => void;
  const late = takeTurn(turns, false, () => new Promise<void>(resolve => { release = resolve; }), 30);
  const next = takeTurn(turns, false, async () => { order.push('next capture'); }, 30);
  await next;
  expect(order).toEqual(['next capture']);
  release();
  await late;
});
