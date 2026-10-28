import { errorText } from '../errors';
import { isSyncKey, RpcErrorCode, type AgentCommand, type SyncKey } from '@boite/contracts';
import { RpcFailure } from '../client';
import type {
  KeybindingCommand,
  Keybindings,
  PolicyState,
  RpcParams,
  RpcResult,
  SchedulerState,
  Settings,
  TelemetryState
} from '@boite/contracts';
import { chordLabel, commandForKey, isMac, resolveBindings, type BindingTable, type KeyScope } from '../keybindings';
import { strings } from '../strings';
import type { StoreContext } from './context';

/** `kept` with `keys` added, or null when it holds them all already. */
function adding(kept: readonly string[], keys: readonly string[]): string[] | null {
  const added = keys.filter((key) => !kept.includes(key));
  return added.length === 0 ? null : [...kept, ...added];
}

/** What the core keeps for the whole machine: its settings, the scheduler, the keybindings file and telemetry. */
export class CoreSettings {
  brainCommands = $state.raw<AgentCommand[]>([]);
  #brainRead = 0;

  /** Read when the slash menu opens, so edits on the host appear without a poll. */
  async loadBrainCommands(): Promise<void> {
    const client = this.ctx.client, generation = this.ctx.clientGeneration;
    const read = ++this.#brainRead;
    if (!client) return;
    try {
      const commands = await client.call('brain.commands', {});
      if (this.ctx.client === client && this.ctx.clientGeneration === generation && this.#brainRead === read) this.brainCommands = commands;
    } catch (error) {
      if (this.ctx.client !== client || this.ctx.clientGeneration !== generation || this.#brainRead !== read) return;
      this.brainCommands = [];
      if (!(error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound)) this.ctx.fail(error);
    }
  }

  scheduler = $state<SchedulerState | null>(null);
  #settings = $state<Settings | null>(null);
  get settings(): Settings | null { return this.#settings; }
  set settings(value: Settings | null) {
    this.#settings = value;
    // Every arrival, whether read, pushed by the core or answered to a save.
    this.ctx.models.syncFavorites();
  }
  /** The admin policy this core enforces; null until read, or on a core too old to have one. */
  policy = $state.raw<PolicyState | null>(null);
  /** The keybindings file as the core last read it; null until the first `keybindings.get`. */
  keybindings = $state<Keybindings | null>(null);
  /** Every command with its chord: the defaults, the file's entries over them. */
  bindings = $derived(resolveBindings(this.keybindings?.bindings ?? {}));

  constructor(private readonly ctx: StoreContext) {}

  /**
   * False when nothing was saved, so a caller never reports a save the core
   * refused. On a machine that follows its group's settings home, a synced
   * setting changed here stays here: the same save marks it kept.
   */
  saveSettings(patch: Partial<Settings>): Promise<boolean> {
    const keys = Object.keys(patch).filter(isSyncKey);
    return this.#save(patch, patch.syncOverrides === undefined && keys.length > 0 ? (kept) => adding(kept, keys) : null);
  }

  /** The member whose settings this machine follows, as its own core reports the group; null when it follows none. */
  get settingsHome(): string | null {
    const group = this.ctx.store.group;
    const home = group?.settingsHome;
    return home && home !== group.self && group.cores.some((core) => core.coreId === home) ? home : null;
  }

  /** What this machine keeps for itself while it follows a home. */
  kept(key: SyncKey): boolean {
    return this.settingsHome !== null && (this.settings?.syncOverrides ?? []).includes(key);
  }

  /** Marks what a change made elsewhere than `settings.set` keeps here: a chord, a brain switch. */
  async keep(keys: readonly SyncKey[]): Promise<void> {
    if (keys.length === 0 || this.settingsHome === null) return;
    await this.#save({}, (kept) => adding(kept, keys));
  }

  /** Gives `key` back to the home: the next copy writes the home's value over it. */
  followHome(key: SyncKey): Promise<boolean> {
    return this.#save({}, (kept) => kept.includes(key) ? kept.filter((entry) => entry !== key) : null, true);
  }

  /** Saves that change the kept list, one after the other, each from the list the one before left. */
  #keeping: Promise<unknown> = Promise.resolve();

  /**
   * `change` turns the kept list into the next one, or null to leave it. It
   * runs only on a machine that follows a home, `always` aside, on the list
   * the core holds now: the copy from the home may have just replaced the one
   * this store shows.
   */
  #save(patch: Partial<Settings>, change: ((kept: string[]) => string[] | null) | null, always = false): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return Promise.resolve(false);
    if (change === null || (!always && this.settingsHome === null)) return Object.keys(patch).length === 0 ? Promise.resolve(true) : this.#send(client, patch);
    const turn = this.#keeping.then(async () => {
      let next: string[] | null;
      try {
        next = change((await client.call('settings.get', {})).syncOverrides ?? []);
      } catch (error) {
        this.ctx.fail(error);
        return false;
      }
      if (next === null) return Object.keys(patch).length === 0 ? true : this.#send(client, patch);
      return this.#send(client, { ...patch, syncOverrides: next });
    });
    this.#keeping = turn.catch(() => undefined);
    return turn;
  }

  async #send(client: NonNullable<StoreContext['client']>, patch: Partial<Settings>): Promise<boolean> {
    try {
      this.settings = await client.call('settings.set', patch);
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The keyboard
  // -------------------------------------------------------------------------

  /** The last keydown's answer: the composer asks for its chords, then the app for its own, all on one key. */
  #lastKey: { event: KeyboardEvent; scope: KeyScope; table: BindingTable; command: KeybindingCommand | null } | null = null;

  /** The command this keydown is bound to, or null when the key is nobody's. A terminal asks for its own first. */
  commandForKey(event: KeyboardEvent, scope: KeyScope = 'app'): KeybindingCommand | null {
    const table = this.ctx.store.bindings, last = this.#lastKey;
    if (last?.event === event && last.scope === scope && last.table === table) return last.command;
    const command = commandForKey(table, event, isMac(), scope);
    this.#lastKey = { event, scope, table, command };
    return command;
  }

  /** True while this keydown is the chord of that one command. */
  isKey(event: KeyboardEvent, id: KeybindingCommand): boolean {
    return this.ctx.store.commandForKey(event) === id;
  }

  /** `Ctrl+N`, or null while the command has no key. */
  keyLabel(id: KeybindingCommand): string | null {
    const chord = this.ctx.store.bindings[id].chord;
    return chord === null ? null : chordLabel(chord);
  }

  /**
   * A chord for one command, null for none, or `default` to take the command
   * out of the file. The refusal comes back for the row that asked, not as
   * the app's error.
   */
  async setKeybinding(id: KeybindingCommand, chord: string | null | 'default'): Promise<string | null> {
    const client = this.ctx.client;
    if (!client) return strings.connection.unavailable;
    try {
      this.keybindings = chord === 'default'
        ? await client.call('keybindings.reset', { command: id })
        : await client.call('keybindings.set', { command: id, chord });
    } catch (error) {
      return errorText(error);
    }
    await this.keep([`keybinding:${id}`]);
    return null;
  }

  /** Every command back on its default. A machine that follows a home keeps the ones that changed. */
  async resetKeybindings(): Promise<string | null> {
    const client = this.ctx.client;
    if (!client) return strings.connection.unavailable;
    let changed: KeybindingCommand[] = [];
    try {
      // What the reset changes is what the file names now, read from the core: this store may not have read it yet.
      if (this.settingsHome !== null) changed = Object.keys((await client.call('keybindings.get', {})).bindings) as KeybindingCommand[];
      this.keybindings = await client.call('keybindings.reset', {});
    } catch (error) {
      return errorText(error);
    }
    await this.keep(changed.map((command) => `keybinding:${command}` as const));
    return null;
  }

  /** ` (Ctrl+N)` for a tooltip, or nothing while the command has no key. */
  keyHint(id: KeybindingCommand): string {
    const label = this.ctx.store.keyLabel(id);
    return label === null ? '' : ` (${label})`;
  }

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  telemetryState(): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.state', {});
  }

  configureTelemetry(mode: TelemetryState['mode'], countChoice = true): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.configure', { mode, countChoice });
  }

  retryTelemetryDeletion(): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.retryForget', {});
  }

  exportTelemetry(): Promise<Record<string, unknown>> {
    return this.#telemetryCall('telemetry.export', {});
  }

  async #telemetryCall<M extends 'telemetry.state' | 'telemetry.configure' | 'telemetry.retryForget' | 'telemetry.export'>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const client = this.ctx.client;
    try {
      if (!client || !this.ctx.store.owner) throw new Error(strings.rightPanel.ownerOnly);
      return await client.call(method, params);
    } catch (error) {
      if (this.ctx.client === client) this.ctx.fail(error);
      throw error;
    }
  }
}
