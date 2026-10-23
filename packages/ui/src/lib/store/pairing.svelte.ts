import { RpcErrorCode, type DeviceInvite, type Group, type PairedSession } from '@boite/contracts';
import { RpcFailure, type Client } from '../client';
import type { StoreContext } from './context';

/** A read of the group that failed is tried again after these waits, on the same connection. */
const GROUP_READ_DELAYS_MS = [1000, 4000];

/** The group of this core: its machines and devices, "Add a device", removals. */
export class Pairing {
  /** The last "Add a device" link and code, until closed, used or the core changes. */
  deviceInvite = $state<DeviceInvite | null>(null);
  sessions = $state<PairedSession[]>([]);
  private revision = 0;
  /** The group this core belongs to, null for none or for a core from before groups. */
  group = $state<Group | null>(null);
  /** The core answered `group.get` at least once on this connection: null then means no group, not no answer yet. */
  groupKnown = $state(false);
  /**
   * The core last answered that it is in no group, to `group.get` or by refusing a hello. A new connection that has
   * not answered yet does not take that back, unless this device's key opened it. Followed, so the group links hear a
   * refusal no roster change comes with.
   */
  ungrouped = $state(false);
  constructor(private readonly ctx: StoreContext) {}

  /**
   * "Add a device": one link and one code. A phone scans or types it, a
   * computer pastes the link. A core in no group starts one of its own first.
   */
  async addDevice(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    const revision = ++this.revision;
    try {
      const invite = await client.call('group.addDevice', {});
      if (revision !== this.revision || client !== this.ctx.client) return;
      this.deviceInvite = invite;
      // The core may have started a group for it.
      if (this.group === null) void this.loadGroup();
    } catch (error) {
      if (revision === this.revision && client === this.ctx.client) this.ctx.fail(error);
    }
  }

  /** Hide the link and ignore pending answers; the link itself keeps its expiry. */
  closeDeviceInvite(): void {
    this.revision++;
    this.deviceInvite = null;
  }

  /** Takes a phone or a browser out of the group, on every machine. */
  revokeDevice(id: string): Promise<boolean> {
    return this.#change((client) => client.call('group.revokeDevice', { id }));
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
   * again twice on the same connection, a second then four apart, without a
   * toast nobody asked for: until it answers, the machine neither vouches for
   * a group nor gets its agents linked.
   */
  async loadGroup(attempt = 0): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const group = await client.call('group.get', {});
      if (client !== this.ctx.client) return;
      // A link is for one device: once the roster gains one, it is spent.
      if ((group?.cores.length ?? 0) + (group?.devices.length ?? 0) > (this.group?.cores.length ?? 0) + (this.group?.devices.length ?? 0) && this.group !== null) this.closeDeviceInvite();
      this.group = group;
      this.groupKnown = true;
      this.ungrouped = group === null;
    } catch (error) {
      if (client !== this.ctx.client) return;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
        this.group = null;
        this.groupKnown = true;
        return;
      }
      console.warn('reading the group failed', error);
      if (attempt >= GROUP_READ_DELAYS_MS.length) return;
      setTimeout(() => {
        if (client === this.ctx.client && !this.groupKnown) void this.loadGroup(attempt + 1);
      }, GROUP_READ_DELAYS_MS[attempt]);
    }
  }

  /** True once the core answered; a refusal is the store's error and leaves the group as it was. */
  async #change(work: (client: Client) => Promise<Group | null>): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      const group = await work(client);
      // The store moved to another core meanwhile: this answer, or this refusal, is about the one it left.
      if (client !== this.ctx.client) return false;
      this.group = group;
      this.ungrouped = group === null;
      return true;
    } catch (error) {
      if (client === this.ctx.client) this.ctx.fail(error);
      return false;
    }
  }

  createGroup(name: string): Promise<boolean> {
    return this.#change((client) => client.call('group.create', { name }));
  }

  joinGroup(invite: string): Promise<boolean> {
    return this.#change((client) => client.call('group.join', { invite }));
  }

  renameGroup(name: string): Promise<boolean> {
    return this.#change((client) => client.call('group.rename', { name }));
  }

  /** The member the group's other machines take their settings from, or null for none. */
  setSettingsHome(coreId: string | null): Promise<boolean> {
    return this.#change((client) => client.call('group.settingsHome', { coreId }));
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

}
