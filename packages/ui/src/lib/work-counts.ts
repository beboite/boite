import { threadBusy, type ThreadId, type ThreadSummary } from '@boite/contracts';
import type { Store } from './store.svelte';
import { agentDirectory } from './agent-directory.svelte';
import { needsUser, threadState } from './thread-state';
import { workingThread } from './recent.svelte';

/** How much is at work behind one side of the Threads and Agents switch, and whether any of it waits on the user. */
export interface WorkCount {
  count: number;
  waiting: boolean;
}

/** The threads at work behind the Threads side: `subagents` of `count` are delegated agents, not rows of the list. */
export interface ThreadWork extends WorkCount {
  subagents: number;
}

/**
 * The conversations the thread list draws that are at work: a turn under way,
 * queued, waiting on its delegated agents or on something it left running, or
 * asking the user, plus every delegated agent under them at work or asking, at
 * any depth: seven sub-agents are seven agents running, not one row.
 * Archived projects and archived threads are out of the list, so they are out
 * of the count, and so is a machine that is not connected: a laptop gone to
 * sleep mid-turn would otherwise count as at work for hours.
 */
export function workingThreads(stores: readonly Store[]): ThreadWork {
  let count = 0;
  let subagents = 0;
  let waiting = false;
  for (const store of stores) {
    if (store.connection !== 'ready') continue;
    const children = new Map<ThreadId, ThreadSummary[]>();
    for (const thread of store.threads) {
      if (!thread.parentThreadId || thread.archived) continue;
      const held = children.get(thread.parentThreadId);
      if (held) held.push(thread);
      else children.set(thread.parentThreadId, [thread]);
    }
    const seen = new Set<ThreadId>();
    const descend = (parent: ThreadId) => {
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        const asks = needsUser(child);
        if (asks || threadBusy(child)) subagents++;
        // A grandchild's question never reaches its grandparent's row state: the badge reads it here.
        waiting ||= asks;
        descend(child.id);
      }
    };
    for (const project of store.projects) {
      if (project.archived) continue;
      for (const thread of store.threadsOf(project.id)) {
        if (thread.archived) continue;
        const asks = threadState(thread, store.subagents(thread.id)) === 'waiting';
        if (asks || workingThread(store, thread)) count++;
        waiting ||= asks;
        descend(thread.id);
      }
    }
  }
  return { count: count + subagents, subagents, waiting };
}

/**
 * The agents at work: every persistent agent with a turn under way, a
 * question for the user or work left running, and every entrusted thread
 * mid-turn, one thread counted once. The agents snapshot only loads with the
 * Agents experiment on; without it nothing counts here.
 */
export function agentsAtWork(stores: readonly Store[]): WorkCount {
  let count = 0;
  let waiting = false;
  for (const store of stores) {
    const seen = new Set<string>();
    const add = (thread: ThreadSummary, asks: boolean) => {
      if (seen.has(thread.id)) return;
      seen.add(thread.id);
      count++;
      waiting ||= asks;
    };
    const directory = agentDirectory(store);
    for (const { thread, waiting: asks } of directory.atWork) add(thread, asks || needsUser(thread));
    const busy = (thread: ThreadSummary) => needsUser(thread) || workingThread(store, thread);
    // An agent's own thread at rest can still ask the user (`boite ask`) or keep work in the background.
    for (const thread of store.threads) {
      if (!thread.archived && thread.agentSessionId && busy(thread) && directory.ownerOf(thread)) add(thread, needsUser(thread));
    }
    for (const { thread } of directory.entrusted) if (busy(thread)) add(thread, needsUser(thread));
  }
  return { count, waiting };
}
