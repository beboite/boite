import { BROWSER_HOST_BATCH_MAX, BROWSER_HOST_MESSAGE_MAX, browserProfileIdError, DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE } from '@boite/contracts';
import type { Connection } from '../router.ts';
import { refused } from '../errors.ts';
import { Cdp } from './cdp.ts';

interface Relay { cdp: Cdp; receive(text: string): void; end(): void }

/**
 * The desktop app of this machine hosting the agent's tabs in webviews of its
 * own, so the page shows natively there instead of as frames.
 *
 * The core keeps every DevTools command it would send a browser it started;
 * this carries them to the app, one relay per profile, and the app answers as a
 * browser would (`packages/ui/src/lib/browser-host.ts`). Only the desktop app
 * signed in as the owner on this machine's loopback may attach: its webviews
 * run the owner's own profiles and sign-ins. One app hosts at a time, the last
 * to attach; when it leaves, the relays end and their tabs close with them.
 */
export class BrowserHost {
  #connection: Connection | null = null;
  #offClose: (() => void) | null = null;
  #relays = new Map<string, Relay>();

  get attached(): boolean { return this.#connection !== null; }

  attach(connection: Connection): void {
    if (connection.identity.principal !== 'owner' || connection.sentFrom?.client !== 'shell' || connection.remote !== false) {
      throw refused('only the desktop app on this machine, signed in as the owner, can host the agent browser');
    }
    if (this.#connection === connection) return;
    this.detach();
    this.#connection = connection;
    this.#offClose = connection.onClose?.(() => this.detach(connection)) ?? null;
  }

  /** Without `connection`, whichever app hosts; with it, only if that one does. */
  detach(connection?: Connection): void {
    if (!this.#connection || (connection && connection !== this.#connection)) return;
    this.#connection = null;
    this.#offClose?.(); this.#offClose = null;
    const relays = [...this.#relays.values()];
    this.#relays.clear();
    for (const relay of relays) relay.end();
  }

  /** A DevTools connection to the host's webviews of `profile`; it ends when the host leaves. */
  connect(profile: string): Cdp {
    const connection = this.#connection;
    if (!connection) throw refused('no desktop app hosts the agent browser on this machine');
    this.#relays.get(profile)?.end();
    const relay: Relay = Cdp.relay(
      message => connection.sendEvent('browser.hostMessage', { profile, message }),
      () => { if (this.#relays.get(profile) === relay) this.#relays.delete(profile); },
    );
    this.#relays.set(profile, relay);
    return relay.cdp;
  }

  reply(connection: Connection, profile: unknown, messages: unknown): void {
    if (connection !== this.#connection) throw refused('this connection does not host the agent browser: call browser.hostAttach first');
    if (typeof profile !== 'string' || (profile !== DEFAULT_BROWSER_PROFILE && profile !== PRIVATE_BROWSER_PROFILE && browserProfileIdError(profile) !== null)) {
      throw refused('browser.hostReply profile must be a profile id from browser.hostMessage');
    }
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > BROWSER_HOST_BATCH_MAX) {
      throw refused(`browser.hostReply messages must be a list of 1 to ${BROWSER_HOST_BATCH_MAX} DevTools messages`);
    }
    for (const message of messages) {
      if (typeof message !== 'string' || message.length > BROWSER_HOST_MESSAGE_MAX) throw refused(`each browser.hostReply message must be a string of at most ${BROWSER_HOST_MESSAGE_MAX} characters`);
    }
    // A profile whose relay already ended (its tabs closed) has nobody to read the rest.
    const relay = this.#relays.get(profile);
    if (relay) for (const message of messages as string[]) relay.receive(message);
  }
}
