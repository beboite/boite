import { errorText } from './errors';
import { untrack } from 'svelte';
import type { Machine } from './workspace.svelte';
import type { SyncReport } from './settings-sync';
import { GroupLinks } from './group-links.svelte';
import { fill, strings } from './strings';

/** Where the one-way copies of an earlier version were saved, one window at a time. */
const RETIRED_KEY = 'boite.settings-sync';

/**
 * Every machine of a group follows the settings home its group chose
 * (`Group.settingsHome`): the same choice on every member, so every window
 * shows it. A window that owns both machines makes the copy whenever the home
 * changes and after each reconnect. Execution on either core never depends on
 * this client.
 */
export class AutoSettingsSync {
  reports = $state<Record<string, { source: string; report: SyncReport }>>({});
  busy = $state<Record<string, boolean>>({});

  private failures = new Map<string, string>();
  private copies = new Map<string, Promise<void>>();
  /** The copy each target follows now, to run again on demand. */
  private runs = new Map<string, () => void>();

  /** `nameOf` is the name a machine goes by on screen (`machineName`), given by the workspace that imports this file. */
  constructor(private machines: () => Machine[], private nameOf: (machine: Machine) => string = (machine) => machine.label) {}

  /**
   * The id of the member `target` takes its settings from, as its own core
   * reports the group. Undefined when it is the home itself, when its group
   * chose none, or when its core predates the choice.
   */
  homeId(target: Machine): string | undefined {
    const group = target.store.group;
    const home = group?.settingsHome;
    return home && home !== group.self && group.cores.some((core) => core.coreId === home) ? home : undefined;
  }

  /** The home `target` follows, when this window is connected to it. */
  source(target: Machine): Machine | undefined {
    const home = this.homeId(target);
    if (home === undefined) return undefined;
    // The same machine may be listed twice (an address and a relay): the one that answers carries the copy.
    const listed = this.machines().filter((machine) => machine !== target && GroupLinks.coreOf(machine) === home);
    return listed.find((machine) => machine.store.connection === 'ready') ?? listed[0];
  }

  /** The home's name for `target`, connected here or not. */
  sourceName(target: Machine): string | undefined {
    const home = this.homeId(target);
    if (home === undefined) return undefined;
    const source = this.source(target);
    return source ? this.nameOf(source) : target.store.group?.cores.find((core) => core.coreId === home)?.name;
  }

  /** A copy now, after `target` gave a setting back to its home. */
  refresh(target: Machine): void {
    this.runs.get(target.id)?.();
  }

  forget(machine: Machine): void {
    delete this.reports[machine.id];
    delete this.busy[machine.id];
  }

  /** Runs for the whole window, including chat, with new copies after reconnects. */
  start(): () => void {
    try { localStorage.removeItem(RETIRED_KEY); } catch { /* nothing kept */ }
    return $effect.root(() => {
      $effect(() => {
        const machines = this.machines();
        // Track reconnects, client replacement and a new home, without watching our own writes.
        const ready = machines.map((target) => ({ target, source: this.source(target) }))
          .filter(({ source, target }) => source !== undefined
            && source.store.owner && target.store.owner && source.store.connection === 'ready'
            && target.store.connection === 'ready' && source.store.client && target.store.client);
        const dispose = untrack(() => ready.map(({ source, target }) => this.follow(source!, target)));
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
      let sync: typeof import('./settings-sync') | undefined;
      try {
        sync = await import('./settings-sync');
        if (stopped) return;
        do {
          pending = false;
          const report = await sync.syncSettings({ client: from }, { client: to }, abort.signal);
          if (stopped) break;
          target.store.settings = report.settings;
          if (report.keybindings) target.store.keybindings = report.keybindings;
          this.reports[target.id] = { source: source.label, report };
          if (target.store.error === this.failures.get(target.id)) target.store.error = null;
          this.failures.delete(target.id);
        } while (pending && !stopped);
      } catch (error) {
        if (!stopped) {
          const message = errorText(error);
          target.store.error = sync && error instanceof sync.SyncFailure
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
      if (!running && timer === undefined) timer = setTimeout(() => this.enqueue(target.id, run), 100);
    };
    const off = [from.on('settings.updated', schedule), from.on('keybindings.updated', schedule), from.on('brain.configured', schedule)];
    this.runs.set(target.id, schedule);
    schedule();
    return () => {
      stopped = true;
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      off.forEach(stop => stop());
      if (this.runs.get(target.id) === schedule) this.runs.delete(target.id);
    };
  }
}
