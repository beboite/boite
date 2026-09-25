import type {
  KeybindingCommand,
  Keybindings,
  RpcParams,
  RpcResult,
  SchedulerState,
  Settings,
  TelemetryState
} from '@boite/contracts';
import { chordLabel, commandForKey, resolveBindings } from '../keybindings';
import { strings } from '../strings';
import type { StoreContext } from './context';

/** What the core keeps for the whole machine: its settings, the scheduler, the keybindings file and telemetry. */
export class CoreSettings {
  scheduler = $state<SchedulerState | null>(null);
  settings = $state<Settings | null>(null);
  /** The keybindings file as the core last read it; null until the first `keybindings.get`. */
  keybindings = $state<Keybindings | null>(null);
  /** Every command with its chord: the defaults, the file's entries over them. */
  bindings = $derived(resolveBindings(this.keybindings?.bindings ?? {}));

  constructor(private readonly ctx: StoreContext) {}

  /** False when nothing was saved, so a caller never reports a save the core refused. */
  async saveSettings(patch: Partial<Settings>): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
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

  /** The command this keydown is bound to, or null when the key is nobody's. */
  commandForKey(event: KeyboardEvent): KeybindingCommand | null {
    return commandForKey(this.ctx.store.bindings, event);
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
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Every command back on its default. */
  async resetKeybindings(): Promise<string | null> {
    const client = this.ctx.client;
    if (!client) return strings.connection.unavailable;
    try {
      this.keybindings = await client.call('keybindings.reset', {});
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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

  configureTelemetry(mode: TelemetryState['mode']): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.configure', { mode });
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
