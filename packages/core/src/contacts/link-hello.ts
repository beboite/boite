/** Validate the contact-only WebSocket upgrade before accepting a socket. */
import { randomUUID, verify } from 'node:crypto';
import type { Core } from '../core.ts';
import { refused, RpcFailure } from '../errors.ts';
import type { ContactStore } from './store.ts';

/** What the server keeps on a contact's link socket. */
export interface ContactSocketData { contact: { coreId: string; routeId: string } }

export const HELLO_INPUT = 'boite-contact-hello\n';
export function contactHello(core: Core, store: ContactStore, request: Request): ContactSocketData['contact'] | Response {
    if (store.isClosed || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
    const guest = request.headers.get('x-boite-peer') ?? '';
    const contact = store.find(guest);
    if (!contact || contact.role !== 'host') return new Response('not a contact that dials this core', { status: 403 });
    try {
      const hello = Buffer.from(request.headers.get('x-boite-hello') ?? '', 'base64url').toString('utf8');
      const signature = request.headers.get('x-boite-signature') ?? '';
      if (!hello || !verify(null, Buffer.from(`${HELLO_INPUT}${hello}`), contact.publicKey, Buffer.from(signature, 'base64'))) throw refused('signature: expected the contact\'s key to sign the hello');
      const parsed = JSON.parse(hello) as { v?: unknown; from?: unknown; to?: unknown; at?: unknown; nonce?: unknown };
      if (parsed.v !== 1 || parsed.from !== guest || parsed.to !== core.coordination.card().coreId) throw refused('hello: expected v 1, from the dialling contact, to this core');
      store.fresh(guest, typeof parsed.nonce === 'string' && parsed.nonce.length <= 100 ? parsed.nonce : '', parsed.at);
    } catch (error) {
      return new Response(error instanceof RpcFailure ? error.message : 'invalid hello', { status: 403 });
    }
    return { coreId: guest, routeId: `contact:${randomUUID()}` };
}
