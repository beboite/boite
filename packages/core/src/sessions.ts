/*
 * Pairing grants and the sessions they become.
 *
 * The core token is the shell's, and it never travels: a phone gets a link
 * carrying a grant, a random id the core remembers for ten minutes and
 * forgets the moment it is exchanged. The exchange happens inside `hello`
 * and hands back a session token of the phone's own, stored hashed in the
 * journal so a core restart keeps the pairing and a copy of the journal
 * holds no credential. Revoking a session closes its sockets and deletes the
 * row; the token then opens nothing.
 *
 * A grant carries a role. `device`, the default, is the phone and speaks as a
 * `session`. `owner` is a desktop pairing with a core on another machine, the
 * one way a core with no window of its own gets an owner that is not a process
 * reading its `core.json`: that session speaks as the `owner`, and is listed
 * and revoked like any other.
 */

import { createHash } from 'node:crypto';
import { GRANT_QUERY_PARAM, GRANT_TTL_MS, PAIRING_ROLES } from '@boite/contracts';
import type { PairedSession, PairingGrant, PairingRole, Principal } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused, unauthorized } from './errors.ts';
import { newId, newToken } from './ids.ts';

interface Grant {
  expiresAt: number;
  role: PairingRole;
}

export interface ClientIdentity {
  name: string;
  version: string;
}

/** What `hello` decided about a socket, kept on the connection for the handlers. */
export interface Identity {
  principal: Principal;
  /** Set on a session connection: the row `sessions.list` shows and `sessions.revoke` takes. */
  sessionId: string | null;
}

/** Who a session key speaks as: an owner link's key is the owner, a device link's the guest. */
export function principalOf(role: PairingRole): Principal {
  return role === 'owner' ? 'owner' : 'session';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly core: Core) {}

  /** A fresh grant, good for one exchange within `GRANT_TTL_MS`. */
  grant(now = Date.now(), role: PairingRole = 'device'): PairingGrant {
    if (!PAIRING_ROLES.includes(role)) {
      throw refused(`pairing.grant role must be ${PAIRING_ROLES.join(' or ')}, got ${String(role)}`, { role });
    }
    this.sweep(now);
    const grant = newToken();
    const expiresAt = now + GRANT_TTL_MS;
    this.grants.set(grant, { expiresAt, role });
    return { url: this.pairingUrl(grant), grant, role, expiresAt };
  }

  pairingUrl(grant: string): string {
    return `${this.core.baseUrl()}/?${GRANT_QUERY_PARAM}=${grant}`;
  }

  /**
   * The grant becomes a session, once. A grant the core never issued, one
   * already exchanged and one past its time all fail the same way, by name:
   * the link on the phone is what the user has to look at.
   */
  exchange(grant: string, client: ClientIdentity, now = Date.now()): { id: string; token: string; role: PairingRole } {
    this.sweep(now);
    const known = this.grants.get(grant);
    if (known === undefined) throw unauthorized('the pairing link was already used, expired, or never issued');
    this.grants.delete(grant);
    const token = newToken();
    const id = newId('ses_');
    const role = known.role;
    this.core.journal.append({ type: 'session.created', threadId: null, version: 1, payload: { id, client, role } }, () => {
      this.core.journal.putSession({
        id,
        token_hash: hashToken(token),
        client_name: client.name,
        client_version: client.version,
        role,
        created_at: now,
        last_seen_at: now,
      });
    });
    this.core.bus.emit('sessions.updated', { sessionId: id, state: 'created' });
    return { id, token, role };
  }

  /** The session a token opens, or null. Touches `lastSeenAt` on a hit. */
  authenticate(token: string, now = Date.now()): { id: string; role: PairingRole } | null {
    const row = this.core.journal.getSessionByHash(hashToken(token));
    if (row === null) return null;
    this.core.journal.touchSession(row.id, now);
    return { id: row.id, role: row.role };
  }

  list(current: string | null): PairedSession[] {
    return this.core.journal.listSessions().map((row) => ({
      id: row.id,
      client: { name: row.client_name, version: row.client_version },
      role: row.role,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      current: row.id === current,
    }));
  }

  revoke(sessionId: string): void {
    if (this.core.journal.getSession(sessionId) === null) {
      throw refused(`unknown session ${sessionId}`, { sessionId });
    }
    this.core.journal.append({ type: 'session.revoked', threadId: null, version: 1, payload: { id: sessionId } }, () => {
      this.core.journal.deleteSession(sessionId);
    });
    // The sockets first, so the event never reaches the client it is about.
    this.core.subscribers.closeSession(sessionId);
    this.core.bus.emit('sessions.updated', { sessionId, state: 'revoked' });
  }

  private sweep(now: number): void {
    for (const [grant, entry] of this.grants) {
      if (entry.expiresAt <= now) this.grants.delete(grant);
    }
  }
}

// Who may call what is `access.ts`, applied by the router before any handler
// runs: `pairing.grant` and `sessions.revoke` are absent from `DEVICE_METHODS`,
// so a paired device is refused them by name.
export function registerSessionMethods(core: Core): void {
  core.router.register('pairing.grant', (params) => core.sessions.grant(Date.now(), params?.role ?? 'device'));
  core.router.register('sessions.list', (_params, ctx) => core.sessions.list(ctx.connection.identity.sessionId));
  core.router.register('sessions.revoke', (params) => {
    core.sessions.revoke(params.sessionId);
    return { ok: true } as const;
  });
}
