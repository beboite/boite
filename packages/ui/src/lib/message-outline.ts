export interface OutlineEntry { start: number; end: number }

/**
 * How far each of `count` entries moves when the rail opens from `pitch` to
 * `open` px per entry around `at`, in px from the top of the rail at rest. The
 * point under `at` stays put unless the open rail would leave `room`.
 */
export function outlineUnfold(count: number, pitch: number, open: number, at: number, room?: { min: number; max: number }): number[] {
  const anchor = Math.max(0, Math.min(count * pitch, at));
  const scale = open / pitch;
  const top = anchor - anchor * scale;
  let shift = 0;
  if (room) {
    if (top + count * open > room.max) shift = room.max - top - count * open;
    if (top + shift < room.min) shift = room.min - top;
  }
  return Array.from({ length: count }, (_, index) => ((index + 0.5) * pitch - anchor) * (scale - 1) + shift);
}

/** The dock wave: 1 for the bar at `at`, fading over `reach` px. It widens bars and never moves them. */
export function outlineWave(centers: number[], at: number, reach: number): number[] {
  return centers.map(center => Math.exp(-((center - at) ** 2) / (2 * reach * reach)));
}

/** Keep endpoints and the reading neighbourhood; group distant prompts. */
export function outlineEntries(count: number, active: number): OutlineEntry[] {
  if (count <= 13) return Array.from({ length: count }, (_, start) => ({ start, end: start }));
  const center = Math.max(0, Math.min(count - 1, active < 0 ? count - 1 : active));
  // Eleven slots wherever the window sits: moving it never moves the entry a pointer is aiming at.
  let first = center - 3;
  let last = first + 6;
  if (first <= 1) { first = 1; last = 8; }
  else if (last >= count - 2) { last = count - 2; first = count - 9; }
  const entries: OutlineEntry[] = [{ start: 0, end: 0 }];
  if (first > 1) entries.push({ start: 1, end: first - 1 });
  for (let index = first; index <= last; index++) entries.push({ start: index, end: index });
  if (last < count - 2) entries.push({ start: last + 1, end: count - 2 });
  entries.push({ start: count - 1, end: count - 1 });
  return entries;
}
