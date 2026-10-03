import { RpcErrorCode, type Group, type GroupInvite, type PairedSession, type PairingGrant, type PairingRole } from '@boite/contracts';
import { RpcFailure, type Client } from '../client';
import type { StoreContext } from './context';

/** Pairing: the owner mints one-time links, sees every paired device, revokes, and groups its machines. */
export class Pairing {
  /** The last one-time pairing link, until it is closed or the core changes. */
  pairing = $state<PairingGrant | null>(null);
  sessions = $state<PairedSession[]>([]);
  private revision = 0;
  /** The group this core belongs to, null for none or for a core from before groups. */
  group = $state<Group | null>(null);
  /** The core answered `group.get` at least once on this connection: null then means no group, not no answer yet. */
  groupKnown = $state(false);
  /** The last invitation minted from Settings, until it is used or the page changes. */
  groupInvite = $state<GroupInvite | null>(null);

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

  /**
   * Read on every connection and on every `group.updated`. A core from before
   * groups has no such method and belongs to none. A read that fails is tried
   * again at the next reconnect, without a toast nobody asked for.
   */
  async loadGroup(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const group = await client.call('group.get', {});
      if (client !== this.ctx.client) return;
      // An invitation is for one machine: once the roster gains one, it is spent.
      if ((group?.cores.length ?? 0) !== (this.group?.cores.length ?? 0)) this.groupInvite = null;
      this.group = group;
      this.groupKnown = true;
    } catch (error) {
      if (client !== this.ctx.client) return;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
        this.group = null;
        this.groupKnown = true;
      } else console.warn('reading the group failed', error);
    }
  }

  /** True once the core answered; a refusal is the store's error and leaves the group as it was. */
  async #change(work: (client: Client) => Promise<Group | null>): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      this.group = await work(client);
      this.groupInvite = null;
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  createGroup(name: string): Promise<boolean> {
    return this.#change((client) => client.call('group.create', { name }));
  }

  joinGroup(invite: string): Promise<boolean> {
    return this.#change((client) => client.call('group.join', { invite }));
  }

  leaveGroup(): Promise<boolean> {
    return this.#change(async (client) => {
      await client.call('group.leave', {});
      return null;
    });
  }

  removeFromGroup(coreId: string): Promise<boolean> {
    return this.#change((client) => client.call('group.remove', { coreId }));
  }

  async inviteToGroup(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      this.groupInvite = await client.call('group.invite', {});
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
