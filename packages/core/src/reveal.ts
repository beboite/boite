/*
 * `ui.reveal`: another owner app on this machine, such as the Bots desktop
 * plugin, asks Boite's own window to show a thread, an agent's page or the
 * app updates. The core only relays: the event goes to owner connections, and
 * the desktop shell is the client that acts on it (packages/ui/src/lib/reveal.ts).
 * A thread or an agent may live on another machine the core knows, a member of
 * its group or a machine trusted for coordination: the window opens it there.
 */

import type { RpcParams, UiRevealTarget } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';

const EXPECTED = '{ kind: "thread", threadId, coreId? }, { kind: "agent", agentId, coreId? } or { kind: "update" }';
const MACHINE_ID = /^[0-9a-f]{64}$/;
const MACHINE = 'this core\'s id, a machine of its group or a machine trusted for coordination';

/**
 * The machine a target lives on: undefined for this core (no `coreId`, or its
 * own), else the id of another machine the core already knows, as its group's
 * roster or its coordination links list it.
 */
function machineOf(core: Core, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !MACHINE_ID.test(raw)) {
    throw invalidParams(`ui.reveal target.coreId must be ${MACHINE}, 64 lowercase hex characters`, { field: 'target.coreId', expected: MACHINE });
  }
  if (raw === core.coordination.card().coreId) return undefined;
  // A contact's threads are its owner's: this owner's windows never open them.
  if (core.contacts.isContact(raw) || !core.coordination.trusted().some((peer) => peer.coreId === raw)) {
    throw invalidParams(`ui.reveal target.coreId ${raw} is not ${MACHINE}`, { field: 'target.coreId', expected: MACHINE });
  }
  return raw;
}

/**
 * The target, checked: a thread this core knows or one on another machine it
 * knows, an agent id, or the app updates. A target on this core carries no
 * `coreId`, so the window handles it as it did before machines were named.
 */
export function revealTarget(core: Core, raw: unknown): UiRevealTarget {
  const target = raw as Record<string, unknown> | null | undefined;
  if (target?.['kind'] === 'thread' && typeof target['threadId'] === 'string') {
    const threadId = target['threadId'];
    const coreId = machineOf(core, target['coreId']);
    if (coreId !== undefined) {
      // That machine's journal is not here: the window finds out when it opens the thread there.
      if (threadId.length === 0 || threadId.length > 200) throw invalidParams('ui.reveal target.threadId must be 1 to 200 characters', { field: 'target.threadId', expected: 'a thread id' });
      return { kind: 'thread', threadId, coreId };
    }
    if (core.journal.getThread(threadId) === null) {
      throw invalidParams(`ui.reveal target.threadId ${threadId} is not a thread of this core`, { field: 'target.threadId', expected: 'a thread id' });
    }
    return { kind: 'thread', threadId };
  }
  if (target?.['kind'] === 'agent' && typeof target['agentId'] === 'string' && target['agentId'].length > 0 && target['agentId'].length <= 200) {
    const agentId = target['agentId'];
    const coreId = machineOf(core, target['coreId']);
    return coreId === undefined ? { kind: 'agent', agentId } : { kind: 'agent', agentId, coreId };
  }
  if (target?.['kind'] === 'update') return { kind: 'update' };
  throw invalidParams(`ui.reveal target must be ${EXPECTED}`, { field: 'target', expected: EXPECTED });
}

export function reveal(core: Core, params: RpcParams<'ui.reveal'>): { delivered: number } {
  return { delivered: core.subscribers.reveal(revealTarget(core, params?.target)) };
}
