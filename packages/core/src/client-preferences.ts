import { checkClientPreferences, sameClientPreferences, type ClientPreferences, type ExperimentId, type SentFrom, type SettingsReading } from '@boite/contracts';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './errors.ts';
import type { Connection } from './router.ts';

/** Apps remembered by id, so a reconnect compares with the app's last report; the oldest goes first. */
const APPS_KEPT = 64;

/*
 * What each app says of itself (`client.preferences`): its id, language, the
 * experiments it has on and the names it gives settings. Kept in memory only:
 * an app says it again after every hello. Agents read the app the user last
 * used: the one that last sent a prompt or changed a preference, or the first
 * to report once that app's socket closed. A phone that merely reconnects in a
 * pocket does not take the place of an open app.
 */
export class ClientPreferencesBook {
  private readonly byConnection = new Map<string, { preferences: ClientPreferences; from: SentFrom | null }>();
  /** Each app's last report by its id, across its sockets. */
  private readonly byApp = new Map<string, ClientPreferences>();
  private latest: { connectionId: string; preferences: ClientPreferences; from: SentFrom | null } | null = null;
  /** The desktop app phones follow: one on this machine's loopback outranks one reached from elsewhere. */
  private desktop: { experiments: ExperimentId[]; local: boolean } | null = null;

  /**
   * `reported` runs on every report with the experiments that app had at its
   * previous one, null when the core has none: a card settles on a flip, not
   * on another app's different value. `desktopMoved` runs when the followed
   * desktop app's experiments change.
   */
  constructor(
    private readonly reported: (preferences: ClientPreferences, before: readonly ExperimentId[] | null) => void,
    private readonly desktopMoved: (experiments: ExperimentId[]) => void = () => {},
  ) {}

  report(connection: Connection, params: unknown): void {
    const checked = checkClientPreferences(params);
    if (!checked.ok) throw new RpcFailure(RpcErrorCode.InvalidParams, checked.message, { field: checked.field });
    const preferences = checked.preferences;
    if (!this.byConnection.has(connection.id)) connection.onClose?.(() => this.byConnection.delete(connection.id));
    const entry = { preferences, from: connection.sentFrom ?? null };
    this.byConnection.set(connection.id, entry);
    const before = this.byApp.get(preferences.app) ?? null;
    this.byApp.delete(preferences.app);
    this.byApp.set(preferences.app, preferences);
    if (this.byApp.size > APPS_KEPT) this.byApp.delete(this.byApp.keys().next().value!);
    const moved = before !== null && !sameClientPreferences(before, preferences);
    // The app agents read stays known once its socket closes, until another app reports.
    const vacant = this.latest === null || !this.byConnection.has(this.latest.connectionId) || this.latest.connectionId === connection.id;
    if (vacant || moved) this.latest = { connectionId: connection.id, ...entry };
    // A paired device may call itself a shell: only the owner's desktop app is followed.
    if (entry.from?.client === 'shell' && connection.identity.principal === 'owner') this.follow(preferences.experiments, connection.remote === false);
    this.reported(preferences, before?.experiments ?? null);
  }

  private follow(experiments: ExperimentId[], local: boolean): void {
    if (!local && this.desktop?.local === true) return;
    const changed = this.desktop === null || this.desktop.experiments.join() !== experiments.join();
    this.desktop = { experiments: [...experiments], local };
    if (changed) this.desktopMoved([...experiments]);
  }

  /** The followed desktop app's experiments, or null before one reported. */
  desktopExperiments(): ExperimentId[] | null {
    return this.desktop === null ? null : [...this.desktop.experiments];
  }

  /** A prompt from this socket: its app is the one the user uses now. */
  use(connection: Connection): ClientPreferences | null {
    const entry = this.byConnection.get(connection.id);
    if (entry !== undefined) this.latest = { connectionId: connection.id, ...entry };
    return entry?.preferences ?? null;
  }

  /** The app agents read, or null before any reported. */
  current(): ClientPreferences | null {
    return this.latest?.preferences ?? null;
  }

  app(): SettingsReading['app'] {
    if (this.latest === null) return null;
    return { language: this.latest.preferences.language, device: this.latest.from?.device ?? null, client: this.latest.from?.client ?? null };
  }
}

/** The submitting socket's origin, with the language its own app reported. */
export function promptOrigin(connection: Connection, preferences: ClientPreferences | null): SentFrom | null {
  const from = connection.sentFrom ?? null;
  return from === null || preferences === null ? from : { ...from, language: preferences.language };
}
