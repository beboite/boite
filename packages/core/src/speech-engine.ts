/**
 * The one resident engine of a kind: whisper-server, or the native decoder.
 * Starting, replacing and stopping it are admitted one at a time, so a
 * request for one model never gets an engine a request for another model
 * started meanwhile, and a stop never leaves an engine running beside the one
 * that replaced it. Requests to a running engine are not serialised here.
 */
export class EngineSlot<E extends { key: string }> {
  current: E | null = null;
  #admission: Promise<unknown> = Promise.resolve();

  /** `halt` stops an engine and resolves once its process exited. */
  constructor(private readonly halt: (engine: E) => Promise<void>) {}

  /**
   * The engine for `key`: the running one if `usable`, else one `start`
   * makes once the previous one stopped.
   */
  acquire(key: string, start: () => E, usable: (engine: E) => boolean = () => true): Promise<E> {
    return this.#admit(async () => {
      if (this.current !== null && (this.current.key !== key || !usable(this.current))) await this.#halt(this.current);
      this.current ??= start();
      return this.current;
    });
  }

  /** Stops the engine, or only `engine` when it is still the one running once the stop is admitted. */
  stop(engine?: E): Promise<void> {
    return this.#admit(async () => {
      if (this.current !== null && (engine === undefined || this.current === engine)) await this.#halt(this.current);
    });
  }

  /** An engine that ended by itself leaves the slot, unless another took it already. */
  vacate(engine: E): boolean {
    if (this.current !== engine) return false;
    this.current = null;
    return true;
  }

  async #halt(engine: E): Promise<void> {
    this.current = null;
    await this.halt(engine);
  }

  #admit<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#admission.then(step);
    this.#admission = run.catch(() => undefined);
    return run;
  }
}
