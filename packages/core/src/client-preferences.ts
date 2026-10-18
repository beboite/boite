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

  /**
   * `reported` runs on every report with the experiments that app had at its
   * previous one, null when the core has none: a card settles on a flip, not
   * on another app's different value.
   */
  constructor(private readonly reported: (preferences: ClientPreferences, before: readonly ExperimentId[] | null) => void) {}

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
    this.reported(preferences, before?.experiments ?? null);
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
