import { expect, test } from 'bun:test';
import { rejection, thrown } from './settle.ts';

test('a promise that resolves fails both helpers, as the rejects matcher did', async () => {
  const resolved = await thrown(Promise.resolve('fine'));
  expect(() => expect(resolved).toThrow()).toThrow();
  expect(await thrown(rejection(Promise.resolve('fine')))).toThrow('expected the promise to reject, it resolved with "fine"');
  const reason = { code: 'refused' };
  expect(await rejection(Promise.reject(reason))).toBe(reason);
  expect(await thrown(Promise.reject(new TypeError('refused: no access')))).toThrow(/refused/);
  expect(await thrown(Promise.reject(new TypeError('refused')))).toThrow(TypeError);
});
