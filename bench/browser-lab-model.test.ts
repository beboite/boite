import { expect, test } from 'bun:test';
import { recoverLabModel } from './browser-lab-model.ts';

test('failed inference replacement remains owned even if replacement initialization fails', async () => {
  const closed: string[] = [];
  const make = (processKey: string, isUsable: boolean, fail = false) => ({ processKey, isUsable,
    close: async () => { closed.push(processKey); },
    initialize: async () => { if (fail) throw new Error('initialization failed'); },
  });
  const state = { current: make('first', true), groups: ['first'] };
  let creations = 0;
  await recoverLabModel(state, () => { creations++; return make('unused', true); });
  expect(creations).toBe(0);
  state.current.isUsable = false;
  await recoverLabModel(state, () => make('second', true));
  expect(closed).toEqual(['first']);
  expect(state.groups).toEqual(['first', 'second']);
  expect(state.current.processKey).toBe('second');
  state.current.isUsable = false;
  await expect(recoverLabModel(state, () => make('third', true, true))).rejects.toThrow('initialization failed');
  expect(state.current.processKey).toBe('third');
  expect(state.groups).toEqual(['first', 'second', 'third']);
  await state.current.close();
  expect(closed).toEqual(['first', 'second', 'third']);
});
