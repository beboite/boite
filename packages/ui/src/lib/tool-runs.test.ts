import { expect, test } from 'vitest';
import type { MessagePart } from '@boite/contracts';
import { partItems } from './tool-runs';

const tool = (name: string, status: 'done' | 'running' | 'error' = 'done'): MessagePart =>
  ({ type: 'tool', toolId: name + Math.random(), name, input: {}, output: '', status }) as MessagePart;
const text = (value: string): MessagePart => ({ type: 'text', text: value }) as MessagePart;
const thinking: MessagePart = { type: 'thinking', text: 'hm' } as MessagePart;

test('three finished calls in a row fold into one item, counted by tool; thinking between them does not break it', () => {
  const parts = [text('look'), tool('Read'), thinking, tool('Grep'), tool('Read'), tool('Edit', 'error'), text('done')];
  expect(partItems(parts, false)).toEqual([
    { kind: 'part', index: 0 },
    { kind: 'tools', indices: [1, 3, 4, 5], names: [['Read', 2], ['Grep', 1], ['Edit', 1]] },
    { kind: 'part', index: 6 }
  ]);
});

test('two calls stay rows, a running call ends a run, and a streaming answer folds nothing', () => {
  expect(partItems([tool('Read'), tool('Grep'), text('x')], false).every((item) => item.kind === 'part')).toBe(true);
  expect(partItems([tool('Read'), tool('Read'), tool('Bash', 'running'), tool('Read')], false).every((item) => item.kind === 'part')).toBe(true);
  expect(partItems([tool('Read'), tool('Read'), tool('Read')], true).every((item) => item.kind === 'part')).toBe(true);
});

test('a plan card is never folded away', () => {
  const plan = { type: 'tool', toolId: 'p', name: 'ExitPlanMode', input: { plan: '# P' }, output: '', status: 'done' } as MessagePart;
  expect(partItems([tool('Read'), tool('Read'), plan, tool('Read')], false).every((item) => item.kind === 'part')).toBe(true);
});
