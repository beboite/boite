/**
 * The arithmetic behind the media viewer's gestures, apart from the DOM so it
 * can be tested: a zoom that keeps the point under the fingers where it is, a
 * pan that never shows past the picture's edge, and what a released swipe or
 * drag means.
 */

/** The picture's zoom (1 = fitted to the stage) and its offset from the stage's centre, in pixels. */
export interface View { scale: number; x: number; y: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

export const MAX_SCALE = 4;
/** What a double tap zooms to. */
export const TAP_SCALE = 2;
export const FITTED: View = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The view brought back inside its bounds: a zoom between 1 and `MAX_SCALE`,
 * and an offset that keeps the picture's edges outside the stage once it is
 * larger than the stage, centred while it is smaller.
 */
export function bounded(view: View, fitted: Size, stage: Size): View {
  const scale = clamp(view.scale, 1, MAX_SCALE);
  const limitX = Math.max(0, (fitted.width * scale - stage.width) / 2);
  const limitY = Math.max(0, (fitted.height * scale - stage.height) / 2);
  return { scale, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) };
}

/** `view` zoomed to `scale` around `focus`, a point given from the stage's centre. */
export function zoomAround(view: View, scale: number, focus: Point): View {
  const ratio = scale / view.scale;
  return { scale, x: focus.x - (focus.x - view.x) * ratio, y: focus.y - (focus.y - view.y) * ratio };
}

/** A double tap zooms in where it landed, or back to fitted when already zoomed. */
export function toggledZoom(view: View, focus: Point): View {
  return view.scale > 1 ? FITTED : zoomAround(view, TAP_SCALE, focus);
}

export interface Tap { x: number; y: number; at: number }

/** Two taps close in time and place: the second one zooms. */
export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  return previous !== null && tap.at - previous.at < 320 && Math.hypot(tap.x - previous.x, tap.y - previous.y) < 32;
}

/** A finger that moved less than this is a tap, not a drag. */
export const SLOP = 10;

/**
 * Which way a one-finger drag goes on a fitted picture, decided once it left
 * the slop: sideways to the next picture, downwards to close. Upwards is
 * nothing, so a scroll habit does not close the viewer.
 */
export function dragAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < SLOP) return null;
  if (Math.abs(dx) > Math.abs(dy)) return 'x';
  return dy > 0 ? 'y' : null;
}

export type Released = 'next' | 'previous' | 'close' | 'stay';

/**
 * What a released drag does: far enough, or flicked fast enough, it moves to
 * the next picture or closes; otherwise the picture springs back.
 */
export function released(axis: 'x' | 'y', dx: number, dy: number, ms: number, stage: Size): Released {
  const time = Math.max(ms, 1);
  if (axis === 'x') {
    const far = Math.abs(dx) > Math.min(120, stage.width * 0.25);
    const flicked = Math.abs(dx) > 30 && Math.abs(dx) / time > 0.5;
    return far || flicked ? (dx < 0 ? 'next' : 'previous') : 'stay';
  }
  const far = dy > Math.min(160, stage.height * 0.2);
  const flicked = dy > 40 && dy / time > 0.6;
  return far || flicked ? 'close' : 'stay';
}

/** How faded the viewer is while dragged down by `dy`: 0 untouched, towards 1 as it nears closing. */
export function dragFade(dy: number, stage: Size): number {
  return clamp(dy / Math.max(stage.height * 0.6, 1), 0, 0.85);
}
