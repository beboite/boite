import { ChangeLog, listCursorProblem, type RpcEventName, type RpcEvents, type RpcParams, type ThreadListChanges } from '@boite/contracts';
import type { EventPayload } from '../bus.ts';
import type { Core } from '../core.ts';
import { invalidParams } from '../errors.ts';
import { newId } from '../ids.ts';
import { withLoad } from './records.ts';

/**
 * `threads.listChanges`: the sidebar list once, then only the threads that
 * changed. Every change to a summary reaches the clients as `thread.created`,
 * `thread.updated` or `thread.removed`, so those events, counted once they
 * commit, are the change log: a reconnecting client is answered what a client
 * that stayed connected heard. Load samples are not counted; the answer
 * carries every thread with live processes instead.
 */
export class ThreadListLog {
  readonly log = new ChangeLog(newId('run_'));

  constructor(private readonly core: Core) {
    core.bus.onCommitted((name, payload) => {
      const id = changedThread(name, payload);
      if (id !== null) this.log.note(id);
    });
  }

  answer(params: RpcParams<'threads.listChanges'>): ThreadListChanges {
    const since = params?.since;
    if (since !== undefined) {
      const problem = listCursorProblem(since);
      if (problem) throw invalidParams(`threads.listChanges.${problem.field}: expected ${problem.expected}`, problem);
    }
    // Read with the rows, before anything else can change: nothing awaits in between.
    const cursor = this.log.cursor();
    const changed = since === undefined ? null : this.log.since(since);
    if (changed === null) return { kind: 'full', cursor, threads: this.core.threads.list({}) };
    const asked = new Set([...changed, ...this.core.procs.liveThreads()]);
    const threads = this.core.journal.listThreadsIn(asked).filter(thread => !thread.archived).map(thread => withLoad(this.core, thread));
    const listed = new Set(threads.map(thread => thread.id));
    return { kind: 'changes', cursor, threads, removed: changed.filter(id => !listed.has(id)) };
  }
}

function changedThread(name: RpcEventName, payload: EventPayload): string | null {
  if (name === 'thread.created' || name === 'thread.updated') return (payload as RpcEvents['thread.updated']).id;
  if (name === 'thread.removed') return (payload as RpcEvents['thread.removed']).threadId;
  return null;
}
