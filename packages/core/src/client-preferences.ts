import { checkClientPreferences, sameClientPreferences, type ClientPreferences, type SentFrom, type SettingsReading } from '@boite/contracts';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './errors.ts';
import type { Connection } from './router.ts';

/*
 * What each app says of itself (`client.preferences`): its language, the
 * experiments it has on and the names it gives settings. Kept per socket and
 * never written down: an app says it again after every hello. Agents read the
 * app the user last used: the one that last sent a prompt or changed a
 * preference, or the first to report once that app's socket closed. A phone
 * that merely reconnects in a pocket does not take the place of an open app.
 */
export class ClientPreferencesBook {
  private readonly byConnection = new Map<string, { preferences: ClientPreferences; from: SentFrom | null }>();
  private latest: { connectionId: string; preferences: ClientPreferences; from: SentFrom | null } | null = null;

  /**
   * `changed` runs when an app reports that one of its own preferences moved
   * and it is the app agents read: the user flipped something there. Moving
   * from one app to another flips nothing, so it settles no card.
   */
  constructor(private readonly changed: (preferences: ClientPreferences) => void) {}

  report(connection: Connection, params: unknown): void {
    const checked = checkClientPreferences(params);
    if (!checked.ok) throw new RpcFailure(RpcErrorCode.InvalidParams, checked.message, { field: checked.field });
    const before = this.byConnection.get(connection.id);
    if (before === undefined) connection.onClose?.(() => this.byConnection.delete(connection.id));
    const entry = { preferences: checked.preferences, from: connection.sentFrom ?? null };
    this.byConnection.set(connection.id, entry);
    const moved = before !== undefined && !sameClientPreferences(before.preferences, entry.preferences);
    // The app agents read stays known once its socket closes, until another app reports.
    const vacant = this.latest === null || !this.byConnection.has(this.latest.connectionId) || this.latest.connectionId === connection.id;
    if (vacant || moved) this.take(connection.id, entry);
    if (moved) this.changed(entry.preferences);
  }

  /** A prompt from this socket: its app is the one the user uses now. */
  use(connection: Connection): ClientPreferences | null {
    const entry = this.byConnection.get(connection.id);
    if (entry !== undefined) this.take(connection.id, entry);
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

  private take(connectionId: string, entry: { preferences: ClientPreferences; from: SentFrom | null }): void {
    this.latest = { connectionId, ...entry };
  }
}
