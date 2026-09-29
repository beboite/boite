import type { BackgroundTask } from '@boite/contracts';
import { fill, strings } from './strings';

/** `1 shell still running`, `2 shells, 1 monitor still running`; empty for no task. */
export function backgroundLabel(kinds: readonly BackgroundTask['kind'][]): string {
  if (kinds.length === 0) return '';
  const counts = new Map<BackgroundTask['kind'], number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const pieces = [...counts].map(([kind, count]) => fill(count === 1 ? strings.chat.backgroundOne[kind] : strings.chat.backgroundMany[kind], { count: String(count) }));
  return fill(strings.chat.backgroundRunning, { what: pieces.join(strings.chat.backgroundJoin) });
}
