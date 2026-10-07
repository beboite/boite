/** A deep reactive copy of `value`, as the store holds its messages: what a component test mutates. */
export function reactive<T extends object>(value: T): T {
  const held = $state(value);
  return held;
}
