/*
 * What crosses between two cores, below any meaning: a bounded body, one
 * signed request to one address, and the reply once its signature holds.
 * `coordination.ts` decides who is asked and what the answer changes.
 */

import { verify } from 'node:crypto';
import { invalidParams } from './errors.ts';

export const MAX_BODY = 262_144;
export const ROUTE = '/agent-messages';

/** The peer signed a refusal: asking again would get the same one. */
export class PeerRefusal extends Error {}
/** The peer answered, signed, that it removed this core from its group. */
export class PeerGone extends Error {}

/**
 * A reply whose signature held: an answer, a refusal the peer signed, or its
 * word that this core was removed from its group. `url` is the address that
 * answered, null when the owner's app relayed.
 */
export type Answer = { url: string | null; result?: unknown; refusal?: string; gone?: true };

export async function boundedBody(body: ReadableStream<Uint8Array> | null, max = MAX_BODY): Promise<string> {
  if (!body) throw invalidParams('message body required');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('peer body timed out')), 5000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > max) throw invalidParams(`message body exceeds ${max} bytes`);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** A reply counts only once the peer's signature on it holds and it answers this request. */
export function settle(url: string | null, publicKey: string, nonce: string, status: number, raw: string, signature: string): Answer {
  if (!signature && status === 403) throw new Error('destination refused this core; reconnect the agent link in Machines');
  if (!verify(null, Buffer.from(raw), publicKey, Buffer.from(signature, 'base64'))) throw new Error('invalid peer response signature');
  const reply = JSON.parse(raw) as { nonce: string; result?: unknown; error?: string };
  if (reply.nonce !== nonce) throw new Error('peer response nonce mismatch');
  if (status === 410) return { url, gone: true };
  if (reply.error && status === 400) return { url, refusal: reply.error };
  if (status < 200 || status >= 300) throw new Error('peer request failed');
  return { url, result: reply.result };
}

/** One signed request to one address of a peer. */
export async function post(url: string, from: string, publicKey: string, body: string, signature: string, nonce: string): Promise<Answer> {
  const response = await fetch(`${url}${ROUTE}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-boite-peer': from, 'x-boite-signature': signature },
    body,
  });
  return settle(url, publicKey, nonce, response.status, await boundedBody(response.body), response.headers.get('x-boite-signature') ?? '');
}
