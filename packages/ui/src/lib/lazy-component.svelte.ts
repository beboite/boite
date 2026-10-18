/**
 * A component the first screen does not draw, kept in a chunk of its own
 * (`lib/deferred-parts.ts` lists them). `load` fetches it once and `current`
 * holds it once it landed; `components/Deferred.svelte` draws it from there,
 * and `failed` lets the place that waits on it say so and offer a retry.
 */
export class LazyComponent<T> {
  current = $state.raw<T | undefined>(undefined);
  /** The last fetch failed (offline, cold cache) and none is running: the next `load` tries again. */
  failed = $state(false);
  #loading: Promise<T> | undefined;

  constructor(private readonly loader: () => Promise<{ default: T }>) {}

  /** Fetches the chunk once. A call while one runs shares it; a call after a failure starts another. */
  load(): Promise<T> {
    if (this.current !== undefined) return Promise.resolve(this.current);
    if (!this.#loading) {
      this.failed = false;
      this.#loading = this.loader().then(
        (module) => (this.current = module.default),
        (error: unknown) => {
          this.#loading = undefined;
          this.failed = true;
          throw error;
        }
      );
    }
    return this.#loading;
  }
}
