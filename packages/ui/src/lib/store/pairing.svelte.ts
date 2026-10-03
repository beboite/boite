import type { PairedSession, PairingGrant, PairingRole } from '@boite/contracts';
import type { StoreContext } from './context';

/** Pairing: the owner mints one-time links, sees every paired device, revokes. */
export class Pairing {
  /** The last one-time pairing link, until it is closed or the core changes. */
  pairing = $state<PairingGrant | null>(null);
  sessions = $state<PairedSession[]>([]);
  private revision = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** `short`: an owner link a phone may scan, with a code, for five minutes. */
  async mintPairing(role: PairingRole = 'device', short = false): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    const revision = ++this.revision;
    try {
      const grant = await client.call('pairing.grant', short ? { role, short } : { role });
      if (revision === this.revision && client === this.ctx.client) this.pairing = grant;
    } catch (error) {
      if (revision === this.revision && client === this.ctx.client) this.ctx.fail(error);
    }
  }

  /** Hide this grant and ignore pending mint responses; the grant itself keeps its expiry. */
  closePairing(): void {
    this.revision++;
    this.pairing = null;
  }

  async loadSessions(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      this.sessions = await client.call('sessions.list', {});
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('sessions.revoke', { sessionId });
      this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
