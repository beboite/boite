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
 *
 * A grant exchanged with a nonce stays answerable for the rest of its ten
 * minutes: the answer carrying the session can be lost on a weak link, and the
 * phone's retry, with the same grant and the same nonce, gets the same session
 * back instead of "already used". The plaintext token of such a delivery lives
 * in memory only, and goes the moment its key first opens the core.
 *
 * A grant also comes as a short code, `XXXX-XXXX`, typed into an installed
 * iPhone app that cannot open the link: the camera hands links to Safari,
 * whose storage the home-screen app does not share. The code names the same
 * one-time grant for at most five minutes. Eight Crockford letters are 40
 * bits; ten wrong codes in a row drop every live code, so guessing one is out
 * of reach while the links themselves keep working. A `short` owner grant, the
 * one a phone may scan, lives those five minutes too.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { GRANT_QUERY_PARAM, GRANT_TTL_MS, normalizePairingCode, PAIRING_CODE_ALPHABET, PAIRING_CODE_TTL_MS, PAIRING_ROLES } from '@boite/contracts';
import type { PairedSession, PairingGrant, PairingRole, Principal, ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused, unauthorized } from './errors.ts';
import { newId, newToken } from './ids.ts';

interface Grant {
  expiresAt: number;
  role: PairingRole;
}

/** An exchange whose answer may not have arrived, kept until its grant would have expired. */
interface Delivery {
  nonceHash: Buffer;
  id: string;
  token: string;
  role: PairingRole;
  expiresAt: number;
}

/** A nonce shorter than this is no secret, so a hello carrying one is refused. */
export const NONCE_MIN = 16;
export const NONCE_MAX = 256;

/**
 * What is wrong with a hello's `nonce`, or null when it is a usable one. A bad
 * nonce is refused rather than dropped: dropped, the grant would still work but
 * only once, and the client would never learn its retry protection was off.
 */
export function nonceProblem(nonce: unknown): string | null {
  if (typeof nonce !== 'string') return `nonce must be a string of ${NONCE_MIN} to ${NONCE_MAX} characters, got ${nonce === null ? 'null' : typeof nonce}`;
  if (nonce.length < NONCE_MIN || nonce.length > NONCE_MAX) {
    return `nonce must be ${NONCE_MIN} to ${NONCE_MAX} characters, got ${nonce.length}`;
  }
  return null;
}

function nonceHash(nonce: string): Buffer {
  return createHash('sha256').update(nonce).digest();
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
  /** Set on an agent connection: the one thread its token was minted for. */
  threadId: ThreadId | null;
}

/** Who a session key speaks as: an owner link's key is the owner, a device link's the guest. */
export function principalOf(role: PairingRole): Principal {
  return role === 'owner' ? 'owner' : 'session';
}

/** Wrong codes in a row after which every live code is dropped. */
export const CODE_FAILURES_MAX = 10;

function newCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length));
  return code;
}

/** `ABCD-EFGH`, the way a code is shown and read aloud. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
  private readonly grants = new Map<string, Grant>();
  /** Keyed by grant. */
  private readonly deliveries = new Map<string, Delivery>();
  /** Canonical code to the grant it names. */
  private readonly codes = new Map<string, { grant: string; expiresAt: number }>();
  private codeFailures = 0;

  constructor(private readonly core: Core) {}

  /**
   * A fresh grant, good for one exchange within `GRANT_TTL_MS`. A device
   * grant, and an owner grant asked `short`, also come as a code. A short owner
   * grant expires with its code: it is the one meant to be scanned.
   */
  grant(now = Date.now(), role: PairingRole = 'device', short = false): PairingGrant {
    if (!PAIRING_ROLES.includes(role)) {
      throw refused(`pairing.grant role must be ${PAIRING_ROLES.join(' or ')}, got ${String(role)}`, { role });
    }
    if (typeof short !== 'boolean') throw invalidParams(`pairing.grant short must be a boolean, got ${typeof short}`, { field: 'short' });
    this.sweep(now);
    const grant = newToken();
    const expiresAt = now + (role === 'owner' && short ? PAIRING_CODE_TTL_MS : GRANT_TTL_MS);
    this.grants.set(grant, { expiresAt, role });
    const result: PairingGrant = { url: this.pairingUrl(grant), grant, role, expiresAt };
    if (role === 'device' || short) {
      let code = newCode();
      while (this.codes.has(code)) code = newCode();
      const codeExpiresAt = Math.min(expiresAt, now + PAIRING_CODE_TTL_MS);
      this.codes.set(code, { grant, expiresAt: codeExpiresAt });
      result.code = formatCode(code);
      result.codeExpiresAt = codeExpiresAt;
    }
    return result;
  }

  /** The grant a typed code names; anything that is not code-shaped passes through. */
  private resolveCode(grant: string): string {
    if (grant.length > 16) return grant;
    const code = normalizePairingCode(grant);
    if (code === null) return grant;
    const entry = this.codes.get(code);
    if (entry !== undefined) {
      this.codeFailures = 0;
      return entry.grant;
    }
    if (++this.codeFailures >= CODE_FAILURES_MAX) {
      this.codes.clear();
      this.codeFailures = 0;
      this.core.log('warn', `pairing codes dropped after ${CODE_FAILURES_MAX} wrong codes in a row`);
    }
    return grant;
  }

  pairingUrl(grant: string): string {
    return `${this.core.settings.get().publicUrl ?? this.core.reachableUrl()}/?${GRANT_QUERY_PARAM}=${grant}`;
  }

  /**
   * The grant becomes a session, once. A grant the core never issued, one
   * already exchanged and one past its time all fail the same way, by name:
   * the link on the phone is what the user has to look at. A retry that
   * repeats the nonce of the first exchange gets that exchange's session.
   */
  exchange(grant: string, client: ClientIdentity, now = Date.now(), nonce: string | null = null): { id: string; token: string; role: PairingRole } {
    // Before anything is spent: a bad nonce leaves the grant as it was.
    const problem = nonce === null ? null : nonceProblem(nonce);
    if (problem !== null) throw invalidParams(problem, { field: 'nonce', min: NONCE_MIN, max: NONCE_MAX });
    this.sweep(now);
    const typed = grant;
    grant = this.resolveCode(grant);
    const known = this.grants.get(grant);
    if (known === undefined) {
      const delivery = this.deliveries.get(grant);
      if (delivery !== undefined && nonce !== null && timingSafeEqual(delivery.nonceHash, nonceHash(nonce))) {
        return { id: delivery.id, token: delivery.token, role: delivery.role };
      }
      if (typed.length <= 16 && normalizePairingCode(typed) !== null) {
        throw unauthorized('the pairing code is wrong, expired, or was already used');
      }
      throw unauthorized('the pairing link was already used, expired, or never issued');
    }
    this.grants.delete(grant);
    // A code spent without a nonce has no retry to answer: it names nothing now.
    if (nonce === null) this.dropCodes(grant);
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
    if (nonce !== null) this.deliveries.set(grant, { nonceHash: nonceHash(nonce), id, token, role, expiresAt: known.expiresAt });
    this.core.bus.emit('sessions.updated', { sessionId: id, state: 'created' });
    return { id, token, role };
  }

  /** The session a token opens, or null. Touches `lastSeenAt` on a hit. */
  authenticate(token: string, now = Date.now()): { id: string; role: PairingRole } | null {
    const row = this.core.journal.getSessionByHash(hashToken(token));
    if (row === null) return null;
    // The phone holds its key: the grant is spent for good.
    this.forgetDelivery(row.id);
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
    this.core.fileTickets.forgetAll();
    this.forgetDelivery(sessionId);
    // The sockets first, so the event never reaches the client it is about.
    this.core.subscribers.closeSession(sessionId);
    this.core.bus.emit('sessions.updated', { sessionId, state: 'revoked' });
  }

  private sweep(now: number): void {
    for (const [grant, entry] of this.grants) {
      if (entry.expiresAt <= now) this.grants.delete(grant);
    }
    for (const [grant, entry] of this.deliveries) {
      if (entry.expiresAt <= now) this.deliveries.delete(grant);
    }
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }

  private forgetDelivery(sessionId: string): void {
    for (const [grant, entry] of this.deliveries) {
      if (entry.id !== sessionId) continue;
      this.deliveries.delete(grant);
      this.dropCodes(grant);
    }
  }

  private dropCodes(grant: string): void {
    for (const [code, entry] of this.codes) {
      if (entry.grant === grant) this.codes.delete(code);
    }
  }
}

// Who may call what is `access.ts`, applied by the router before any handler
// runs: `pairing.grant` and `sessions.revoke` are absent from `DEVICE_METHODS`,
// so a paired device is refused them by name.
export function registerSessionMethods(core: Core): void {
  core.router.register('pairing.grant', (params) => core.sessions.grant(Date.now(), params?.role ?? 'device', params?.short ?? false));
  core.router.register('sessions.list', (_params, ctx) => core.sessions.list(ctx.connection.identity.sessionId));
  core.router.register('sessions.revoke', (params) => {
    core.sessions.revoke(params.sessionId);
    return { ok: true } as const;
  });
}
