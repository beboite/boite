import { expect, test } from 'vitest';
import { dragScroll, frameMaxWidth, framePoint, frameQuality, nextPollDelay } from './remote-browser-view';

test('a touch maps through the letterbox to page fractions', () => {
  // A 1000×500 page drawn in a 390×600 box: 390×195, centred with 202.5 px bands above and below.
  const box = { left: 0, top: 100, width: 390, height: 600 }, page = { width: 1000, height: 500 };
  expect(framePoint(box, page, 0, 302.5)).toEqual({ x: 0, y: 0 });
  expect(framePoint(box, page, 390, 497.5)).toEqual({ x: 1, y: 1 });
  expect(framePoint(box, page, 195, 400)).toEqual({ x: 0.5, y: 0.5 });
  expect(framePoint(box, page, 195, 250)).toBeNull();
  expect(framePoint(box, page, 195, 650)).toBeNull();
  // A portrait page after Rotate has its bands on the sides.
  const tall = framePoint({ left: 10, top: 0, width: 390, height: 600 }, { width: 393, height: 700 }, 10 + (390 - 393 * 600 / 700) / 2, 300)!;
  expect(tall.x).toBeCloseTo(0); expect(tall.y).toBeCloseTo(0.5);
  // A 200% preview zoom only grows the box; the fractions stay the same page point.
  expect(framePoint({ left: -500, top: -200, width: 2000, height: 1000 }, page, 500, 300)).toEqual({ x: 0.5, y: 0.5 });
  expect(framePoint({ left: 0, top: 0, width: 0, height: 0 }, page, 0, 0)).toBeNull();
});

test('a drag scrolls the page against the finger, in page pixels, within bounds', () => {
  expect(dragScroll(0, -100, 390, 780)).toEqual({ x: 0, y: 200 });
  expect(dragScroll(50, 0, 390, 390)).toEqual({ x: -50, y: 0 });
  expect(dragScroll(0, -5000, 390, 1366)).toEqual({ x: 0, y: 2000 });
  expect(dragScroll(0, 10, 0, 800)).toEqual({ x: 0, y: -10 });
});

test('frames are sized to the screen and lightened on a slow link', () => {
  expect(frameMaxWidth(390, 3)).toBe(780);
  expect(frameMaxWidth(390, 1)).toBe(390);
  expect(frameMaxWidth(50, 2)).toBe(160);
  expect(frameMaxWidth(4000, 2)).toBe(3840);
  expect(frameMaxWidth(0, 2)).toBeUndefined();
  expect([frameQuality(120), frameQuality(700), frameQuality(2500)]).toEqual([55, 45, 35]);
});

test('polling slows on a still page and backs off while the desktop is away', () => {
  expect(nextPollDelay({ roundTrip: 100, unchanged: 0, failures: 0 })).toBe(300);
  expect(nextPollDelay({ roundTrip: 900, unchanged: 0, failures: 0 })).toBe(500);
  expect(nextPollDelay({ roundTrip: 100, unchanged: 3, failures: 0 })).toBe(800);
  expect(nextPollDelay({ roundTrip: 100, unchanged: 12, failures: 0 })).toBe(1500);
  expect([1, 2, 3, 4, 9].map(failures => nextPollDelay({ roundTrip: 0, unchanged: 0, failures }))).toEqual([1200, 2400, 4800, 8000, 8000]);
});
