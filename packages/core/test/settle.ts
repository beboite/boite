// Under `bun test`, `expect(promise).rejects` and `.resolves` run a nested event loop tick that
// can drop the outer tick's socket events on macOS (docs/development.md#promise-matchers-under-bun-test).
// Await the promise first, then match: `expect(await thrown(promise)).toThrow(message)`,
// `expect(await rejection(promise)).toMatchObject(shape)`, `expect(await promise).toEqual(value)`.

/** Settles `promise`; the function returned rethrows its rejection, or returns if it resolved. */
export async function thrown(promise: PromiseLike<unknown>): Promise<() => void> {
  try {
    await promise;
  } catch (error) {
    return () => {
      throw error;
    };
  }
  return () => {};
}

/** The reason `promise` rejected with. Throws if it resolved. */
export async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  let value: unknown;
  try {
    value = await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`expected the promise to reject, it resolved with ${Bun.inspect(value)}`);
}
