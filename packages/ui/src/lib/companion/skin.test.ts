import { expect, test } from 'vitest';
import { seededRobot } from '../robots';
import { boxPaint, isBox, toBox } from './skin';

test('the classic box wears the theme, a coloured one its jelly with a darker outline', () => {
  expect(boxPaint({ family: 'box', shape: 0, color: 0, eyes: 0, top: 0 })).toEqual({
    body: 'var(--color-surface)', lid: 'var(--color-surface)', line: 'var(--color-foreground)', eye: 'var(--color-foreground)', lit: false, top: 0,
  });
  const paint = boxPaint({ family: 'box', shape: 6, color: 4, eyes: 2, top: 3 });
  expect(paint).toMatchObject({ body: 'var(--jelly-4)', lid: 'var(--jelly-6)', eye: 'var(--robot-halo)', lit: true, top: 3 });
  expect(paint.line).toBe('color-mix(in srgb, var(--jelly-4) 45%, var(--robot-ink))');
  // Ink eyes on a coloured body are the robot ink, not the theme's foreground, which is light in the dark theme.
  expect(boxPaint({ family: 'box', shape: 0, color: 1, eyes: 0, top: 0 }).eye).toBe('var(--robot-ink)');
});

test('only a box is a skin, and any robot becomes a box of its colour', () => {
  const box = seededRobot('mira', 'box');
  expect(isBox(box)).toBe(true);
  expect(isBox(seededRobot('mira'))).toBe(false);
  expect(isBox(null)).toBe(false);
  expect(toBox(box)).toBe(box);
  expect(toBox({ family: 'jelly', shape: 3, color: 5, eyes: 4, top: 7 })).toEqual({ family: 'box', shape: 0, color: 6, eyes: 0, top: 7 });
});
