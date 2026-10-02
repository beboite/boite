import { normalizeCoreLogText, validateCoreLogsQuery, RpcErrorCode, type CoreLogRecord, type RpcEventName, type RpcEvents } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

export function logMethods(ctx: FakeContext): Pick<FakeMethods, 'core.logs'> {
  return { 'core.logs': async raw => {
    let query;
    try { query = validateCoreLogsQuery(raw); }
    catch (error) { throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: (error as Error).message }); }
    return structuredClone(ctx.logs.slice().reverse().filter(record => (query.threadId === undefined || record.threadId === query.threadId) && (query.level === undefined || record.level === query.level)).slice(0, query.limit));
  } };
}

/** The fake captures the same lifecycle metadata, even without a subscribed client. */
export function observeLog<E extends RpcEventName>(ctx: FakeContext, event: E, payload: RpcEvents[E]): void {
  let record: Omit<CoreLogRecord, 'id' | 'runId'>;
  if (event === 'core.log') {
    const log = payload as RpcEvents['core.log'];
    record = { at: log.at, level: log.level, source: log.source ?? 'core', event: log.event ?? event, message: log.kind === 'provider-output' ? '[provider output omitted]' : normalizeCoreLogText(log.message), ...(log.threadId === undefined ? {} : { threadId: log.threadId }), ...(log.turnId === undefined ? {} : { turnId: log.turnId }), ...(log.requestId === undefined ? {} : { requestId: log.requestId }) };
  } else if (event === 'scheduler.updated') {
    const state = payload as RpcEvents['scheduler.updated'];
    for (const entry of state.queued) if (!ctx.logQueued.has(entry.turnId)) add(ctx, { at: entry.queuedAt, level: 'info', source: 'scheduler', event: 'turn.queued', message: 'Turn queued', threadId: entry.threadId, turnId: entry.turnId });
    ctx.logQueued = new Set(state.queued.map(entry => entry.turnId));
    return;
  } else if (event === 'turn.started' || event === 'turn.finished') {
    const turn = payload as RpcEvents['turn.started'];
    if (event === 'turn.started') ctx.logTurns.set(turn.threadId, turn.id);
    else if (ctx.logTurns.get(turn.threadId) === turn.id) ctx.logTurns.delete(turn.threadId);
    record = { at: (event === 'turn.started' ? turn.startedAt : turn.finishedAt) ?? ctx.now(), level: turn.status === 'error' ? 'error' : 'info', source: 'turns', event, message: event === 'turn.started' ? 'Turn started' : `Turn finished: ${turn.status}`, threadId: turn.threadId, turnId: turn.id };
  } else if (event === 'process.started' || event === 'process.exited') {
    const proc = payload as RpcEvents['process.started'];
    const key = `${proc.threadId}:${proc.pid}`;
    const turnId = ctx.logProcesses.get(key) ?? ctx.logTurns.get(proc.threadId);
    if (event === 'process.started' && turnId !== undefined) ctx.logProcesses.set(key, turnId);
    if (event === 'process.exited') ctx.logProcesses.delete(key);
    record = { at: (event === 'process.started' ? proc.startedAt : proc.exitedAt) ?? ctx.now(), level: event === 'process.exited' && proc.exitCode !== null && proc.exitCode !== 0 ? 'warn' : 'info', source: 'processes', event, message: event === 'process.started' ? `Process started: pid ${proc.pid}` : `Process exited: pid ${proc.pid}, code ${proc.exitCode ?? 'unknown'}`, threadId: proc.threadId, ...(turnId === undefined ? {} : { turnId }) };
  } else return;
  add(ctx, record);
}

function add(ctx: FakeContext, record: Omit<CoreLogRecord, 'id' | 'runId'>): void {
  const bounded = (value: string): string => normalizeCoreLogText(value).replace(/[\r\n\t]/g, ' ').slice(0, 200);
  ctx.logs.push({ ...record, id: `${ctx.logRunId}:${++ctx.logSequence}`, runId: ctx.logRunId, message: normalizeCoreLogText(record.message), source: bounded(record.source), event: bounded(record.event), ...(record.threadId === undefined ? {} : { threadId: bounded(record.threadId) }), ...(record.turnId === undefined ? {} : { turnId: bounded(record.turnId) }), ...(record.requestId === undefined ? {} : { requestId: bounded(record.requestId) }) });
  if (ctx.logs.length > 4096) ctx.logs.shift();
}
