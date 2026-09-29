import { untrack } from 'svelte';
import type { Machine } from './workspace.svelte';
import { SyncFailure, syncSettings, type SyncReport } from './settings-sync';
import { fill, strings } from './strings';

const STORAGE_KEY = 'boite.settings-sync';

/** Saved one-way copies. Execution on either core never depends on this client. */
export class AutoSettingsSync {
  links = $state.raw<Record<string, string>>({});
  reports = $state<Record<string, { source: string; report: SyncReport }>>({});
  busy = $state<Record<string, boolean>>({});

  private failures = new Map<string, string>();
  private copies = new Map<string, Promise<void>>();

  constructor(private machines: () => Machine[], private key: (machine: Machine) => string) {}

  source(target: Machine): Machine | undefined {
    const key = this.links[this.key(target)];
    return this.machines().find(machine => this.key(machine) === key);
  }

  enabled(target: Machine): boolean { return !!this.links[this.key(target)]; }

  canEnable(source: Machine, target: Machine): boolean {
    if (source === target) return false;
    const targetKey = this.key(target);
    let next: string | undefined = this.key(source);
    const seen = new Set<string>();
    while (next) {
      if (next === targetKey || seen.has(next)) return false;
      seen.add(next);
      next = this.links[next];
    }
    return true;
  }

  set(target: Machine, source: Machine | null): void {
    if (source && !this.canEnable(source, target)) return;
    const links = { ...this.links };
    if (source) links[this.key(target)] = this.key(source);
    else delete links[this.key(target)];
    this.links = links;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(links)); } catch { /* session only */ }
  }

  forget(machine: Machine): void {
    const key = this.key(machine);
    this.links = Object.fromEntries(Object.entries(this.links).filter(([target, source]) => target !== key && source !== key));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.links)); } catch { /* session only */ }
    delete this.reports[machine.id];
  }

  /** Runs for the whole window, including chat, with new copies after reconnects. */
  start(): () => void {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      this.links = saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([target, source]) => typeof source === 'string' && source !== target)) : {};
    } catch { this.links = {}; }
    return $effect.root(() => {
      $effect(() => {
        const machines = this.machines();
        const pairs = Object.entries(this.links).map(([targetKey, sourceKey]) => ({
          target: machines.find(machine => this.key(machine) === targetKey),
          source: machines.find(machine => this.key(machine) === sourceKey)
        })).filter(pair => pair.source && pair.target && this.canEnable(pair.source, pair.target));
        // Track reconnects and client replacement, without watching our own writes.
        const ready = pairs.filter(({ source, target }) =>
          source!.store.owner && target!.store.owner && source!.store.connection === 'ready'
          && target!.store.connection === 'ready' && source!.store.client && target!.store.client);
        const dispose = untrack(() => ready.map(({ source, target }) => this.follow(source!, target!)));
        return () => dispose.forEach(stop => stop());
      });
    });
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    const copy = (this.copies.get(key) ?? Promise.resolve()).then(run);
    this.copies.set(key, copy);
    void copy.finally(() => { if (this.copies.get(key) === copy) this.copies.delete(key); });
  }

  private follow(source: Machine, target: Machine): () => void {
    const from = source.store.client!, to = target.store.client!;
    const abort = new AbortController();
    let stopped = false, pending = false, running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      timer = undefined;
      if (stopped || running) return;
      running = true;
      this.busy[target.id] = true;
      try {
        do {
          pending = false;
          const report = await syncSettings(
            { client: from, providers: source.store.providers, accounts: source.store.accounts },
            { client: to, providers: target.store.providers, accounts: target.store.accounts }, abort.signal
          );
          if (stopped) break;
          target.store.settings = report.settings;
          if (report.keybindings) target.store.keybindings = report.keybindings;
          this.reports[target.id] = { source: source.label, report };
          if (target.store.error === this.failures.get(target.id)) target.store.error = null;
          this.failures.delete(target.id);
        } while (pending && !stopped);
      } catch (error) {
        if (!stopped) {
          const message = error instanceof Error ? error.message : String(error);
          target.store.error = error instanceof SyncFailure
            ? fill(strings.machines.syncStopped, { stage: strings.machines.syncStages[error.stage], error: message }) : message;
          this.failures.set(target.id, target.store.error);
        }
      } finally {
        running = false;
        this.busy[target.id] = false;
        if (pending && !stopped) schedule();
      }
    };
    const schedule = () => {
      if (stopped) return;
      pending = true;
      if (!running && timer === undefined) timer = setTimeout(() => this.enqueue(this.key(target), run), 100);
    };
    const off = [from.on('settings.updated', schedule), from.on('keybindings.updated', schedule), from.on('brain.configured', schedule)];
    schedule();
    return () => {
      stopped = true;
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      off.forEach(stop => stop());
    };
  }
}
