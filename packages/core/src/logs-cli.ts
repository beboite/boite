/**
 * `boite logs` and `boite issue`: Boite's own diagnostics, read by the owner
 * from a terminal or by an agent inside a thread.
 *
 * The owner reads the local records as they are stored (credentials already
 * removed). An agent reads the anonymized view, `diagnostics.*`, while the
 * owner leaves Settings > Diagnostics > agent access on. Both print one line
 * per record, oldest first, so the output reads as a story.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { formatLogLine, formatLogTime, LOG_LEVELS, LOG_ORIGINS, type CoreLogLevel, type CoreLogRecord, type CoreLogsQuery, type DiagnosticSummary, type LogOrigin } from '@boite/contracts';
import { readFileSync } from 'node:fs';
import type { CoreClient } from './client.ts';
import { Usage } from './cli-args.ts';

export const LOGS_HELP = `boite logs: Boite's own diagnostics (the app, its shell and its clients)

  logs [filters]                 recent records, oldest first, one per line
    --limit <n>                  how many (default 100; owner up to 1000, agent 500)
    --min-level debug|info|warn|error   this level and above (default info)
    --level <level>              exactly this level (owner)
    --since <30m|2h|1d|ISO time> only newer records
    --origin core|shell|ui       one process
    --search <text>              text in the message, source, event or data
    --turn <turn-id>             one turn (owner)
    --mine                       agent: only this thread and the threads it started,
                                 without the records about no thread (the app itself)
    --anonymize                  owner: placeholders for paths, names and addresses
  logs problems [--since 24h]    warnings and errors grouped, and the threads they touched
  logs export [--out <file>] [--since 24h] [--focus <thread-id>]
                                 the anonymized file a developer reads; prints where it is
  issue draft --title <title> --description <text>|--description-file <file> [--no-logs]
                                 the GitHub issue for beboite/boite, printed, not sent
  issue submit (same flags)      create it with gh when signed in, else print the
                                 prefilled link the user opens; show the user the draft first

Each line: time (UTC), level, origin, source/event, [thread provider/model <parent turn=],
(duration), message, {data}. Ids are real and grep-able across lines.`;

type Printer = (lines: string[], value: unknown) => void;

interface LogFlags {
  limit?: number; level?: CoreLogLevel; minLevel?: CoreLogLevel; since?: number; origin?: LogOrigin; search?: string; turn?: string;
  mine: boolean; anonymize: boolean; out?: string; focus?: string; title?: string; description?: string; descriptionFile?: string; noLogs: boolean;
}

/** `30m`, `2h`, `1d`, `90s` back from now, or any date `Date.parse` reads. */
export function parseSince(raw: string, now = Date.now()): number {
  const relative = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i.exec(raw.trim());
  if (relative) {
    const unit = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!.toLowerCase() as 's' | 'm' | 'min' | 'h' | 'd'];
    return now - Number(relative[1]) * unit;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) throw new Usage(`--since expects 30m, 2h, 1d or a date, got ${raw}`);
  return at;
}

function flags(args: string[]): { positional: string[]; flags: LogFlags } {
  const result: LogFlags = { mine: false, anonymize: false, noLogs: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = (): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Usage(`${arg} needs a value`);
      index += 1;
      return value;
    };
    const level = (value: string): CoreLogLevel => {
      if (!LOG_LEVELS.includes(value as CoreLogLevel)) throw new Usage(`${arg} expects debug, info, warn or error`);
      return value as CoreLogLevel;
    };
    if (arg === '--limit') {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Usage('--limit needs an integer from 1 to 1000');
      result.limit = value;
    } else if (arg === '--level') result.level = level(next());
    else if (arg === '--min-level') result.minLevel = level(next());
    else if (arg === '--since') result.since = parseSince(next());
    else if (arg === '--origin') {
      const value = next();
      if (!LOG_ORIGINS.includes(value as LogOrigin)) throw new Usage('--origin expects core, shell or ui');
      result.origin = value as LogOrigin;
    } else if (arg === '--search') result.search = next();
    else if (arg === '--turn') result.turn = next();
    else if (arg === '--mine') result.mine = true;
    else if (arg === '--anonymize') result.anonymize = true;
    else if (arg === '--out') result.out = next();
    else if (arg === '--focus') result.focus = next();
    else if (arg === '--title') result.title = next();
    else if (arg === '--description') result.description = next();
    else if (arg === '--description-file') result.descriptionFile = next();
    else if (arg === '--no-logs') result.noLogs = true;
    else if (arg.startsWith('--')) throw new Usage(`unknown flag ${arg}; boite logs help lists them`);
    else positional.push(arg);
  }
  return { positional, flags: result };
}

/** Oldest first: the timeline reads top to bottom. */
function lines(records: readonly CoreLogRecord[]): string[] {
  return records.length === 0 ? ['no records match'] : [...records].reverse().map(formatLogLine);
}

function problemLines(summary: DiagnosticSummary): string[] {
  const out = [
    `since ${formatLogTime(summary.since)}: ${summary.counts.error} errors, ${summary.counts.warn} warnings, ${summary.counts.info} info, ${summary.counts.debug} debug`,
    `boite ${summary.environment.version} (${summary.environment.channel}) on ${summary.environment.platform} ${summary.environment.osRelease} ${summary.environment.arch}`,
  ];
  if (summary.problems.length === 0) out.push('problems: none');
  for (const problem of summary.problems) out.push(`${problem.count}x ${problem.level} ${problem.origin}/${problem.source}/${problem.event} last ${formatLogTime(problem.lastAt)}${problem.threadIds.length ? ` threads ${problem.threadIds.join(' ')}` : ''}: ${problem.message.replace(/[\r\n]+/g, ' ')}`);
  const troubled = summary.threads.filter(thread => thread.errors > 0 || thread.warnings > 0);
  if (troubled.length) out.push('threads with problems:');
  for (const thread of troubled) out.push(`  ${thread.threadId} ${thread.providerId}/${thread.model ?? 'default'} ${thread.status}${thread.parentThreadId ? ` parent ${thread.parentThreadId}` : ''}: ${thread.errors} errors, ${thread.warnings} warnings${thread.lastError ? `; last: ${thread.lastError}` : ''}`);
  return out;
}

export async function logsCommand(args: string[], client: CoreClient, threadId: string, agent: boolean, cwd: string, print: Printer): Promise<void> {
  const { positional, flags: options } = flags(args);
  const action = positional[0] ?? 'list';
  const own = agent ? { threadId } : {};
  if (action === 'help') { print([LOGS_HELP], { help: LOGS_HELP }); return; }
  if (action === 'problems') {
    const summary = await client.call('diagnostics.summary', { ...own, ...(options.since === undefined ? {} : { since: options.since }) });
    print(problemLines(summary), summary);
    return;
  }
  if (action === 'export') {
    const result = await client.call('diagnostics.export', { ...own, ...(options.since === undefined ? {} : { since: options.since }), ...(options.focus ? { focusThreadId: options.focus } : {}) });
    let written: string | null = null;
    if (options.out) {
      written = isAbsolute(options.out) ? options.out : resolve(cwd, options.out);
      writeFileSync(written, result.text, { mode: 0o600 });
      // `mode` applies only to a new file: an existing one keeps its permissions otherwise.
      chmodSync(written, 0o600);
    }
    const { text: _text, ...rest } = result;
    print([
      `records: ${result.records}`, `bytes: ${result.bytes}`,
      ...(result.path ? [`saved: ${result.path}`] : []), ...(written ? [`written: ${written}`] : []),
      `problems: ${result.summary.problems.length} kinds, ${result.summary.counts.error} errors, ${result.summary.counts.warn} warnings`,
    ], { ...rest, ...(written ? { written } : {}) });
    return;
  }
  if (action !== 'list') throw new Usage(`logs expects list, problems, export or help, got ${action}`);
  if (positional.length > 1) throw new Usage('logs takes flags only; boite logs help lists them');
  if (agent) {
    if (options.level || options.turn || options.anonymize) throw new Usage('--level, --turn and --anonymize are the owner\'s; an agent uses --min-level, --since, --search and --mine');
    const records = await client.call('diagnostics.logs', {
      threadId, scope: options.mine ? 'thread' : 'app', limit: Math.min(options.limit ?? 100, 500),
      minLevel: options.minLevel ?? 'info',
      ...(options.since === undefined ? {} : { since: options.since }), ...(options.origin ? { origin: options.origin } : {}), ...(options.search ? { search: options.search } : {}),
    });
    print(lines(records), records);
    return;
  }
  const query: CoreLogsQuery = {
    limit: options.limit ?? 100,
    ...(threadId ? { threadId } : {}),
    ...(options.level ? { level: options.level } : { minLevel: options.minLevel ?? 'info' }),
    ...(options.since === undefined ? {} : { since: options.since }), ...(options.origin ? { origin: options.origin } : {}),
    ...(options.search ? { search: options.search } : {}), ...(options.turn ? { turnId: options.turn } : {}), ...(options.anonymize ? { anonymize: true } : {}),
  };
  const records = await client.call('core.logs', query);
  print(lines(records), records);
}

export async function issueCommand(args: string[], client: CoreClient, threadId: string, agent: boolean, cwd: string, print: Printer): Promise<void> {
  const { positional, flags: options } = flags(args);
  const action = positional[0];
  if (action !== 'draft' && action !== 'submit') throw new Usage('issue expects draft or submit; boite logs help shows the flags');
  if (!options.title) throw new Usage('issue needs --title');
  let description = options.description;
  if (options.descriptionFile) description = readFileSync(isAbsolute(options.descriptionFile) ? options.descriptionFile : resolve(cwd, options.descriptionFile), 'utf8');
  if (!description) throw new Usage('issue needs --description or --description-file');
  const result = await client.call('diagnostics.issue', {
    ...(agent ? { threadId } : {}), title: options.title, description, includeLogs: !options.noLogs, submit: action === 'submit',
  });
  const out = [`repository: ${result.repository}`, `title: ${result.title}`, `gh: ${result.gh}`];
  if (result.url) out.push(`created: ${result.url}`);
  if (result.error) out.push(`not created: ${result.error}`);
  if (!result.url) out.push(`open to create it in a browser signed in to GitHub: ${result.prefillUrl}`);
  if (result.exportPath) out.push(`full anonymized export to attach: ${result.exportPath}`);
  if (action === 'draft') out.push('', result.body);
  print(out, result);
}
