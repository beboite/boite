/** The phone viewer's arithmetic, kept out of the component so it can be tested. */

export interface Box { left: number; top: number; width: number; height: number }

/**
 * Where a touch lands on the shared page, from 0 to 1 on each axis. The frame
 * is drawn with `object-fit: contain` inside `box`, so the letterbox bands
 * around it are outside the page. Client coordinates and the box are both CSS
 * pixels of this page, so the phone's pixel ratio and pinch zoom cancel out,
 * and the preview zoom only changes the box.
 */
export function framePoint(box: Box, frame: { width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  if (!(box.width > 0 && box.height > 0 && frame.width > 0 && frame.height > 0)) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale, height = frame.height * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width, y = (clientY - box.top - (box.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** A finger drag turned into page pixels, opposite to the finger like a touch screen, within the contract's bound. */
export function dragScroll(dx: number, dy: number, drawnWidth: number, frameWidth: number): { x: number; y: number } {
  const ratio = drawnWidth > 0 ? frameWidth / drawnWidth : 1, clamp = (n: number) => Math.max(-2000, Math.min(2000, Math.round(n * ratio))) + 0;
  return { x: clamp(-dx), y: clamp(-dy) };
}

/** No more pixels than the screen shows: the drawn width at the phone's density, capped at 2x. */
export function frameMaxWidth(drawnWidth: number, pixelRatio: number): number | undefined {
  if (!(drawnWidth > 0)) return undefined;
  return Math.max(160, Math.min(3840, Math.round(drawnWidth * Math.min(2, Math.max(1, pixelRatio || 1)))));
}

/** A lighter JPEG when frames take long to arrive. */
export function frameQuality(roundTrip: number): number {
  return roundTrip < 400 ? 55 : roundTrip < 1000 ? 45 : 35;
}

export interface PollState {
  /** Milliseconds the last frame took to arrive. */
  roundTrip: number;
  /** Frames in a row identical to the one before: nothing is moving on the page. */
  unchanged: number;
  /** Failed requests in a row. */
  failures: number;
}

/** The shortest gap between two frame requests: the core refuses them closer than 220 ms. */
export const FRAME_INTERVAL = 250;

/**
 * The wait after a frame arrives before asking for the next. One request is in
 * flight at a time, so a slow link is never asked for more than it carries. A
 * moving page asks again as soon as the last frame took FRAME_INTERVAL, with
 * no fixed pause added to the trip: about four frames a second instead of two
 * (bench/remote-browser-frames.ts, docs/performance.md). A still
 * page slows down and a lost desktop is retried with a growing pause.
 */
export function nextPollDelay({ roundTrip, unchanged, failures }: PollState): number {
  if (failures > 0) return Math.min(8000, 1200 * 2 ** Math.min(3, failures - 1));
  const interval = unchanged >= 10 ? 1500 : unchanged >= 3 ? 800 : FRAME_INTERVAL;
  return Math.max(0, Math.round(interval - roundTrip));
}
