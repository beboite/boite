/*
 * The joining side of a group invitation: one sealed request to the member that
 * minted it, and its answer checked against the key the invitation names.
 * The member's side is `GroupStore.http` (docs/groups.md).
 */
import { verify } from 'node:crypto';
import { boundedBody, MAX_BODY } from '../coordination-wire.ts';
import { fingerprint } from './roster.ts';
import { openResponse, SEALED, unpack, type Sealing } from './seal.ts';
import { inviteId, type Invite } from './ticket.ts';

export const JOIN_ROUTE = '/group/join';
/** What a join request and its answer are signed with, so neither passes for a coordination message. */
export const JOIN_SIGNING_PREFIX = 'boite-group-join\n';
const JOIN_TIMEOUT_MS = 8000;

export interface JoinReply { nonce: string; publicKey: string; roster?: unknown; error?: string }

export async function askToJoin(url: string, invite: Invite, sealed: { body: string } & Sealing, nonce: string): Promise<JoinReply> {
  const response = await fetch(`${url}${JOIN_ROUTE}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-boite-peer': sealed.context.from, 'x-boite-invite': inviteId(invite.t), 'x-boite-signature': SEALED },
    body: sealed.body,
  });
  const raw = await boundedBody(response.body, MAX_BODY);
  // Only the machine that minted the invitation can answer under this key.
  if (response.headers.get('x-boite-signature') !== SEALED) throw new Error('the answer is not sealed');
  const { body, signature } = unpack(openResponse(raw, sealed.responseKey, sealed.context));
  const reply = JSON.parse(body) as JoinReply;
  // The invitation names who must answer: a machine with another key is not it.
  const key = fingerprint(reply.publicKey);
  if (key.coreId !== invite.c) throw new Error('another machine answered');
  if (!verify(null, Buffer.from(JOIN_SIGNING_PREFIX + body), key.publicKey, Buffer.from(signature, 'base64'))) throw new Error('invalid signature');
  if (reply.nonce !== nonce) throw new Error('nonce mismatch');
  return reply;
}
