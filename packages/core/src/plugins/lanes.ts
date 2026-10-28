import { refused } from '../errors.ts';

/** What holds a plugin alone: it rewrites or deletes the plugin's files. */
export type PluginRewrite = 'install' | 'uninstall';

const VERB: Record<PluginRewrite, string> = { install: 'installed', uninstall: 'uninstalled' };

/**
 * Who may touch one plugin's files and processes. An install or an uninstall
 * holds the plugin alone; app, gateway, autostart and account commands share
 * it with each other, and the supervisors keep their own order among those.
 * Admission is decided before the first await of an operation, so two of
 * them can never both read the directory as theirs.
 */
export class PluginLanes {
  readonly #alone = new Map<string, { kind: PluginRewrite; done: Promise<unknown> }>();
  readonly #shared = new Map<string, number>();

  /** The rewrite holding the plugin, if one does. */
  rewrite(id: string): PluginRewrite | null {
    return this.#alone.get(id)?.kind ?? null;
  }

  busy(id: string): boolean {
    return this.#alone.has(id) || (this.#shared.get(id) ?? 0) > 0;
  }

  /** Refuses when a rewrite holds the plugin: what an app, gateway or account command checks first. */
  assertUsable(id: string): void {
    const kind = this.rewrite(id);
    if (kind !== null) throw refused(`Wait for ${id} to be ${VERB[kind]}.`, { id, operation: kind });
  }

  /**
   * Runs `work` holding the plugin alone. It refuses, synchronously, while
   * any other operation holds it; `work` starts in the same tick, after the
   * plugin is marked.
   */
  alone<T>(id: string, kind: PluginRewrite, work: () => Promise<T>, refusal: string): Promise<T> {
    if (this.busy(id)) throw refused(refusal, { id, operation: this.rewrite(id) ?? 'command' });
    const entry: { kind: PluginRewrite; done: Promise<unknown> } = { kind, done: Promise.resolve() };
    this.#alone.set(id, entry);
    const run = (async () => {
      try {
        return await work();
      } finally {
        if (this.#alone.get(id) === entry) this.#alone.delete(id);
      }
    })();
    entry.done = run.catch(() => undefined);
    return run;
  }

  /** Runs `work` beside the other commands of the plugin, refused while a rewrite holds it. */
  async shared<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.assertUsable(id);
    this.#shared.set(id, (this.#shared.get(id) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const count = (this.#shared.get(id) ?? 1) - 1;
      if (count > 0) this.#shared.set(id, count);
      else this.#shared.delete(id);
    }
  }

  /** Every rewrite still running, for shutdown to wait on. */
  rewrites(): Promise<unknown>[] {
    return [...this.#alone.values()].map((entry) => entry.done);
  }
}
