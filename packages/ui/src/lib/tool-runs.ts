import type { MessagePart } from '@boite/contracts';
import { planOf } from './plan';

/** Below this many calls in a row, the rows say more than a count would. */
export const RUN_MIN = 3;

export type PartItem = { kind: 'part'; index: number } | { kind: 'tools'; indices: number[]; names: [string, number][] };

function foldable(part: MessagePart | undefined): part is Extract<MessagePart, { type: 'tool' }> {
  return part?.type === 'tool' && part.status !== 'running' && planOf(part.name, part.input) === null;
}

/**
 * The parts of a finished message, with each run of RUN_MIN or more finished
 * tool calls in a row gathered into one item. Thinking between two calls does
 * not break a run, since it draws nothing there. A running call, a plan, a
 * question or text ends the run. `names` counts each tool, most used first.
 */
export function partItems(parts: readonly MessagePart[], streaming: boolean): PartItem[] {
  const items: PartItem[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= RUN_MIN) {
      const counts = new Map<string, number>();
      for (const index of run) {
        const name = (parts[index] as Extract<MessagePart, { type: 'tool' }>).name;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      items.push({ kind: 'tools', indices: run, names: [...counts].sort((a, b) => b[1] - a[1]) });
    } else {
      for (const index of run) items.push({ kind: 'part', index });
    }
    run = [];
  };
  parts.forEach((part, index) => {
    if (part.type === 'thinking') return;
    if (!streaming && foldable(part)) {
      run.push(index);
      return;
    }
    flush();
    items.push({ kind: 'part', index });
  });
  flush();
  return items;
}
