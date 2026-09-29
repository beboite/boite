import type { PairedSession, PairingGrant, PairingRole } from '@boite/contracts';
import type { StoreContext } from './context';

/** Pairing: the owner mints one-time links, sees every paired device, revokes. */
export class Pairing {
  /** The last one-time pairing link minted from Settings, until the page changes. */
  pairing = $state<PairingGrant | null>(null);
  sessions = $state<PairedSession[]>([]);

  constructor(private readonly ctx: StoreContext) {}

  async mintPairing(role: PairingRole = 'device'): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      this.pairing = await client.call('pairing.grant', { role });
    } catch (error) {
      this.ctx.fail(error);
    }
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
