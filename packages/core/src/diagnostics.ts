import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, hostname, platform, release, totalmem, userInfo, version as osVersion } from 'node:os';
import { join } from 'node:path';
import {
  createLogAnonymizer, formatLogDuration, formatLogLine, formatLogTime, ISSUE_REPOSITORY, logLevelAtLeast, logMatches, validateDiagnosticReport, validateDiagnosticsLogsQuery,
  type CoreLogLevel, type CoreLogRecord, type DiagnosticEnvironment, type DiagnosticProblem, type DiagnosticReportRecord, type DiagnosticsExport, type DiagnosticsExportParams,
  type DiagnosticsIssue, type DiagnosticsIssueParams, type DiagnosticsLogsQuery, type DiagnosticSummary, type DiagnosticThread, type LogAnonymizer, type LogData, type ThreadSummary,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { knownVersion } from './providers/versions.ts';
import type { Connection } from './router.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_LIMIT = 20_000;
const EXPORTS_KEPT = 10;
const TAIL_BYTES = 64 * 1024;
const ISSUE_BODY_CHARS = 60_000;
const PREFILL_BODY_CHARS = 6_000;
const REPORTS_PER_MINUTE = 300;
const GH_TIMEOUT_MS = 30_000;

/**
 * What a developer receives instead of a screen share: the environment, every
 * problem grouped, every thread with its agent, and the whole timeline, all
 * anonymized. Agents read the same view through `boite logs` while the owner
 * leaves `agentLogAccess` on.
 */
export class Diagnostics {
  /** The GitHub CLI; tests point it at a program that does not exist. */
  ghCommand = 'gh';
  #salt: string | null = null;
  #sequence = 0;
  readonly #reports = new Map<string, { minute: number; count: number }>();

  constructor(private readonly core: Core) {}

  /** A random per-installation value: the same project gets the same placeholder in every export of this machine. */
  private salt(): string {
    if (this.#salt !== null) return this.#salt;
    const file = join(this.core.logs.directory, 'anonymize.salt');
    try { this.#salt = readFileSync(file, 'utf8').trim(); } catch { this.#salt = ''; }
    if (!/^[0-9a-f]{32}$/.test(this.#salt)) {
      this.#salt = randomBytes(16).toString('hex');
      void mkdir(this.core.logs.directory, { recursive: true, mode: 0o700 })
        .then(() => writeFile(file, `${this.#salt}\n`, { mode: 0o600 }))
        .catch(error => this.core.logs.warn(`the anonymization salt could not be saved: ${messageOf(error)}`, { source: 'diagnostics', event: 'diagnostics.salt-failed' }));
    }
    return this.#salt;
  }

  anonymizer(): LogAnonymizer {
    let user: string | null = null;
    try { user = userInfo().username; } catch { user = process.env.USER ?? process.env.USERNAME ?? null; }
    const projects = this.core.projects.list().map(project => ({ path: project.path, name: project.name }));
    // Worktrees and thread folders outside a project still name the user's layout.
    const known = (path: string): boolean => inside(path, this.core.dataDir) || projects.some(project => project.path.length > 0 && inside(path, project.path));
    const folders = new Set<string>();
    for (const thread of this.core.journal.listThreads()) if (thread.cwd && !known(thread.cwd) && folders.size < 1000) folders.add(thread.cwd);
    for (const path of folders) projects.push({ path, name: '' });
    const extra = this.core.accounts.list().flatMap(account => [account.label, account.identity ?? ''].filter(value => value.length >= 3 && !/^(?:default|claude|codex|grok|pi|opencode|muse|antigravity)$/i.test(value)));
    return createLogAnonymizer({ salt: this.salt(), home: homedir(), user, hostname: hostname(), dataDir: this.core.dataDir, projects, extra });
  }

  environment(): DiagnosticEnvironment {
    const settings = this.core.settings.get() as unknown as Record<string, unknown>;
    const kept: LogData = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'boolean' || typeof value === 'number') kept[key] = value;
      else if (key === 'worktreeStorage' && typeof value === 'string') kept[key] = value;
      else if (key === 'titleModel' && value && typeof value === 'object') kept[key] = `${(value as { providerId?: string }).providerId ?? '?'}/${(value as { model?: string }).model ?? '?'}`;
      else if (key === 'publicUrl') kept[key] = value ? 'set' : 'unset';
      else if (key === 'subscriptionProxy') kept[key] = value ? 'on' : 'off';
    }
    const list = this.core.providers.list();
    const providers = list.loaded.map(summary => ({
      id: summary.id,
      version: summary.install?.state === 'installed' ? summary.install.version : summary.executable ? knownVersion(summary.executable) : null,
      state: summary.enabled === false ? 'off' : summary.available ? 'available' : 'not installed',
    }));
    for (const rejected of list.rejected) providers.push({ id: rejected.file.split(/[\\/]/).pop() ?? rejected.file, version: null, state: `rejected: ${rejected.field} ${rejected.message}`.slice(0, 200) });
    const trace = this.core.procs.capability();
    let osBuild: string | null = null;
    try { osBuild = osVersion(); } catch { osBuild = null; }
    return {
      version: this.core.version, channel: this.core.channel, bundleHash: this.core.bundleHash ?? null,
      platform: platform(), osRelease: release(), osVersion: osBuild, arch: arch(), cpus: cpus().length,
      memoryMb: Math.round(totalmem() / 1048576), freeMemoryMb: Math.round(freemem() / 1048576),
      runtime: `bun ${Bun.version}`, pid: process.pid, startedAt: this.core.startedAt, uptimeMs: Date.now() - this.core.startedAt,
      trace: `${trace.os} ${trace.mode}`, providers, settings: kept,
    };
  }

  /** Throws unless this connection may read diagnostics, and returns whether they are an agent's. */
  private gate(connection: Connection | undefined, threadId: string | undefined): boolean {
    if (connection?.identity.principal !== 'agent') return false;
    if (this.core.settings.get().agentLogAccess === false) throw refused('diagnostics: the owner turned off agent access to logs (Settings > Diagnostics)');
    if (threadId === undefined || threadId !== connection.identity.threadId) throw refused('diagnostics: an agent names its own thread');
    return true;
  }

  /** The thread and every thread it started, at any depth. */
  private family(threadId: string, threads: readonly ThreadSummary[]): Set<string> {
    const family = new Set([threadId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const thread of threads) if (thread.parentThreadId && family.has(thread.parentThreadId) && !family.has(thread.id)) { family.add(thread.id); grew = true; }
    }
    return family;
  }

  /**
   * The threads a caller reads, null for all of them. An agent is held to its
   * own thread and the threads it started, as every agent call is: it still
   * sees the records about no thread (the shell, the core, the clients), which
   * is what tells it whether Boite itself failed. The owner reads everything,
   * or one thread's family when it asks.
   */
  private reach(agent: boolean, threadId: string | undefined, focus: boolean): Set<string> | null {
    if (threadId === undefined || (!agent && !focus)) return null;
    return this.family(threadId, this.core.journal.listThreads());
  }

  async logs(raw: unknown, connection?: Connection): Promise<CoreLogRecord[]> {
    let query: ReturnType<typeof validateDiagnosticsLogsQuery>;
    try { query = validateDiagnosticsLogsQuery(raw); } catch (error) { throw invalidParams((error as Error).message); }
    const agent = this.gate(connection, query.threadId);
    const family = this.reach(agent, query.threadId, query.scope === 'thread');
    // `scope: 'thread'` leaves out the records about no thread too.
    const keep = (record: CoreLogRecord): boolean => logMatches(record, { minLevel: query.minLevel, origin: query.origin, since: query.since, search: query.search })
      && (family === null || (record.threadId === undefined ? query.scope !== 'thread' : family.has(record.threadId)));
    const anonymizer = this.anonymizer();
    return (await this.core.logs.select(keep, query.limit)).map(record => anonymizer.record(record));
  }

  async summary(params: { threadId?: string; since?: number }, connection?: Connection): Promise<DiagnosticSummary> {
    const agent = this.gate(connection, params.threadId);
    const since = typeof params.since === 'number' && Number.isFinite(params.since) ? params.since : Date.now() - DAY_MS;
    const family = this.reach(agent, params.threadId, false);
    const anonymizer = this.anonymizer();
    const records = (await this.core.logs.select(record => record.at >= since && within(record, family), EXPORT_LIMIT)).map(record => anonymizer.record(record));
    return this.summarize(records, since, anonymizer, family);
  }

  private async summarize(records: readonly CoreLogRecord[], since: number, anonymizer: LogAnonymizer, family: Set<string> | null): Promise<DiagnosticSummary> {
    const counts: Record<CoreLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const problems = new Map<string, DiagnosticProblem>();
    const perThread = new Map<string, { warnings: number; errors: number; lastError: { at: number; message: string } | null }>();
    for (const record of records) {
      counts[record.level] += 1;
      if (record.threadId !== undefined) {
        const entry = perThread.get(record.threadId) ?? { warnings: 0, errors: 0, lastError: null };
        if (record.level === 'warn') entry.warnings += 1;
        if (record.level === 'error') {
          entry.errors += 1;
          if (entry.lastError === null || entry.lastError.at < record.at) entry.lastError = { at: record.at, message: record.message.slice(0, 300) };
        }
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
    const all = this.core.journal.listThreads();
    const mentioned = new Set(records.flatMap(record => [record.threadId, record.parentThreadId].filter((id): id is string => id !== undefined)));
    const threads: DiagnosticThread[] = all.filter(thread => (family === null || family.has(thread.id)) && (mentioned.has(thread.id) || (!thread.archived && thread.updatedAt >= since))).map(thread => {
      const seen = perThread.get(thread.id);
      return {
        threadId: thread.id, providerId: thread.providerId, model: thread.model, effort: thread.effort, status: thread.status,
        parentThreadId: thread.parentThreadId ?? null, project: anonymizer.project(this.core.projects.list().find(project => project.id === thread.projectId)?.path ?? null),
        archived: thread.archived, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
        warnings: seen?.warnings ?? 0, errors: seen?.errors ?? 0, lastError: seen?.lastError?.message ?? null,
      };
    });
    return {
      generatedAt: Date.now(), environment: this.anonymizeEnvironment(this.environment(), anonymizer),
      problems: [...problems.values()].sort((a, b) => (b.level === 'error' ? 1 : 0) - (a.level === 'error' ? 1 : 0) || b.lastAt - a.lastAt),
      threads, logFiles: await this.core.logs.files(), counts, since,
    };
  }

  private anonymizeEnvironment(environment: DiagnosticEnvironment, anonymizer: LogAnonymizer): DiagnosticEnvironment {
    return {
      ...environment,
      osVersion: environment.osVersion === null ? null : anonymizer.text(environment.osVersion),
      providers: environment.providers.map(provider => ({ ...provider, state: anonymizer.text(provider.state) })),
      settings: Object.fromEntries(Object.entries(environment.settings).map(([key, value]) => [key, typeof value === 'string' ? anonymizer.text(value) : value])),
    };
  }

  async export(params: DiagnosticsExportParams, connection?: Connection): Promise<DiagnosticsExport> {
    if (params === null || typeof params !== 'object') throw invalidParams('diagnostics.export params: expected an object');
    const agent = this.gate(connection, params.threadId);
    const since = typeof params.since === 'number' && Number.isFinite(params.since) && params.since >= 0 ? params.since : Date.now() - DAY_MS;
    const limit = params.limit === undefined ? EXPORT_LIMIT : params.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_LIMIT) throw invalidParams(`diagnostics.export limit: expected an integer from 1 to ${EXPORT_LIMIT}`);
    // An agent exports its own family whatever it names; the owner may focus on one.
    const family = agent ? this.reach(true, params.threadId, false) : params.focusThreadId ? this.family(params.focusThreadId, this.core.journal.listThreads()) : null;
    const anonymizer = this.anonymizer();
    const records = (await this.core.logs.select(record => record.at >= since && within(record, family), limit))
      .map(record => anonymizer.record(record));
    const summary = await this.summarize(records, since, anonymizer, family);
    // The raw console of the core can name any conversation: the owner's export only.
    const tails = agent ? [] : await this.tails(anonymizer);
    const text = renderExport(summary, records, tails);
    const stamp = formatLogTime(Date.now()).replace(/[-:]/g, '').replace(' ', '-').replace(/\.\d+Z$/, '');
    // Two exports in one second (an issue and a manual export) must not share a file.
    const name = `boite-diagnostics-${stamp}-${String(++this.#sequence).padStart(3, '0')}.txt`;
    let path: string | null = join(this.core.logs.directory, 'exports', name);
    try {
      await mkdir(join(this.core.logs.directory, 'exports'), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600);
    } catch (error) {
      this.core.logs.warn(`the diagnostic export could not be saved: ${messageOf(error)}`, { source: 'diagnostics', event: 'diagnostics.export-failed' });
      path = null;
    }
    // The file is written: a failed cleanup of older ones does not hide it.
    if (path !== null) {
      await this.pruneExports().catch(error => this.core.logs.warn(`older diagnostic exports could not be removed: ${messageOf(error)}`, { source: 'diagnostics', event: 'diagnostics.prune-failed' }));
    }
    this.core.logs.info(`Diagnostics exported: ${records.length} records since ${formatLogTime(since)}`, {
      source: 'diagnostics', event: 'diagnostics.exported', ...(connection?.identity.threadId ? { threadId: connection.identity.threadId } : {}),
      data: { records: records.length, bytes: Buffer.byteLength(text), by: connection?.identity.principal ?? 'owner' },
    });
    return { name, path, bytes: Buffer.byteLength(text), records: records.length, text, summary };
  }

  private async pruneExports(): Promise<void> {
    const directory = join(this.core.logs.directory, 'exports');
    const names = (await readdir(directory)).filter(name => /^boite-diagnostics-.*\.txt$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - EXPORTS_KEPT))) await unlink(join(directory, name)).catch(() => undefined);
  }

  /** The ends of the raw files no record covers: the resident core's console and the shell's failures. */
  private async tails(anonymizer: LogAnonymizer): Promise<{ name: string; text: string }[]> {
    const tails: { name: string; text: string }[] = [];
    for (const name of ['core-output.log', 'shell-error.log']) {
      const path = join(this.core.dataDir, name);
      if (!existsSync(path)) continue;
      let handle;
      try {
        handle = await open(path, 'r');
        const size = (await handle.stat()).size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const text = buffer.toString('utf8').split('\n').slice(size > length ? 1 : 0).map(line => anonymizer.text(this.redact(line))).join('\n');
        tails.push({ name: `${name} (last ${formatBytes(length)} of ${formatBytes(size)})`, text });
      } catch (error) {
        tails.push({ name, text: `unreadable: ${messageOf(error)}` });
      } finally { await handle?.close(); }
    }
    return tails;
  }

  private redact(line: string): string { return this.core.logs.redact(line); }

  async issue(params: DiagnosticsIssueParams, connection?: Connection): Promise<DiagnosticsIssue> {
    if (params === null || typeof params !== 'object') throw invalidParams('diagnostics.issue params: expected an object');
    this.gate(connection, params.threadId);
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (title.length < 4 || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw invalidParams('diagnostics.issue title: expected 4 to 200 characters on one line');
    const description = typeof params.description === 'string' ? params.description.trim() : '';
    if (description.length < 1 || description.length > 20_000) throw invalidParams('diagnostics.issue description: expected 1 to 20000 characters');
    const anonymizer = this.anonymizer();
    const safeTitle = anonymizer.text(this.redact(title));
    const safeDescription = anonymizer.text(this.redact(description));
    let exported: DiagnosticsExport | null = null;
    if (params.includeLogs !== false) exported = await this.export({ ...(params.threadId ? { threadId: params.threadId } : {}), since: Date.now() - DAY_MS }, connection);
    const body = renderIssueBody(safeDescription, exported, ISSUE_BODY_CHARS);
    const short = renderIssueBody(safeDescription, exported, PREFILL_BODY_CHARS);
    const prefillUrl = `https://github.com/${ISSUE_REPOSITORY}/issues/new?${new URLSearchParams({ title: safeTitle, body: short }).toString()}`;
    const gh = await this.ghStatus();
    let url: string | null = null;
    let error: string | null = null;
    if (params.submit === true) {
      if (gh !== 'ready') error = gh === 'missing' ? 'GitHub CLI (gh) is not installed on this machine' : 'GitHub CLI (gh) is not signed in: run gh auth login';
      else {
        try { url = await this.createIssue(safeTitle, body); }
        catch (cause) { error = messageOf(cause).slice(0, 500); }
      }
      this.core.logs.record(url ? 'info' : 'warn', url ? `Issue created on ${ISSUE_REPOSITORY}: ${url}` : `Issue not created: ${error}`, {
        source: 'diagnostics', event: url ? 'diagnostics.issue-created' : 'diagnostics.issue-failed', ...(connection?.identity.threadId ? { threadId: connection.identity.threadId } : {}),
      });
    }
    return { repository: ISSUE_REPOSITORY, title: safeTitle, body, url, prefillUrl, gh, error, exportPath: exported?.path ?? null };
  }

  private async gh(args: string[], timeoutMs = GH_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const scope = `diagnostics:gh:${++this.#sequence}`;
    let spawned;
    try { spawned = this.core.procs.spawn(scope, this.ghCommand, args, { agentRoot: false, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }); }
    catch (error) { if (/ENOENT|not found|No such file/i.test(messageOf(error))) return { code: null, stdout: '', stderr: 'missing' }; throw error; }
    const timer = setTimeout(() => { try { this.core.procs.killTree(scope); } catch { /* The exit below still settles. */ } }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(spawned.proc.stdout).text(), new Response(spawned.proc.stderr).text(), spawned.exited]);
      return { code, stdout: stdout.slice(0, 64 * 1024), stderr: stderr.slice(0, 64 * 1024) };
    } finally { clearTimeout(timer); }
  }

  async ghStatus(): Promise<DiagnosticsIssue['gh']> {
    try {
      const result = await this.gh(['auth', 'status', '--hostname', 'github.com'], 10_000);
      if (result.code === null) return 'missing';
      return result.code === 0 ? 'ready' : 'unauthenticated';
    } catch { return 'missing'; }
  }

  private async createIssue(title: string, body: string): Promise<string> {
    const file = join(this.core.logs.directory, `issue-${process.pid}-${++this.#sequence}.md`);
    await writeFile(file, body, { mode: 0o600 });
    try {
      const result = await this.gh(['issue', 'create', '--repo', ISSUE_REPOSITORY, '--title', title, '--body-file', file]);
      if (result.code !== 0) throw new Error(this.redact(result.stderr.trim() || `gh exited with ${result.code}`));
      const url = result.stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)?.[0];
      if (!url) throw new Error('gh did not print the new issue address');
      return url;
    } finally { await unlink(file).catch(() => undefined); }
  }

  /** A client's own errors. Bounded per connection, so a render loop cannot flood the files. */
  report(raw: unknown, connection: Connection): { accepted: number } {
    let records: DiagnosticReportRecord[];
    try { records = validateDiagnosticReport(raw); } catch (error) { throw invalidParams((error as Error).message); }
    const minute = Math.floor(Date.now() / 60_000);
    const budget = this.#reports.get(connection.id);
    const used = budget?.minute === minute ? budget.count : 0;
    const room = Math.max(0, REPORTS_PER_MINUTE - used);
    const accepted = records.slice(0, room);
    // Moved to the end on every report, so the first entry is the one that reported least recently.
    this.#reports.delete(connection.id);
    this.#reports.set(connection.id, { minute, count: used + accepted.length });
    if (this.#reports.size > 256) {
      const stale = [...this.#reports].find(([, entry]) => entry.minute !== minute)?.[0];
      this.#reports.delete(stale ?? this.#reports.keys().next().value!);
    }
    const client = connection.sentFrom ? `${connection.sentFrom.client}${connection.sentFrom.device ? ` ${connection.sentFrom.device}` : ''}` : connection.identity.principal;
    const now = Date.now();
    for (const record of accepted) {
      // A client clock can be wrong; keep its time only when it is near ours.
      const at = Math.abs(record.at - now) < 10 * 60_000 ? record.at : now;
      // A reporter names a thread; only one that exists is kept, so no client can file problems under an invented one.
      const threadId = record.threadId && this.core.journal.getThread(record.threadId) ? record.threadId : undefined;
      this.core.logs.record(record.level, record.message, {
        origin: 'ui', source: record.source, event: record.event, ...(threadId ? { threadId } : {}),
        ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
        data: { ...(record.data ?? {}), client, remote: connection.remote !== false },
      }, at);
    }
    if (accepted.length < records.length && used < REPORTS_PER_MINUTE) {
      this.core.logs.warn(`A client sent more than ${REPORTS_PER_MINUTE} diagnostics in a minute; the rest of this minute is dropped`, { source: 'diagnostics', event: 'diagnostics.report-throttled', data: { client } });
    }
    return { accepted: accepted.length };
  }
}

/** `path` is `dir` or below it: `/proj2` is not inside `/proj`. */
function inside(path: string, dir: string): boolean {
  return path === dir || (path.startsWith(dir) && (path[dir.length] === '/' || path[dir.length] === '\\' || /[\\/]$/.test(dir)));
}

/** A record about no thread, or about one of the threads in reach. */
function within(record: CoreLogRecord, family: Set<string> | null): boolean {
  return family === null || record.threadId === undefined || family.has(record.threadId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function offset(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}

function problemLine(problem: DiagnosticProblem): string {
  return `${String(problem.count).padStart(5)}x ${problem.level.toUpperCase().padEnd(5)} ${problem.origin}/${problem.source}/${problem.event}, first ${formatLogTime(problem.firstAt)}, last ${formatLogTime(problem.lastAt)}${problem.threadIds.length ? `, threads ${problem.threadIds.join(' ')}` : ''}\n        ${problem.message.replace(/[\r\n]+/g, ' ')}`;
}

function threadLine(thread: DiagnosticThread): string {
  return `${thread.threadId} ${thread.providerId}/${thread.model ?? 'default'}${thread.effort ? ` effort=${thread.effort}` : ''} status=${thread.status}${thread.archived ? ' archived' : ''}${thread.parentThreadId ? ` parent=${thread.parentThreadId}` : ''} project=${thread.project} created=${formatLogTime(thread.createdAt)} warnings=${thread.warnings} errors=${thread.errors}${thread.lastError ? `\n        last error: ${thread.lastError.replace(/[\r\n]+/g, ' ')}` : ''}`;
}

/** The export: the sections a developer reads first, then the whole timeline, oldest first. */
export function renderExport(summary: DiagnosticSummary, records: readonly CoreLogRecord[], tails: readonly { name: string; text: string }[]): string {
  const environment = summary.environment;
  const lines: string[] = [
    'Boite diagnostics',
    '=================',
    `Generated ${formatLogTime(summary.generatedAt)} (times are UTC; this machine is UTC${offset()}).`,
    `Window: since ${formatLogTime(summary.since)}, ${records.length} records: ${summary.counts.error} errors, ${summary.counts.warn} warnings, ${summary.counts.info} info, ${summary.counts.debug} debug.`,
    'Anonymized: paths, project and account names, e-mails, addresses and private hosts are placeholders. Thread, turn and run ids are real.',
    '',
    '## Environment',
    `Boite ${environment.version} (${environment.channel})${environment.bundleHash ? ` bundle ${environment.bundleHash}` : ''}`,
    `OS ${environment.platform} ${environment.osRelease}${environment.osVersion ? ` (${environment.osVersion})` : ''} ${environment.arch}, ${environment.cpus} logical CPUs, ${environment.memoryMb} MB RAM (${environment.freeMemoryMb} MB free)`,
    `Core pid ${environment.pid}, ${environment.runtime}, started ${formatLogTime(environment.startedAt)}, up ${formatLogDuration(environment.uptimeMs)}, process trace ${environment.trace}`,
    '',
    '## Agents',
    ...environment.providers.map(provider => `${provider.id.padEnd(16)} ${(provider.version ?? '-').padEnd(14)} ${provider.state}`),
    '',
    '## Settings',
    ...Object.entries(environment.settings).map(([key, value]) => `${key}: ${String(value)}`),
    '',
    `## Problems (${summary.problems.length} kinds, warnings and errors grouped, errors first)`,
    ...(summary.problems.length ? summary.problems.map(problemLine) : ['none']),
    '',
    `## Threads (${summary.threads.length}, each id below appears in the timeline)`,
    ...(summary.threads.length ? summary.threads.map(threadLine) : ['none']),
    '',
    '## Log files',
    ...summary.logFiles.map(file => `${file.name} ${formatBytes(file.bytes)}`),
    '',
  ];
  for (const tail of tails) lines.push(`## ${tail.name}`, tail.text.trimEnd() || '(empty)', '');
  lines.push(`## Timeline (${records.length} records, oldest first)`);
  lines.push('time                     level origin source/event [thread provider/model <parent turn=] (duration) message {data}');
  for (let index = records.length - 1; index >= 0; index -= 1) lines.push(formatLogLine(records[index]!));
  return `${lines.join('\n')}\n`;
}

/** The markdown of an issue, bounded: the timeline shrinks first, the user's words never. */
export function renderIssueBody(description: string, exported: DiagnosticsExport | null, maxChars: number): string {
  const head = ['### What happened', '', description, ''];
  if (exported === null) return head.join('\n').slice(0, maxChars);
  const { summary } = exported;
  const environment = summary.environment;
  head.push(
    '### Environment', '',
    `- Boite ${environment.version} (${environment.channel})`,
    `- ${environment.platform} ${environment.osRelease}${environment.osVersion ? ` (${environment.osVersion})` : ''} ${environment.arch}, ${environment.cpus} CPUs, ${environment.memoryMb} MB RAM`,
    `- Agents: ${environment.providers.filter(provider => provider.state === 'available').map(provider => `${provider.id} ${provider.version ?? ''}`.trim()).join(', ') || 'none available'}`,
    '',
    `### Problems in the last 24 hours (${summary.counts.error} errors, ${summary.counts.warn} warnings)`, '',
    ...(summary.problems.length ? summary.problems.slice(0, 15).map(problem => `- ${problem.count}x \`${problem.origin}/${problem.source}/${problem.event}\` (${problem.level}), last ${formatLogTime(problem.lastAt)}: ${problem.message.replace(/[\r\n]+/g, ' ').slice(0, 300)}`) : ['- none recorded']),
    '',
  );
  const footer = ['', `<sub>Anonymized by Boite. The full export (${exported.name}, ${formatBytes(exported.bytes)}) can be attached to this issue.</sub>`];
  const timeline = exported.text.split('\n## Timeline')[1]?.split('\n').slice(2).filter(line => line.length > 0) ?? [];
  const fixed = head.join('\n').length + footer.join('\n').length + 120;
  const room = maxChars - fixed;
  const chosen: string[] = [];
  let used = 0;
  // The newest lines explain the report; older ones go first when space runs out.
  for (let index = timeline.length - 1; index >= 0 && room > 0; index -= 1) {
    const line = timeline[index]!.replace(/```/g, "'''");
    if (used + line.length + 1 > room) break;
    chosen.unshift(line);
    used += line.length + 1;
  }
  const details = chosen.length ? ['<details><summary>Latest ' + chosen.length + ' log lines</summary>', '', '```text', ...chosen, '```', '</details>'] : [];
  return [...head, ...details, ...footer].join('\n').slice(0, maxChars);
}
