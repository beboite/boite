/*
 * Who may call what.
 *
 * The owner is the process holding the core token: the shell, the dev client,
 * anything that can read `core.json`. A paired device holds a session token it
 * got through a pairing link, and it is a guest: it reads the threads and their
 * working trees (never writing a file), answers what an agent asks and sends
 * prompts. The one route it changes is the owner's saved subscription
 * gateway, which it may turn on or off and never reconfigure.
 *
 * An agent holds the per-thread token the core put in the environment of a
 * process its thread launched. It is the narrowest of the three: it reaches
 * `AGENT_METHODS` and only ever on its own thread.
 *
 * The device and agent lists live in `packages/contracts/src/access.ts`, with
 * the decision below them, so the in-memory client refuses what the core
 * refuses. Together they are
 * the whole boundary: read them when asking what a stolen phone, or an agent
 * that went off, is worth. A method that is in neither is the owner's: a new
 * method added tomorrow is refused to both until someone decides otherwise,
 * on purpose.
 * core.logs stays owner-only: diagnostic causes can describe other threads,
 * local paths and account failures even after credential redaction. Agents
 * read the anonymized diagnostics.* view instead, which the owner can turn off.
 * resources.usage permits paired reads of sanitized metrics; process traces,
 * resource settings and tree termination remain owner-only.
 * speech.streamStart/Chunk/Finish permit phone dictation only through the
 * owner's configured engine; sessions and cancellation belong to one connection.
 * threads.archive lets a paired phone mark an idle conversation done under the
 * owner's retention policy. Direct removal and policy changes stay owner-only;
 * restoring an archive cancels its expiry before recoverable cleanup.
 * quotas.list and subscriptionProxy.quotas let a phone draw the same limit bars
 * as the owner without a dashboard embed; a forced refresh reaches the
 * providers and stays the owner's, as do monitoring switches and resets.
 * quotas.alert lets a phone choose when a window it already reads notifies;
 * the alert check reads only the accounts that have an alert, every five
 * minutes, the cadence the core keeps whoever set it.
 * subscriptionProxy.setEnabled lets a phone turn the owner's configured gateway
 * on or off; its kind, URLs and key stay owner-only (subscriptionProxy.configure).
 * push.kinds lets a paired device choose which kinds of notification its own
 * subscription receives; it reaches no other device's destination.
 * secrets.answer and secrets.delete reach a paired device only over an
 * encrypted link (`Connection.encrypted`): loopback, Tailscale, or HTTPS
 * terminated on this machine. Plain HTTP from the LAN is refused with the
 * reason, so a key or its deletion never crosses the network in clear.
 * homeCards.list and homeCards.refresh let a phone read and refresh the
 * owner's home cards. A refresh runs only the command the owner wrote in that
 * card's refresh.json, never one a client names, and joins a run already going.
 * policy.get lets a paired device draw the controls the admin policy locks,
 * as the desktop does. It holds no secret, only what the file says and where
 * it lies; no RPC changes it, only an administrator editing the file.
 */

import { AGENT_EVENTS, AGENT_METHODS, accessRefusal, DEVICE_EVENTS, DEVICE_METHODS, mayHearEvent, type RpcEventName, type RpcMethodName } from '@boite/contracts';
import { refused } from './errors.ts';
import type { Connection } from './router.ts';

export { AGENT_EVENTS, AGENT_METHODS, DEVICE_EVENTS, DEVICE_METHODS };

export function mayReceiveEvent(name: RpcEventName, connection: Connection): boolean {
  return mayHearEvent(name, connection.identity.principal);
}

/** Throws unless the connection may call the method, naming the method. */
export function assertAllowed(method: RpcMethodName, connection: Connection, params?: unknown): void {
  const refusal = accessRefusal(method, connection.identity, params);
  if (refusal) throw refused(refusal.message, refusal.data);
}
