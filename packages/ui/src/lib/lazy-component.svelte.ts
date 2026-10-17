/**
 * A component the first screen does not draw, kept in a chunk of its own
 * (`lib/deferred-parts.ts` lists them). `load` fetches it once and `current`
 * holds it once it landed; `components/Deferred.svelte` draws it from there.
 */
export class LazyComponent<T> {
  current = $state.raw<T | undefined>(undefined);
  #loading: Promise<T> | undefined;

  constructor(private readonly loader: () => Promise<{ default: T }>) {}

  /** Fetches the chunk once. A failed fetch (offline, cold cache) is tried again on the next ask. */
  load(): Promise<T> {
    if (this.current !== undefined) return Promise.resolve(this.current);
    this.#loading ??= this.loader().then(
      (module) => (this.current = module.default),
      (error: unknown) => {
        this.#loading = undefined;
        throw error;
      }
    );
    return this.#loading;
  }
}
