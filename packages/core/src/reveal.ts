/*
 * `ui.reveal`: another owner app on this machine, such as the Bots desktop
 * plugin, asks Boite's own window to show a thread, an agent's page or the
 * app updates. The core only relays: the event goes to owner connections, and
 * the desktop shell is the client that acts on it (packages/ui/src/lib/reveal.ts).
 */

import type { RpcParams, UiRevealTarget } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';

const EXPECTED = '{ kind: "thread", threadId }, { kind: "agent", agentId } or { kind: "update" }';

/** The target, checked: a thread this core knows, an agent id, or the app updates. */
export function revealTarget(core: Core, raw: unknown): UiRevealTarget {
  const target = raw as Record<string, unknown> | null | undefined;
  if (target?.['kind'] === 'thread' && typeof target['threadId'] === 'string') {
    const threadId = target['threadId'];
    if (core.journal.getThread(threadId) === null) {
      throw invalidParams(`ui.reveal target.threadId ${threadId} is not a thread of this core`, { field: 'target.threadId', expected: 'a thread id' });
    }
    return { kind: 'thread', threadId };
  }
  if (target?.['kind'] === 'agent' && typeof target['agentId'] === 'string' && target['agentId'].length > 0 && target['agentId'].length <= 200) {
    return { kind: 'agent', agentId: target['agentId'] };
  }
  if (target?.['kind'] === 'update') return { kind: 'update' };
  throw invalidParams(`ui.reveal target must be ${EXPECTED}`, { field: 'target', expected: EXPECTED });
}

export function reveal(core: Core, params: RpcParams<'ui.reveal'>): { delivered: number } {
  return { delivered: core.subscribers.reveal(revealTarget(core, params?.target)) };
}
