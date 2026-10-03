import { JOURNAL_INSPECTION_TABLES, RpcErrorCode, type JournalInspectionIssue, type JournalInspectionTable } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** Mirror the read-only projection view; the fixture has objects, not SQLite JSON storage. */
export function journalInspectionMethods(ctx: FakeContext): Pick<FakeMethods,'journal.inspect'> {
  const keys = new Map<JournalInspectionTable,Map<string,number>>();
  const rowId = (table: JournalInspectionTable,key: string): number => {
    const map = keys.get(table) ?? new Map<string,number>(); keys.set(table,map);
    if (!map.has(key)) map.set(key,map.size+1);
    return map.get(key)!;
  };
  return { 'journal.inspect': async params => {
    if (ctx.bus.principal !== 'owner') throw new RpcFailure({code:RpcErrorCode.Refused,message:'journal.inspect is for the owner only'});
    if (!params || typeof params !== 'object') throw new RpcFailure({code:RpcErrorCode.InvalidParams,message:'journal.inspect: expected an object'});
    const limit = params.limit ?? 100, start = params.cursor ?? {table:'threads',afterRowid:0};
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !JOURNAL_INSPECTION_TABLES.includes(start.table) || !Number.isSafeInteger(start.afterRowid) || start.afterRowid < 0) throw new RpcFailure({code:RpcErrorCode.InvalidParams,message:'expected limit 1 to 500 and a known table with nonnegative safe-integer afterRowid'});
    const rows: {table:JournalInspectionTable;rowId:number;issues:JournalInspectionIssue[]}[] = [];
    const add = (table:JournalInspectionTable,key:string,cases:{code:JournalInspectionIssue['code'];field:string;expected:string}[]):void => {
      const id = rowId(table,key); rows.push({table,rowId:id,issues:cases.map(issue => ({...issue,table,rowId:id}))});
    };
    for (const thread of ctx.threads.values()) {
      const originIssues: {code:JournalInspectionIssue['code'];field:string;expected:string}[] = [];
      const origin = thread.forkOrigin;
      if (origin && (origin.threadId === thread.id || !['native','seeded'].includes(origin.mode))) originIssues.push({code:'invalid-fork-origin',field:'fork_origin',expected:'a distinct source and native or seeded mode'});
      add('threads',thread.id,originIssues);
      for (const turn of thread.turns) {
        const problems: typeof originIssues = [];
        if (turn.threadId !== thread.id) problems.push({code:'turn-thread-mismatch',field:'thread_id',expected:'the owning thread'});
        if (turn.queueHold && (turn.status !== 'queued' || turn.startedAt !== null)) problems.push({code:'invalid-queue-hold',field:'queue_hold',expected:'an unstarted queued turn held after core restart'});
        add('turns',turn.id,problems);
      }
      for (const message of thread.messages) {
        const problems: typeof originIssues = [], turn = thread.turns.find(turn => turn.id === message.turnId);
        if (!ctx.threads.has(message.threadId)) problems.push({code:'missing-thread',field:'thread_id',expected:'an existing owning thread'});
        if (!turn) problems.push({code:'missing-turn',field:'turn_id',expected:'an existing turn'});
        else {
          if (turn.threadId !== message.threadId) problems.push({code:'turn-thread-mismatch',field:'turn_id',expected:'a turn of the owning thread'});
          if (message.state === 'streaming' && ['done','error','stopped'].includes(turn.status)) problems.push({code:'terminal-streaming-message',field:'state',expected:'a non-streaming message on a terminal turn'});
        }
        add('messages',message.id,problems);
      }
      for (const task of thread.backgroundHistory ?? []) {
        const problems: typeof originIssues = [];
        if (task.threadId !== thread.id) problems.push({code:'invalid-background-observation',field:'payload',expected:'matching native identity'});
        if (task.state === 'running' && (task.providerId !== thread.providerId || task.sessionGeneration !== (thread.sessionGeneration ?? 0))) problems.push({code:'background-owner-mismatch',field:'session_generation',expected:'live work owned by the current provider and session generation'});
        add('background_observations',`${thread.id}:${task.providerId}:${task.sessionGeneration}:${task.parentTurnId}:${task.id}`,problems);
      }
    }
    for (const [threadId,letters] of ctx.letters) for (const letter of letters) add('coordination_letters',`${threadId}:${letter.id}`,ctx.threads.has(threadId) ? [] : [{code:'missing-thread',field:'thread_id',expected:'an existing owning thread'}]);
    rows.sort((a,b) => JOURNAL_INSPECTION_TABLES.indexOf(a.table)-JOURNAL_INSPECTION_TABLES.indexOf(b.table) || a.rowId-b.rowId);
    const after = rows.filter(row => JOURNAL_INSPECTION_TABLES.indexOf(row.table) > JOURNAL_INSPECTION_TABLES.indexOf(start.table) || (row.table === start.table && row.rowId > start.afterRowid));
    const page = after.slice(0,limit), next = after[limit];
    const last = page.at(-1);
    return {issues:page.flatMap(row => row.issues),checked:page.length,truncated:next !== undefined,cursor:next && last ? {table:last.table,afterRowid:last.rowId}:null};
  } };
}
