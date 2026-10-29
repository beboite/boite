/*
 * Joining a contact: the guest spends a one-time invitation on the host's
 * join route, and each side keeps the other's card.
 *
 * Two owners can invite and join each other at once. Both cores then settle
 * on the same single relationship with a rule each computes alone: the core
 * with the smaller core id hosts, the other dials it.
 */
import { randomUUID, verify } from 'node:crypto';
import type { Contact } from '@boite/contracts';
import { boundedBody } from '../coordination-wire.ts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused, RpcFailure, unavailable } from '../errors.ts';
import { openResponse, pack, seal, SEALED, sealResponse, unpack, type Sealing } from '../group/seal.ts';
import { checkCard, checkTailnetName, decodeInvite, tokenHash, type ContactCard, type Invitation } from './invite.ts';
import type { ContactStore } from './store.ts';

export const CONTACT_JOIN_ROUTE = '/contacts/join';
export const JOIN_INPUT = 'boite-contact-join\n';
const JOINED_INPUT = 'boite-contact-joined\n';
const JOIN_BODY_MAX = 16_384;
/** How long a guest waits before joining again a host whose Funnel name public DNS does not know yet. */
export const JOIN_RETRY_MS = 30_000;

/** A name DNS does not know, as Bun's fetch and Node's report it. */
function notFound(error: unknown): boolean {
  const code = (value: unknown) => (value as { code?: unknown } | null)?.code;
  return code(error) === 'ENOTFOUND' || code((error as { cause?: unknown } | null)?.cause) === 'ENOTFOUND';
}

/** The guest's side: spends the link's token on its host, then keeps the host as a contact and dials it. */
export async function joinContact(store: ContactStore, core: Core, link: string): Promise<Contact> {
  const invite = decodeInvite(link);
  const self = store.card();
  if (invite.coreId === self.coreId) throw invalidParams('link: this invitation is this core\'s own', { field: 'link' });
  if (store.has(invite.coreId)) throw refused('link: already a contact; remove it first to link again');
  if (core.coordination.trusted().some(peer => peer.coreId === invite.coreId)) throw refused('link: that core is already one of your machines');
  const release = store.reserve(invite.coreId);
  try {
    return await spendInvite(store, core, invite, self);
  } finally {
    release();
  }
}

/** Accepts the share, spends the token and keeps the host, while the join holds its slot. */
async function spendInvite(store: ContactStore, core: Core, invite: Invitation, self: ContactCard): Promise<Contact> {
  if (invite.share !== null && store.tailscale.hasKey()) {
    try { await store.tailscale.acceptShare(invite.share); } catch (error) {
      core.log('warn', `contacts: the Tailscale share of ${invite.machine} was not accepted: ${messageOf(error)}`, { source: 'contacts' });
    }
  }
  await checkTailnetName(invite.url, 'link.url');
  const nonce = randomUUID();
  const body = JSON.stringify({ nonce, at: Date.now(), token: invite.token, card: self });
  const signature = core.coordination.signature(Buffer.from(`${JOIN_INPUT}${body}`)).toString('base64');
  const context = { from: self.coreId, to: invite.coreId };
  const sealed = seal(pack(body, signature), invite.box, context);
  let response: Response;
  try {
    response = await fetch(`${invite.url}${CONTACT_JOIN_ROUTE}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-boite-peer': self.coreId, 'x-boite-signature': SEALED },
      body: sealed.body,
    });
  } catch (error) {
    // An https origin is the inviter's Funnel: no share to accept, the inviter's side is down,
    // or Tailscale has not put its name in public DNS yet. The token is unspent: the same join works later.
    if (invite.url.startsWith('https:') && notFound(error)) {
      throw unavailable(`could not find ${invite.machine} at ${invite.url}: Tailscale has not published its address on the internet yet, which takes a few minutes; join again shortly`, { retryAfterMs: JOIN_RETRY_MS });
    }
    throw unavailable(invite.url.startsWith('https:')
      ? `could not reach ${invite.machine} at ${invite.url}: its Boite or its Tailscale Funnel is off; ask the inviter to check, then join again`
      : `could not reach ${invite.machine} at ${invite.url}: accept its Tailscale share, or ask for an invitation for another network, then join again`);
  }
  const raw = await boundedBody(response.body, JOIN_BODY_MAX).catch(() => '');
  if (response.headers.get('x-boite-signature') !== SEALED) throw refused(`${invite.machine} refused the join (${response.status}: ${raw.slice(0, 200)})`);
  let reply: { nonce?: unknown; card?: unknown; error?: unknown };
  try {
    const opened = unpack(openResponse(raw, sealed.responseKey, context));
    if (!verify(null, Buffer.from(`${JOINED_INPUT}${opened.body}`), invite.publicKey, Buffer.from(opened.signature, 'base64'))) throw new Error('signature');
    reply = JSON.parse(opened.body) as typeof reply;
  } catch {
    throw unavailable(`${invite.machine} answered the join with something it did not sign`);
  }
  if (reply.nonce !== nonce) throw unavailable(`${invite.machine} answered another join`);
  if (typeof reply.error === 'string') throw refused(`${invite.machine} refused the join: ${reply.error.slice(0, 500)}`);
  const card = checkCard(reply.card, 'card');
  if (card.coreId !== invite.coreId || card.box !== invite.box) throw unavailable(`${invite.machine} answered with keys other than its invitation's`);
  // Checked again after the answer: the host may have joined this core meanwhile.
  const existing = store.find(card.coreId);
  if (existing?.role === 'guest') throw refused('link: already a contact; remove it first to link again');
  const contact = existing ? store.reciprocal(card.coreId, invite.url) : store.store({ ...card, machine: invite.machine }, 'guest', invite.url);
  store.arm();
  store.dial(contact);
  return store.view(contact);
}

/** `POST /contacts/join`: a guest spends an invitation token and leaves its card. Every refusal is a 403 the server counts. */
export async function joinRequest(store: ContactStore, core: Core, request: Request): Promise<Response> {
  if (store.isClosed || request.method !== 'POST' || request.headers.has('origin')) return new Response('forbidden', { status: 403 });
  const guest = request.headers.get('x-boite-peer') ?? '';
  if (!/^[0-9a-f]{64}$/.test(guest)) return new Response('x-boite-peer: expected a core id', { status: 403 });
  if (request.headers.get('x-boite-signature') !== SEALED) return new Response('contacts exchange sealed requests only', { status: 400 });
  let opened: { plaintext: string } & Sealing;
  let body: { nonce?: unknown; at?: unknown; token?: unknown; card?: unknown };
  let signature: string;
  let raw: string;
  try {
    opened = core.group.unseal(await boundedBody(request.body, JOIN_BODY_MAX), guest);
    ({ body: raw, signature } = unpack(opened.plaintext));
    body = JSON.parse(raw) as typeof body;
  } catch {
    return new Response('invalid join request', { status: 403 });
  }
  const nonce = typeof body.nonce === 'string' && body.nonce.length <= 100 ? body.nonce : '';
  const answer = (reply: { card?: ContactCard; error?: string }, status: number): Response => {
    const signed = JSON.stringify({ nonce, ...reply });
    const signatureOut = core.coordination.signature(Buffer.from(`${JOINED_INPUT}${signed}`)).toString('base64');
    return new Response(sealResponse(pack(signed, signatureOut), opened.responseKey, opened.context), {
      status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-boite-signature': SEALED },
    });
  };
  try {
    const card = checkCard(body.card, 'card');
    if (card.coreId !== guest) throw invalidParams('card.coreId: expected the core named by x-boite-peer');
    // A live invitation first: a caller without one leaves no nonce behind.
    const hash = typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token) ? tokenHash(body.token) : '';
    if (!store.liveInvites().some(([live]) => live === hash)) throw refused('token: this invitation was already used, cancelled or expired; ask for a new one');
    if (!verify(null, Buffer.from(`${JOIN_INPUT}${raw}`), card.publicKey, Buffer.from(signature, 'base64'))) throw invalidParams('signature: expected the card\'s key to sign the join');
    store.fresh(guest, nonce, body.at);
    // Spent before anything else changes: a second join with the same link finds nothing.
    if (!store.spendInvite(hash)) throw refused('token: this invitation was already used, cancelled or expired; ask for a new one');
    if (card.coreId === core.coordination.card().coreId) throw refused('card: this is the inviting core itself');
    const existing = store.find(card.coreId);
    if (existing?.role === 'host') throw refused('card: already a contact of this core');
    // Contacts are trusted peers too: only another kind of peer is one of this owner's machines.
    if (!existing && core.coordination.trusted().some(peer => peer.coreId === card.coreId)) throw refused('card: that core is already one of this owner\'s machines');
    if (existing) {
      // This core joined the guest's own invitation meanwhile: one relationship stays.
      store.reciprocal(card.coreId, existing.url);
    } else {
      // Outgoing joins in flight hold their slots: this guest cannot take one of them.
      if (store.occupied(card.coreId) >= store.maxContacts) throw refused(`this core has ${store.maxContacts} contacts already`);
      store.store(card, 'host');
    }
    store.arm();
    store.relisten();
    return answer({ card: store.card() }, 200);
  } catch (error) {
    return answer({ error: error instanceof RpcFailure ? error.message : 'the join could not be processed' }, 403);
  }
}
