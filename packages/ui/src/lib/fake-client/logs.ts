import {
  createLogAnonymizer, formatLogLine, formatLogTime, ISSUE_REPOSITORY, logLevelAtLeast, logMatches, normalizeCoreLogText, normalizeLogData, validateCoreLogsQuery, validateDiagnosticReport,
  validateDiagnosticsLogsQuery, RpcErrorCode,
  type CoreLogLevel, type CoreLogRecord, type DiagnosticProblem, type DiagnosticsExport, type DiagnosticSummary, type DiagnosticThread, type LogAnonymizer, type RpcEventName, type RpcEvents,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';
import { DATA_DIR, toSummary } from './shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_LIMIT = 20_000;
const REPORTS_PER_MINUTE = 300;
const PREFILL_BODY_CHARS = 6_000;

type DiagnosticMethods = 'core.logs' | 'diagnostics.logs' | 'diagnostics.summary' | 'diagnostics.export' | 'diagnostics.issue' | 'diagnostics.report';

function invalid(error: unknown): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.InvalidParams, message: (error as Error).message });
}

function refused(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message });
}

/**
 * The real core's `Diagnostics` (`packages/core/src/diagnostics.ts`) with the
 * same validation and access, over the fake's in-memory records. `gh` is never
 * installed here, so an issue is always a draft and a prefilled link.
 */
export function logMethods(ctx: FakeContext): Pick<FakeMethods, DiagnosticMethods> {
  let reportBudget = { minute: 0, count: 0 };

  /** The core's gate: an agent reads only while the owner allows it, and only for its own thread, which the fixture cannot prove. */
  const gate = (): void => {
    if (ctx.bus.principal !== 'agent') return;
    if (ctx.settings.agentLogAccess === false) throw refused('diagnostics: the owner turned off agent access to logs (Settings > Diagnostics)');
    throw refused('diagnostics: an agent names its own thread');
  };

  const anonymizer = (): LogAnonymizer => createLogAnonymizer({
    salt: 'fake-salt', home: 'C:\\Users\\you', user: 'you', hostname: 'fake-host', dataDir: DATA_DIR,
    projects: ctx.projects.map(project => ({ path: project.path, name: project.name })),
  });

  const newestFirst = (keep: (record: CoreLogRecord) => boolean, limit: number): CoreLogRecord[] => {
    const out: CoreLogRecord[] = [];
    for (let index = ctx.logs.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const record = ctx.logs[index]!;
      if (keep(record)) out.push(structuredClone(record));
    }
    return out;
  };

  const summarize = (records: readonly CoreLogRecord[], since: number, names: LogAnonymizer): DiagnosticSummary => {
    const counts: Record<CoreLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const problems = new Map<string, DiagnosticProblem>();
    const perThread = new Map<string, { warnings: number; errors: number; lastError: string | null }>();
    for (const record of records) {
      counts[record.level] += 1;
      if (record.threadId !== undefined) {
        const entry = perThread.get(record.threadId) ?? { warnings: 0, errors: 0, lastError: null };
        if (record.level === 'warn') entry.warnings += 1;
        if (record.level === 'error') { entry.errors += 1; entry.lastError ??= record.message.slice(0, 300); }
        perThread.set(record.threadId, entry);
      }
      if (!logLevelAtLeast(record.level, 'warn')) continue;
      const key = `${record.origin ?? 'core'}|${record.source}|${record.event}|${record.level}`;
      const problem = problems.get(key);
      if (problem === undefined) {
        problems.set(key, { origin: record.origin ?? 'core', source: record.source, event: record.event, level: record.level as 'warn' | 'error', count: 1, firstAt: record.at, lastAt: record.at, message: record.message.slice(0, 500), threadIds: record.threadId ? [record.threadId] : [] });
      } else {
        problem.count += 1;
        if (record.at < problem.firstAt) problem.firstAt = record.at;
        if (record.at >= problem.lastAt) { problem.lastAt = record.at; problem.message = record.message.slice(0, 500); }
        if (record.threadId && !problem.threadIds.includes(record.threadId) && problem.threadIds.length < 5) problem.threadIds.push(record.threadId);
      }
    }
    const mentioned = new Set(records.flatMap(record => [record.threadId, record.parentThreadId].filter((id): id is string => id !== undefined)));
    const threads: DiagnosticThread[] = [...ctx.threads.values()].map(toSummary).filter(thread => mentioned.has(thread.id)).map(thread => {
      const seen = perThread.get(thread.id);
      return {
        threadId: thread.id, providerId: thread.providerId, model: thread.model, effort: thread.effort, status: thread.status,
        parentThreadId: thread.parentThreadId ?? null, project: names.project(ctx.projects.find(project => project.id === thread.projectId)?.path ?? null),
        archived: thread.archived, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
        warnings: seen?.warnings ?? 0, errors: seen?.errors ?? 0, lastError: seen?.lastError ?? null,
      };
    });
    const bytes = new TextEncoder().encode(ctx.logs.map(record => JSON.stringify(record)).join('\n')).length;
    return {
      generatedAt: Date.now(),
      environment: {
        version: ctx.core.version, channel: ctx.core.channel, bundleHash: ctx.core.bundleHash ?? null, platform: 'win32', osRelease: '10.0.26100', osVersion: 'Windows 11 Pro', arch: 'x64',
        cpus: 16, memoryMb: 32_768, freeMemoryMb: 14_200, runtime: 'bun 1.3.0', pid: ctx.core.pid, startedAt: ctx.core.startedAt, uptimeMs: Date.now() - ctx.core.startedAt,
        trace: `${ctx.core.trace.os} ${ctx.core.trace.mode}`,
        providers: ctx.providers.map(provider => ({ id: provider.id, version: null, state: provider.enabled === false ? 'off' : provider.available ? 'available' : 'not installed' })),
        settings: { agentLogAccess: ctx.settings.agentLogAccess !== false, listenOnLan: ctx.settings.listenOnLan === true },
      },
      problems: [...problems.values()].sort((a, b) => (b.level === 'error' ? 1 : 0) - (a.level === 'error' ? 1 : 0) || b.lastAt - a.lastAt),
      threads,
      logFiles: [{ name: 'core.0.ndjson', bytes }, { name: 'shell.0.ndjson', bytes: 18_432 }],
      counts, since,
    };
  };

  const exportBundle = (since: number, limit: number): DiagnosticsExport => {
    const names = anonymizer();
    const records = newestFirst(record => record.at >= since, limit).map(record => names.record(record));
    const summary = summarize(records, since, names);
    const lines = [
      'Boite diagnostics', '=================',
      `Generated ${formatLogTime(summary.generatedAt)} (times are UTC).`,
      `Window: since ${formatLogTime(since)}, ${records.length} records: ${summary.counts.error} errors, ${summary.counts.warn} warnings, ${summary.counts.info} info, ${summary.counts.debug} debug.`,
      '', '## Environment', `Boite ${summary.environment.version} (${summary.environment.channel})`,
      '', `## Problems (${summary.problems.length} kinds)`,
      ...(summary.problems.length ? summary.problems.map(problem => `${problem.count}x ${problem.level.toUpperCase()} ${problem.origin}/${problem.source}/${problem.event} ${problem.message}`) : ['none']),
      '', `## Timeline (${records.length} records, oldest first)`,
      ...records.slice().reverse().map(formatLogLine),
    ];
    const text = `${lines.join('\n')}\n`;
    const name = `boite-diagnostics-${formatLogTime(Date.now()).replace(/[-:]/g, '').replace(' ', '-').replace(/\.\d+Z$/, '')}.txt`;
    return { name, path: `${DATA_DIR}\\logs\\exports\\${name}`, bytes: new TextEncoder().encode(text).length, records: records.length, text, summary };
  };

  return {
    'core.logs': async raw => {
      let query;
      try { query = validateCoreLogsQuery(raw); } catch (error) { throw invalid(error); }
      const records = newestFirst(record => logMatches(record, query), query.limit);
      if (!query.anonymize) return records;
      const names = anonymizer();
      return records.map(record => names.record(record));
    },
    'diagnostics.logs': async raw => {
      let query;
      try { query = validateDiagnosticsLogsQuery(raw); } catch (error) { throw invalid(error); }
      gate();
      const names = anonymizer();
      const family = new Set<string>();
      if (query.scope === 'thread' && query.threadId !== undefined) {
        family.add(query.threadId);
        for (let grew = true; grew;) {
          grew = false;
          for (const thread of ctx.threads.values()) if (thread.parentThreadId && family.has(thread.parentThreadId) && !family.has(thread.id)) { family.add(thread.id); grew = true; }
        }
      }
      return newestFirst(record => logMatches(record, { minLevel: query.minLevel, origin: query.origin, since: query.since, search: query.search })
        && (family.size === 0 || record.threadId === undefined || family.has(record.threadId)), query.limit).map(record => names.record(record));
    },
    'diagnostics.summary': async params => {
      if (params === null || typeof params !== 'object') throw invalid(new Error('diagnostics.summary params: expected an object'));
      gate();
      const since = typeof params.since === 'number' && Number.isFinite(params.since) ? params.since : Date.now() - DAY_MS;
      const names = anonymizer();
      return summarize(newestFirst(record => record.at >= since, EXPORT_LIMIT).map(record => names.record(record)), since, names);
    },
    'diagnostics.export': async params => {
      if (params === null || typeof params !== 'object') throw invalid(new Error('diagnostics.export params: expected an object'));
      gate();
      const since = typeof params.since === 'number' && Number.isFinite(params.since) && params.since >= 0 ? params.since : Date.now() - DAY_MS;
      const limit = params.limit === undefined ? EXPORT_LIMIT : params.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_LIMIT) throw invalid(new Error(`diagnostics.export limit: expected an integer from 1 to ${EXPORT_LIMIT}`));
      return exportBundle(since, limit);
    },
    'diagnostics.issue': async params => {
      if (params === null || typeof params !== 'object') throw invalid(new Error('diagnostics.issue params: expected an object'));
      gate();
      const title = typeof params.title === 'string' ? params.title.trim() : '';
      if (title.length < 4 || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw invalid(new Error('diagnostics.issue title: expected 4 to 200 characters on one line'));
      const description = typeof params.description === 'string' ? params.description.trim() : '';
      if (description.length < 1 || description.length > 20_000) throw invalid(new Error('diagnostics.issue description: expected 1 to 20000 characters'));
      const names = anonymizer();
      const safeTitle = names.text(normalizeCoreLogText(title));
      const safeDescription = names.text(normalizeCoreLogText(description));
      const exported = params.includeLogs === false ? null : exportBundle(Date.now() - DAY_MS, EXPORT_LIMIT);
      const body = ['### What happened', '', safeDescription, '', ...(exported ? [
        '### Environment', '', `Boite ${exported.summary.environment.version} (${exported.summary.environment.channel}), ${exported.summary.environment.platform} ${exported.summary.environment.arch}`, '',
        `### Problems (${exported.summary.problems.length})`, '',
        ...(exported.summary.problems.length ? exported.summary.problems.map(problem => `- ${problem.count}x ${problem.level} \`${problem.origin}/${problem.source}/${problem.event}\`: ${problem.message}`) : ['none']), '',
        `The full anonymized export is \`${exported.name}\` (${exported.records} records).`,
      ] : [])].join('\n');
      const prefillUrl = `https://github.com/${ISSUE_REPOSITORY}/issues/new?${new URLSearchParams({ title: safeTitle, body: body.slice(0, PREFILL_BODY_CHARS) }).toString()}`;
      return {
        repository: ISSUE_REPOSITORY, title: safeTitle, body, url: null, prefillUrl, gh: 'missing',
        error: params.submit === true ? 'GitHub CLI (gh) is not installed on this machine' : null, exportPath: exported?.path ?? null,
      };
    },
    'diagnostics.report': async raw => {
      if (ctx.bus.principal === 'agent') throw refused('diagnostics.report is not one of the agent\'s methods');
      let records;
      try { records = validateDiagnosticReport(raw); } catch (error) { throw invalid(error); }
      const minute = Math.floor(Date.now() / 60_000);
      const used = reportBudget.minute === minute ? reportBudget.count : 0;
      const accepted = records.slice(0, Math.max(0, REPORTS_PER_MINUTE - used));
      reportBudget = { minute, count: used + accepted.length };
      const client = ctx.bus.principal === 'session' ? 'pwa phone' : ctx.bus.principal;
      const now = Date.now();
      for (const record of accepted) {
        add(ctx, {
          at: Math.abs(record.at - now) < 10 * 60_000 ? record.at : now, level: record.level, origin: 'ui', source: record.source, event: record.event, message: record.message,
          ...(record.threadId && ctx.threads.has(record.threadId) ? { threadId: record.threadId } : {}), ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
          data: { ...(record.data ?? {}), client, remote: ctx.bus.principal === 'session' },
        });
      }
      return { accepted: accepted.length };
    },
  };
}

/** The fake captures the same lifecycle metadata, even without a subscribed client. */
export function observeLog<E extends RpcEventName>(ctx: FakeContext, event: E, payload: RpcEvents[E]): void {
  let record: Omit<CoreLogRecord, 'id' | 'runId'>;
  if (event === 'core.log') {
    const log = payload as RpcEvents['core.log'];
    record = {
      at: log.at, level: log.level, source: log.source ?? 'core', event: log.event ?? event, message: log.kind === 'provider-output' ? '[provider output omitted]' : normalizeCoreLogText(log.message),
      ...(log.threadId === undefined ? {} : { threadId: log.threadId }), ...(log.turnId === undefined ? {} : { turnId: log.turnId }), ...(log.requestId === undefined ? {} : { requestId: log.requestId }),
      ...(log.durationMs === undefined ? {} : { durationMs: log.durationMs }), ...(log.data === undefined ? {} : { data: log.data }),
    };
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

/** One stored record, bounded and redacted the way `CoreLogs.record` writes it. */
export function add(ctx: FakeContext, record: Omit<CoreLogRecord, 'id' | 'runId'>): void {
  const bounded = (value: string): string => normalizeCoreLogText(value).replace(/[\r\n\t]/g, ' ').slice(0, 200);
  const thread = record.threadId === undefined ? undefined : ctx.threads.get(record.threadId);
  const data = normalizeLogData(record.data);
  const { data: _data, origin, durationMs, ...rest } = record;
  ctx.logs.push({
    ...rest, id: `${ctx.logRunId}:${++ctx.logSequence}`, runId: ctx.logRunId,
    ...(origin && origin !== 'core' ? { origin } : {}),
    message: normalizeCoreLogText(record.message), source: bounded(record.source), event: bounded(record.event),
    ...(record.threadId === undefined ? {} : { threadId: bounded(record.threadId) }), ...(record.turnId === undefined ? {} : { turnId: bounded(record.turnId) }), ...(record.requestId === undefined ? {} : { requestId: bounded(record.requestId) }),
    ...(thread ? { providerId: thread.providerId, ...(thread.model ? { model: thread.model } : {}), ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}) } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    ...(data ? { data } : {}),
  });
  if (ctx.logs.length > 4096) ctx.logs.shift();
}

/**
 * A recent day of diagnostics, on the real clock so the Diagnostics page's
 * time windows find them: a start, a slow provider, a failed turn, a frozen
 * window and a client's own error. The fake's other times stay on `T0`.
 */
export function seedDiagnostics(ctx: FakeContext): void {
  const now = Date.now();
  const thread = [...ctx.threads.values()].find(entry => !entry.archived);
  const minutes = (count: number): number => now - count * 60_000;
  const seeds: Omit<CoreLogRecord, 'id' | 'runId'>[] = [
    { at: minutes(300), level: 'info', source: 'core', event: 'core.started', message: 'Core started on 127.0.0.1:8777 in 412 ms with 3 providers available', durationMs: 412, data: { pid: ctx.core.pid } },
    { at: minutes(298), level: 'info', origin: 'shell', source: 'sidecar', event: 'shell.sidecar.ready', message: 'The shell connected to its core after 0.9 s', durationMs: 900 },
    { at: minutes(240), level: 'debug', source: 'providers', event: 'providers.probe', message: 'Probed claude 2.1.284 in 180 ms', durationMs: 180, data: { provider: 'claude' } },
    { at: minutes(180), level: 'warn', source: 'claude', event: 'provider.slow-start', message: 'claude took 8.4 s to answer its first request, longer than the 5 s expected', durationMs: 8400, ...(thread ? { threadId: thread.id } : {}) },
    { at: minutes(122), level: 'warn', source: 'claude', event: 'provider.slow-start', message: 'claude took 6.1 s to answer its first request, longer than the 5 s expected', durationMs: 6100, ...(thread ? { threadId: thread.id } : {}) },
    { at: minutes(95), level: 'error', source: 'turns', event: 'turn.failed', message: 'Turn failed: the agent exited with code 1 before answering', ...(thread ? { threadId: thread.id, turnId: 'turn-diagnostic' } : {}), data: { exitCode: 1, retryAfterS: 42, stderrTail: 'rate limit reached, retry in 42 s' } },
    { at: minutes(64), level: 'warn', origin: 'shell', source: 'watchdog', event: 'shell.main-thread.blocked', message: 'The main thread was blocked for 6.2 s; the last command, notify, started 6.4 s ago', durationMs: 6200, data: { command: 'notify' } },
    { at: minutes(40), level: 'error', origin: 'ui', source: 'window', event: 'ui.error', message: 'The interface hit an error: Cannot read properties of undefined (reading \'parts\')', data: { stack: 'TypeError at MessageList.svelte:212', client: 'shell' } },
    { at: minutes(31), level: 'warn', origin: 'ui', source: 'connection', event: 'ui.reconnected', message: 'The connection to the core came back after 12.4 s offline', durationMs: 12_400, data: { client: 'pwa phone' } },
    { at: minutes(12), level: 'info', source: 'scheduler', event: 'turn.queued', message: 'Turn queued behind 2 running turns', ...(thread ? { threadId: thread.id } : {}) },
    { at: minutes(3), level: 'info', source: 'diagnostics', event: 'diagnostics.exported', message: 'Diagnostics exported: 214 records since 2026-10-09 14:00:00.000Z', data: { records: 214, by: 'owner' } },
  ];
  for (const seed of seeds) add(ctx, seed);
}
