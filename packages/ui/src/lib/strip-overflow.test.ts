import { expect, test } from 'vitest';
import { stripOverflows } from './strip-overflow';

test('the chevrons come when the tabs overflow and go once the tabs fit without them', () => {
  // 480 px of tabs in 470 px: overflow, the chevrons (2 x 26 px and gaps, 56 px) appear.
  expect(stripOverflows(480, 470, 56, false)).toBe(true);
  // The panel grows by 30 px: 444 px beside the chevrons, 500 px without them.
  // The tabs fit in 500, so the chevrons go; the narrowed box alone said 36 px of overflow.
  expect(stripOverflows(480, 444, 56, true)).toBe(false);
  expect(480 - 444 > 1).toBe(true);
  // Still too wide once the chevrons are gone: they stay.
  expect(stripOverflows(520, 444, 56, true)).toBe(true);
  // A pixel of rounding is no overflow.
  expect(stripOverflows(471, 470, 56, false)).toBe(false);
});
