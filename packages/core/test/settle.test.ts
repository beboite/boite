import { expect, test } from 'bun:test';
import { rejection, thrown } from './settle.ts';

test('a promise that resolves fails both helpers, as the rejects matcher did', async () => {
  const resolved = await thrown(Promise.resolve('fine'));
  expect(() => expect(resolved).toThrow()).toThrow();
  expect(await thrown(rejection(Promise.resolve('fine')))).toThrow('expected the promise to reject, it resolved with "fine"');
  expect(await thrown(Promise.reject(new TypeError('refused: no access')))).toThrow(/refused/);
  expect(await thrown(Promise.reject(new TypeError('refused')))).toThrow(TypeError);
});

test('a thenable reason comes back as itself, not adopted', async () => {
  let adopted = false;
  const reason = { then(resolve: (value: unknown) => void) { adopted = true; resolve('adopted'); } };
  expect((await rejection(Promise.reject(reason))).reason).toBe(reason);
  expect(adopted).toBe(false);
});

test('a function the promise rejected with is called, as the rejects matcher calls it', async () => {
  const returns = await thrown(Promise.reject(() => 'refused'));
  expect(() => expect(returns).toThrow()).toThrow();
  expect(await thrown(Promise.reject(() => { throw new Error('inner'); }))).toThrow('inner');
});
