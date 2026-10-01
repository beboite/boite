import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import type { Machine } from './workspace.svelte';

type Route = { source: Machine; target: Machine; sourceClient: Client; targetClient: Client; toCoreId: string; off: () => void };
const routes = new Map<string, Route>();
const keyOf = (source: Machine, target: Machine) => `${source.id}\0${target.id}`;

/** Relays only between the owner's connections; signed envelopes and destination permissions stay with the cores. */
async function route(source: Machine, target: Machine, fromCoreId: string, toCoreId: string): Promise<boolean> {
  const sourceClient = source.store.client, targetClient = target.store.client;
  if (!sourceClient || !targetClient || !source.store.owner || !target.store.owner) return false;
  const key = keyOf(source, target);
  const previous = routes.get(key);
  if (previous?.sourceClient === sourceClient && previous.targetClient === targetClient && previous.toCoreId === toCoreId) {
    await sourceClient.call('collaboration.bridge.register', { coreId: toCoreId, enabled: true });
    return true;
  }
  previous?.off();
  const off = sourceClient.on('collaboration.bridge.request', request => {
    if (request.fromCoreId !== fromCoreId || request.toCoreId !== toCoreId) return;
    void (async () => {
      let response;
      try {
        if (source.store.client !== sourceClient || target.store.client !== targetClient || !source.store.owner || !target.store.owner
          || source.store.connection !== 'ready' || target.store.connection !== 'ready') throw new Error('destination owner connection is unavailable');
        response = await targetClient.call('collaboration.bridge.forward', { coreId: fromCoreId, body: request.body, signature: request.signature });
      } catch (error) {
        response = { status: 503, body: error instanceof Error ? error.message : String(error), signature: '' };
      }
      // An expired request or a disconnected source needs no replay. The source reports its failure to its caller.
      await sourceClient.call('collaboration.bridge.reply', { requestId: request.requestId, response }).catch(() => undefined);
    })();
  });
  try {
    await sourceClient.call('collaboration.bridge.register', { coreId: toCoreId, enabled: true });
    routes.set(key, { source, target, sourceClient, targetClient, toCoreId, off });
    return true;
  } catch (error) {
    off(); routes.delete(key);
    if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return false;
    throw error;
  }
}

export async function bridgeMachines(a: Machine, b: Machine, coreA: string, coreB: string): Promise<boolean> {
  const forward = await route(a, b, coreA, coreB);
  const reverse = await route(b, a, coreB, coreA);
  if (forward && reverse) return true;
  forgetBridge(a, b);
  return false;
}

export function forgetBridge(a: Machine, b: Machine): void {
  for (const key of [keyOf(a, b), keyOf(b, a)]) {
    const held = routes.get(key);
    if (!held) continue;
    held.off(); routes.delete(key);
    void held.sourceClient.call('collaboration.bridge.register', { coreId: held.toCoreId, enabled: false }).catch(() => undefined);
  }
}

/** Routes cannot outlive the app watcher or either remembered machine. */
export function pruneBridges(machines: Machine[]): void {
  for (const route of routes.values()) if (!machines.includes(route.source) || !machines.includes(route.target)) forgetBridge(route.source, route.target);
}

export function closeBridges(): void { for (const route of [...routes.values()]) forgetBridge(route.source, route.target); }
