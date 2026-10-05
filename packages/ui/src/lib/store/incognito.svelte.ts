import { untrack } from 'svelte';
import { RpcErrorCode, type ThreadId } from '@boite/contracts';
import { RpcFailure, type Client } from '../client';
import type { StoreContext } from './context';

type Held = { id: ThreadId; client: Client; generation: number };

/**
 * Leaving an incognito conversation erases it: another thread, a draft, an
 * archive, anything that takes it off the screen. Only the client that holds
 * it asks, so a switch to another core never reaches the wrong one; a core
 * that never hears it erases the conversation when it stops or starts.
 */
export function watchIncognito(ctx: StoreContext): () => void {
  let held: Held | null = null;
  return $effect.root(() => {
    $effect(() => {
      const open = ctx.threads.openThread;
      const id = open?.incognito ? open.id : null;
      untrack(() => {
        const left = held;
        if (left?.id === id) return;
        held = id && ctx.client ? { id, client: ctx.client, generation: ctx.clientGeneration } : null;
        if (left) void erase(ctx, left);
      });
    });
  });
}

async function erase(ctx: StoreContext, { id, client, generation }: Held): Promise<void> {
  if (!ctx.currentClient(client, generation) || client.state !== 'ready') return;
  try {
    await client.call('threads.remove', { threadId: id });
    if (ctx.currentClient(client, generation)) await ctx.threads.removed(id);
  } catch (error) {
    // Already gone, erased from another device or by a restarted core: nothing left to erase.
    if (ctx.currentClient(client, generation) && !(error instanceof RpcFailure && error.code === RpcErrorCode.NotFound)) ctx.fail(error);
  }
}
