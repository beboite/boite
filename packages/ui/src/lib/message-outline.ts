export interface OutlineEntry { start: number; end: number }

/** Keep endpoints and the reading neighbourhood; group distant prompts. */
export function outlineEntries(count: number, active: number): OutlineEntry[] {
  if (count <= 13) return Array.from({ length: count }, (_, start) => ({ start, end: start }));
  const center = Math.max(0, Math.min(count - 1, active < 0 ? count - 1 : active));
  const first = Math.max(1, Math.min(count - 8, center - 3));
  const last = Math.min(count - 2, first + 6);
  const entries: OutlineEntry[] = [{ start: 0, end: 0 }];
  if (first > 1) entries.push({ start: 1, end: first - 1 });
  for (let index = first; index <= last; index++) entries.push({ start: index, end: index });
  if (last < count - 2) entries.push({ start: last + 1, end: count - 2 });
  entries.push({ start: count - 1, end: count - 1 });
  return entries;
}
