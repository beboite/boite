import { describe, expect, test } from 'vitest';
import { FITTED, MAX_SCALE, bounded, dragAxis, dragFade, isDoubleTap, released, toggledZoom, zoomAround } from './viewer-gestures';

const phone = { width: 390, height: 760 };
/** A portrait screenshot fitted to that stage. */
const shot = { width: 350, height: 728 };

describe('the zoom', () => {
  test('zooming around a point keeps that point under the fingers', () => {
    const focus = { x: 100, y: -50 };
    const zoomed = zoomAround(FITTED, 2, focus);
    expect(zoomed).toEqual({ scale: 2, x: -100, y: 50 });
    // The picture's point under the focus is the same before and after: (focus - offset) / scale.
    expect((focus.x - zoomed.x) / zoomed.scale).toBe(focus.x);
    expect((focus.y - zoomed.y) / zoomed.scale).toBe(focus.y);
    const back = zoomAround(zoomed, 1, focus);
    expect(back).toEqual({ scale: 1, x: 0, y: 0 });
  });

  test('a double tap zooms to 2 where it landed and a second one fits again', () => {
    const zoomed = toggledZoom(FITTED, { x: 40, y: 0 });
    expect(zoomed).toEqual({ scale: 2, x: -40, y: 0 });
    expect(toggledZoom(zoomed, { x: 0, y: 0 })).toEqual(FITTED);
  });

  test('the zoom stays between fitted and four times, and the pan never shows past the edge', () => {
    expect(bounded({ scale: 0.4, x: 30, y: 30 }, shot, phone)).toEqual(FITTED);
    expect(bounded({ scale: 9, x: 0, y: 0 }, shot, phone).scale).toBe(MAX_SCALE);
    // At 2x the picture is 700 x 1456: it may move 155 px sideways and 348 px up or down.
    expect(bounded({ scale: 2, x: 500, y: -900 }, shot, phone)).toEqual({ scale: 2, x: 155, y: -348 });
    expect(bounded({ scale: 2, x: -20, y: 10 }, shot, phone)).toEqual({ scale: 2, x: -20, y: 10 });
  });
});

describe('a finger on a fitted picture', () => {
  test('the drag takes an axis once past the slop, and upwards is nothing', () => {
    expect(dragAxis(4, 3)).toBeNull();
    expect(dragAxis(-40, 10)).toBe('x');
    expect(dragAxis(5, 60)).toBe('y');
    expect(dragAxis(5, -60)).toBeNull();
  });

  test('a long or quick swipe moves to the next or previous picture, a short slow one springs back', () => {
    expect(released('x', -130, 0, 600, phone)).toBe('next');
    expect(released('x', 130, 0, 600, phone)).toBe('previous');
    expect(released('x', -50, 0, 60, phone)).toBe('next');
    expect(released('x', -50, 0, 600, phone)).toBe('stay');
  });

  test('a drag down far or fast enough closes, and the viewer fades as it goes', () => {
    expect(released('y', 0, 170, 600, phone)).toBe('close');
    expect(released('y', 0, 60, 50, phone)).toBe('close');
    expect(released('y', 0, 60, 600, phone)).toBe('stay');
    expect(dragFade(0, phone)).toBe(0);
    expect(dragFade(228, phone)).toBeCloseTo(0.5);
    expect(dragFade(5000, phone)).toBe(0.85);
  });

  test('two taps close in time and place make a double tap', () => {
    expect(isDoubleTap(null, { x: 0, y: 0, at: 0 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, at: 0 }, { x: 10, y: 10, at: 200 })).toBe(true);
    expect(isDoubleTap({ x: 0, y: 0, at: 0 }, { x: 10, y: 10, at: 500 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, at: 0 }, { x: 80, y: 0, at: 200 })).toBe(false);
  });
});
