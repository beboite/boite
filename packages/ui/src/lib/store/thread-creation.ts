import { RpcFailure, type Client } from '../client';
import type { RpcParams, Thread } from '@boite/contracts';

/** create subscribed before hydration; events can be newer than get's snapshot. */
export function mergeCreationSnapshot(snapshot: Thread, live: Thread): void {
  const messages = new Map(snapshot.messages.map(message => [message.id, message]));
  for (const message of live.messages) messages.set(message.id, message);
  snapshot.messages = [...messages.values()];
  const turns = new Map(snapshot.turns.map(turn => [turn.id, turn]));
  for (const turn of live.turns) turns.set(turn.id, turn);
  snapshot.turns = [...turns.values()];
  if (live.commands.length) snapshot.commands = live.commands;
}

/** A stale compatible lease falls back to ordinary creation on the same client. */
export function createWithPreparation(client: Client, input: RpcParams<'threads.create'>, current: () => boolean) {
  return client.call('threads.create', input).catch(async (error: unknown) => {
    const reason = error instanceof RpcFailure ? (error.data as { reason?: string } | undefined)?.reason : undefined;
    if (!input.preparationId || !reason?.startsWith('draft-preparation-') || !current()) throw error;
    await client.call('drafts.release', { preparationId: input.preparationId }).catch(() => undefined);
    if (!current()) throw error;
    const { preparationId: _preparationId, ...ordinary } = input;
    return client.call('threads.create', ordinary);
  });
}
