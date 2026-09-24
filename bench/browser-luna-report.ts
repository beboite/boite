import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Data = Record<string, any>;
type Sample = { task: Data; mode: string; run: number; raw: Data };
const tokenKeys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
const sourceFiles = ['browser-luna.ts', 'browser-luna-codex.ts', 'browser-luna-page.ts', 'browser-wide-tasks.ts', 'browser-wide-grade.ts', '../packages/core/src/browser/loop.ts'];
const actionNames = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll']);

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const readJson = (path: string): Data => JSON.parse(readFileSync(path, 'utf8'));
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const zeroTokens = () => Object.fromEntries(tokenKeys.map(key => [key, 0])) as Record<(typeof tokenKeys)[number], number>;

function addTokens(target: ReturnType<typeof zeroTokens>, source: Data | undefined): void {
  for (const key of tokenKeys) target[key] += finite(source?.[key]) ?? 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[at]! : (sorted[at - 1]! + sorted[at]!) / 2;
}

function times(values: number[]) {
  return { medianMs: median(values), minMs: values.length ? Math.min(...values) : null, maxMs: values.length ? Math.max(...values) : null };
}

/** The p90 observation is at the one-based ceiling of 90% of measured samples. */
function measuredTimes(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, medianMs: median(sorted), p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null,
    minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null };
}

function cleanText(raw: unknown, limit = 120): string | null {
  if (typeof raw !== 'string') return null;
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\u2014/g, ' - ').replace(/\u2026/g, '...').slice(0, limit);
}

function cleanFieldValue(raw: unknown): string | null {
  const value = cleanText(raw, 100);
  if (value === null) return null;
  return /bearer\s|api[_-]?key|password|secret|token[=:]/i.test(value) ? '[redacted]' : value;
}

/** Keep public query fields named by the frozen task and discard incidental tokens. */
export function sanitizeUrl(raw: unknown, task: Data): { value: string | null; redacted: boolean } {
  if (typeof raw !== 'string') return { value: null, redacted: false };
  try {
    const url = new URL(raw);
    const initial = new URL(task.url);
    if (url.origin !== initial.origin) return { value: null, redacted: true };
    let redacted = Boolean(url.username || url.password);
    url.username = ''; url.password = '';
    const allowed = new Map<string, Set<string>>();
    const addAllowed = (key: string, value: string) => {
      if (!allowed.has(key)) allowed.set(key, new Set());
      allowed.get(key)!.add(value);
    };
    for (const [key, value] of initial.searchParams) addAllowed(key, value);
    let allowedHash = initial.hash;
    for (const predicate of task.grader?.all ?? []) {
      for (const [key, value] of Object.entries(predicate.query ?? {})) if (typeof value === 'string') addAllowed(key, value);
      if (typeof predicate.equals !== 'string') continue;
      const exact = new URL(predicate.equals);
      if (exact.origin !== url.origin) continue;
      for (const [key, value] of exact.searchParams) addAllowed(key, value);
      if (exact.hash) allowedHash = exact.hash;
    }
    for (const [key, value] of [...url.searchParams]) if (!allowed.get(key)?.has(value)) { url.searchParams.delete(key); redacted = true; }
    const safeFragment = /^#[a-z][a-z0-9-]{0,60}$/i.test(url.hash) && !/token|auth|session|secret|password|code/i.test(url.hash);
    if (url.hash && url.hash !== allowedHash && !safeFragment) { url.hash = ''; redacted = true; }
    return { value: url.href, redacted };
  } catch { return { value: null, redacted: true }; }
}

export function sanitizeControls(raw: unknown, task: Data): Record<string, Data[]> {
  const controls = raw && typeof raw === 'object' ? raw as Data : {};
  const result: Record<string, Data[]> = {};
  for (const predicate of task.grader?.all ?? []) {
    if (predicate.kind !== 'control' || typeof predicate.selector !== 'string') continue;
    const observed = controls[predicate.selector];
    result[predicate.selector] = Array.isArray(observed) ? observed.slice(0, 5).map((control: Data) => ({
      ...(typeof control.value === 'string' ? { value: cleanFieldValue(control.value) } : {}),
      ...(typeof control.checked === 'boolean' ? { checked: control.checked } : {}),
      ...(typeof control.expanded === 'boolean' ? { expanded: control.expanded } : {}),
    })) : [];
  }
  return result;
}

export function tokenUsage(events: Data[] = []) {
  const lastSum = zeroTokens();
  const finalTotal = zeroTokens();
  let updates = 0;
  for (const event of events) {
    if (event.method !== 'thread/tokenUsage/updated') continue;
    const usage = event.params?.tokenUsage;
    if (!usage?.total || !usage?.last) continue;
    addTokens(lastSum, usage.last);
    for (const key of tokenKeys) finalTotal[key] = finite(usage.total[key]) ?? 0;
    updates++;
  }
  return { updates, finalTotal, lastSum, uncachedInputTokens: finalTotal.inputTokens - finalTotal.cachedInputTokens,
    lastSumMatchesTotal: updates === 0 || tokenKeys.every(key => lastSum[key] === finalTotal[key]) };
}

/** Count any item type outside ordinary messages as a tool until reviewed. */
export function toolAudit(events: Data[] = []) {
  const ordinary = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'error']);
  const items = events.filter(event => event.method === 'item/started').map(event => event.params?.item).filter(Boolean);
  const calls = items.filter(item => !ordinary.has(String(item.type)));
  const browser = calls.filter(item => item.type === 'dynamicToolCall' && item.tool === 'browser');
  return {
    calls: calls.length,
    batchCommandsRequested: browser.reduce((sum: number, item: Data) => sum + (Array.isArray(item.arguments?.commands) ? item.arguments.commands.length : 0), 0),
    unexpectedTypes: calls.filter(item => item.type !== 'dynamicToolCall' || item.tool !== 'browser').map(item => String(item.type ?? 'unknown')),
  };
}

function errorCategory(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).toLowerCase();
  if (/deadline|timed out|timeout|expired/.test(value)) return 'timeout';
  if (/origin/.test(value)) return 'origin';
  if (/selector|ref=|not observed/.test(value)) return 'selector';
  if (/network|connect|socket|econn/.test(value)) return 'connection';
  if (/model|codex|thread|turn/.test(value)) return 'model';
  if (/browser|daemon|page/.test(value)) return 'browser';
  return 'other';
}

export function verifySourceHashes(protocol: Data, benchDir = import.meta.dir): Record<string, string> {
  if (!protocol.files || typeof protocol.files !== 'object') throw new Error('Protocol has no source hashes.');
  const hashes: Record<string, string> = {};
  const files = [...sourceFiles, ...(Object.hasOwn(protocol.files, 'browser-luna-commands.ts') ? ['browser-luna-commands.ts'] : [])];
  for (const file of files) {
    const expected = protocol.files[file];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Missing source hash for ' + file);
    const actual = digest(resolve(benchDir, file));
    if (actual !== expected) throw new Error('Source hash differs from frozen protocol: ' + file);
    hashes[file] = actual;
  }
  return hashes;
}

export function summarize(protocol: Data, samples: Sample[], modelMetadata: Data = {}, codexProcessesAfter: number | null = null) {
  const tasks: Data[] = protocol.tasks;
  const modes: string[] = protocol.modes;
  const repetitions: number = protocol.repetitions;
  if (!modes.includes('luna') || !modes.includes('hybrid') || !Number.isInteger(repetitions) || repetitions < 1) throw new Error('Expected Luna and hybrid modes with positive repetitions.');
  const expected = tasks.length * modes.length * repetitions;
  const rows = samples.map(({ task, mode, run, raw }) => {
    const modelExpected = mode === 'luna' || raw.fallback === true;
    const config = raw.model?.config;
    const configAcknowledged = modelExpected ? config?.model === 'gpt-6-luna' && config?.effort === 'max' && config?.serviceTier === 'priority' && config?.provider === 'openai' : null;
    const usage = tokenUsage(raw.model?.events);
    const tools = toolAudit(raw.model?.events);
    const url = sanitizeUrl(raw.final?.url, task);
    const startup = finite(raw.startupMs), execution = finite(raw.executionMs);
    const total = finite(raw.totalMs) ?? (startup !== null && execution !== null ? startup + execution : null);
    return {
      task: task.id, site: cleanText(task.site), category: cleanText(task.category), mode, run,
      verified: raw.verified === true, fallback: raw.fallback === true, jevOutcome: raw.jevOutcome?.status ?? null,
      timingMs: { startup, execution, total, jev: finite(raw.jevMs) },
      counts: { actions: finite(raw.actionCount), jevDecisions: Array.isArray(raw.jevDecisions) ? raw.jevDecisions.length : 0,
        toolCalls: tools.calls, batchCommandsRequested: tools.batchCommandsRequested,
        batchCommandsExecuted: Array.isArray(raw.toolAttempts) ? raw.toolAttempts.length : 0 },
      model: modelExpected && raw.model ? { configAcknowledged, turnStatus: raw.model?.turn?.status ?? 'missing', timedOut: raw.model?.timedOut === true,
        tokenUsage: usage.finalTotal, uncachedInputTokens: usage.uncachedInputTokens, lastSumMatchesTotal: usage.lastSumMatchesTotal,
        unexpectedToolCount: tools.unexpectedTypes.length } : null,
      cleanup: { browserProcessesAfter: finite(raw.processesAfter), errorCategory: errorCategory(raw.cleanupError) },
      outcome: { finalUrl: url.value, urlQueryRedacted: url.redacted, title: cleanText(raw.final?.title),
        graderChecks: Array.isArray(raw.grading?.checks) ? raw.grading.checks.map(Boolean) : [],
        graderPassed: raw.grading?.passed === true, controls: sanitizeControls(raw.final?.controls, task),
        errorCategory: errorCategory(raw.error ?? raw.evidenceError), recordingErrorCategory: errorCategory(raw.videoError) },
    };
  });
  const pending: { task: string; mode: string; run: number }[] = [];
  for (const task of tasks) for (let run = 1; run <= repetitions; run++) for (const mode of modes) {
    if (!rows.some(row => row.task === task.id && row.run === run && row.mode === mode)) pending.push({ task: task.id, mode, run });
  }
  const modeSummary: Record<string, Data> = {};
  for (const mode of modes) {
    const selected = rows.filter(row => row.mode === mode);
    const successful = selected.filter(row => row.verified);
    const successfulTimes = successful.map(row => row.timingMs.total).filter((value): value is number => value !== null);
    const allTimes = selected.map(row => row.timingMs.total).filter((value): value is number => value !== null);
    const failedTimes = selected.filter(row => !row.verified).map(row => row.timingMs.total).filter((value): value is number => value !== null);
    modeSummary[mode] = {
      expected: tasks.length * repetitions, completed: selected.length, pending: tasks.length * repetitions - selected.length,
      successful: successful.length, successfulTimingMs: times(successfulTimes),
      allTimingMs: measuredTimes(allTimes), failedTimingMs: measuredTimes(failedTimes),
      fallback: selected.filter(row => row.fallback).length, fallbackSuccessful: selected.filter(row => row.fallback && row.verified).length,
      jevOnly: selected.filter(row => row.jevOutcome === 'succeeded' && !row.fallback).length,
      jevOnlySuccessful: selected.filter(row => row.jevOutcome === 'succeeded' && !row.fallback && row.verified).length,
    };
  }
  const paired = [] as { task: string; run: number; direct: typeof rows[number]; hybrid: typeof rows[number] }[];
  for (const task of tasks) for (let run = 1; run <= repetitions; run++) {
    const direct = rows.find(row => row.task === task.id && row.run === run && row.mode === 'luna');
    const hybrid = rows.find(row => row.task === task.id && row.run === run && row.mode === 'hybrid');
    if (direct && hybrid) paired.push({ task: task.id, run, direct, hybrid });
  }
  const both = paired.filter(pair => pair.direct.verified && pair.hybrid.verified && pair.direct.timingMs.total !== null && pair.hybrid.timingMs.total !== null);
  const pairedSummary = { expected: tasks.length * repetitions, completed: paired.length, pending: tasks.length * repetitions - paired.length,
    directSuccessful: paired.filter(pair => pair.direct.verified).length, hybridSuccessful: paired.filter(pair => pair.hybrid.verified).length,
    bothSuccessful: both.length,
    bothSuccessfulTimingMs: { direct: times(both.map(pair => pair.direct.timingMs.total!)), hybrid: times(both.map(pair => pair.hybrid.timingMs.total!)) } };
  const tokens = zeroTokens();
  for (const row of rows) addTokens(tokens, row.model?.tokenUsage);
  const expectedModelLegs = rows.filter(row => row.mode === 'luna' || row.fallback).length;
  const modelLegs = rows.filter(row => row.model !== null);
  const turnStatuses: Record<string, number> = {};
  for (const row of modelLegs) turnStatuses[row.model!.turnStatus] = (turnStatuses[row.model!.turnStatus] ?? 0) + 1;
  const unexpectedToolCount = modelLegs.reduce((sum, row) => sum + row.model!.unexpectedToolCount, 0);
  const pythonAlias = rows.filter(row => {
    if (row.task !== 'python-json-french' || row.verified || JSON.stringify(row.outcome.graderChecks) !== '[false,true]' || !row.outcome.finalUrl?.includes('/fr/3.14/library/json.html')) return false;
    const raw = samples.find(sample => sample.task.id === row.task && sample.mode === row.mode && sample.run === row.run)?.raw;
    return typeof raw?.final?.text === 'string' && raw.final.text.includes('Utilisation de base')
      && raw.commands?.some((command: Data) => command.action === 'select' && command.args?.values === 'fr' && command.success === true) === true;
  });
  return {
    schema: 1, campaignDate: protocol.date, complete: pending.length === 0,
    totals: { expected, completed: rows.length, pending: pending.length, successful: rows.filter(row => row.verified).length,
      toolCalls: rows.reduce((sum, row) => sum + row.counts.toolCalls, 0),
      batchCommandsRequested: rows.reduce((sum, row) => sum + row.counts.batchCommandsRequested, 0),
      batchCommandsExecuted: rows.reduce((sum, row) => sum + row.counts.batchCommandsExecuted, 0),
      actions: rows.reduce((sum, row) => sum + (row.counts.actions ?? 0), 0) },
    modes: modeSummary, paired: pairedSummary,
    modelAudit: { expectedOnCompletedTrials: expectedModelLegs, recordedLegs: modelLegs.length,
      missingRecords: expectedModelLegs - modelLegs.length, acknowledged: modelLegs.filter(row => row.model!.configAcknowledged).length,
      turnStatuses, unexpectedToolCount, tokenUsage: tokens, uncachedInputTokens: tokens.inputTokens - tokens.cachedInputTokens,
      inconsistentUsageTrials: modelLegs.filter(row => !row.model!.lastSumMatchesTotal).length },
    cleanup: { browserZero: rows.filter(row => row.cleanup.browserProcessesAfter === 0).length,
      browserNonzeroOrMissing: rows.filter(row => row.cleanup.browserProcessesAfter !== 0).length,
      codexProcessesAfter },
    possibleCriterionAlias: pythonAlias.map(row => ({ task: row.task, mode: row.mode, run: row.run, finalUrl: row.outcome.finalUrl, graderChecks: row.outcome.graderChecks })),
    protocol: { tasks: tasks.length, repetitions, modes, recorded: protocol.recorded === true, model: 'gpt-6-luna', effort: 'max', serviceTier: 'priority',
      browserDriver: { name: 'agent-browser', version: '0.37.1', transport: 'native daemon JSONL' },
      modelCatalogue: { model: modelMetadata.model?.model ?? null,
        supportsMax: modelMetadata.model?.efforts?.some((item: Data) => item.reasoningEffort === 'max') === true,
        supportsPriority: modelMetadata.model?.serviceTiers?.some((item: Data) => item.id === 'priority') === true },
      policy: { direct: 'Luna controls a fresh browser for the whole task.',
        hybrid: 'Jev runs for at most 10 steps or 15 seconds; Luna resumes the same browser after handoff or error.',
        sharedActionLimit: protocol.maxActions, sharedExecutionLimitMs: protocol.timeoutMs, viewport: protocol.viewport,
        graderTriggersFallback: false, lunaReceivesRenderedFieldMetadata: true },
      hashes: { browserBinary: protocol.browserSha256,
        ...(protocol.files?.['browser-luna-commands.ts'] ? { commandGate: protocol.files['browser-luna-commands.ts'] } : {}),
        runner: protocol.files?.['browser-luna.ts'], codexTransport: protocol.files?.['browser-luna-codex.ts'],
        pageAdapter: protocol.files?.['browser-luna-page.ts'], taskManifest: protocol.files?.['browser-wide-tasks.ts'],
        grader: protocol.files?.['browser-wide-grade.ts'], jevLoop: protocol.files?.['../packages/core/src/browser/loop.ts'] } },
    pending, attempts: rows,
  };
}

const sec = (value: number | null) => value === null ? 'n/a' : (value / 1000).toFixed(2) + ' s';
const cell = (value: unknown) => String(value ?? '').replace(/[\\|]/g, '\\$&').replace(/[\r\n]/g, ' ');

export function reportMarkdown(result: ReturnType<typeof summarize>, tasks: Data[]): string {
  const direct = result.modes.luna!, hybrid = result.modes.hybrid!;
  const lines: string[] = ['# Luna browser benchmark', ''];
  lines.push('Campaign date: ' + String(result.campaignDate).slice(0, 10) + '. Completed ' + result.totals.completed + '/' + result.totals.expected + ' attempts; ' + result.totals.pending + ' pending. Every completed failure remains in the strict denominator.');
  lines.push('');
  lines.push('Direct Luna: ' + direct.successful + '/' + direct.expected + ' scheduled successes; ' + direct.completed + ' completed. Successful startup plus execution median ' + sec(direct.successfulTimingMs.medianMs) + ', range ' + sec(direct.successfulTimingMs.minMs) + ' to ' + sec(direct.successfulTimingMs.maxMs) + '. All measured attempts median ' + sec(direct.allTimingMs.medianMs) + ', p90 ' + sec(direct.allTimingMs.p90Ms) + ' (n=' + direct.allTimingMs.n + ', missing timing ' + (direct.completed - direct.allTimingMs.n) + '); measured failures median ' + sec(direct.failedTimingMs.medianMs) + ' (n=' + direct.failedTimingMs.n + ').');
  lines.push('Hybrid Jev then Luna: ' + hybrid.successful + '/' + hybrid.expected + ' scheduled successes; ' + hybrid.completed + ' completed. Successful startup plus execution median ' + sec(hybrid.successfulTimingMs.medianMs) + ', range ' + sec(hybrid.successfulTimingMs.minMs) + ' to ' + sec(hybrid.successfulTimingMs.maxMs) + '. All measured attempts median ' + sec(hybrid.allTimingMs.medianMs) + ', p90 ' + sec(hybrid.allTimingMs.p90Ms) + ' (n=' + hybrid.allTimingMs.n + ', missing timing ' + (hybrid.completed - hybrid.allTimingMs.n) + '); measured failures median ' + sec(hybrid.failedTimingMs.medianMs) + ' (n=' + hybrid.failedTimingMs.n + '). Jev-only successes: ' + hybrid.jevOnlySuccessful + '/' + hybrid.jevOnly + '. Fallback successes: ' + hybrid.fallbackSuccessful + '/' + hybrid.fallback + '.');
  lines.push('');
  lines.push('Both modes completed ' + result.paired.completed + '/' + result.paired.expected + ' task and repetition pairs. Both succeeded on ' + result.paired.bothSuccessful + '. On those same successful pairs, direct median was ' + sec(result.paired.bothSuccessfulTimingMs.direct.medianMs) + ' and hybrid median was ' + sec(result.paired.bothSuccessfulTimingMs.hybrid.medianMs) + '.');
  lines.push('');
  lines.push('## All workflows', '', '| Site | Workflow | Direct | Hybrid | Direct successful median | Hybrid successful median |', '| --- | --- | --- | --- | --- | --- |');
  const score = (task: Data, mode: string) => {
    const rows = result.attempts.filter(row => row.task === task.id && row.mode === mode);
    const missing = result.protocol.repetitions - rows.length;
    return rows.filter(row => row.verified).length + '/' + result.protocol.repetitions + (missing ? ' (' + missing + ' pending)' : '');
  };
  const taskTime = (task: Data, mode: string) => sec(median(result.attempts.filter(row => row.task === task.id && row.mode === mode && row.verified && row.timingMs.total !== null).map(row => row.timingMs.total!)));
  for (const task of tasks) lines.push('| ' + cell(task.site) + ' | ' + cell(task.id) + ' | ' + score(task, 'luna') + ' | ' + score(task, 'hybrid') + ' | ' + taskTime(task, 'luna') + ' | ' + taskTime(task, 'hybrid') + ' |');
  lines.push('', '## Measurement and checks', '');
  lines.push('Times include browser startup and execution, and exclude final evidence capture and cleanup. Successful timing uses successful attempts only; all-attempt and failed timing include each completed trial with a measured total, regardless of outcome. The p90 uses the nearest-rank observation at ceil(0.9 x n). Both policies share the frozen public goals, independent graders, 30-action limit, and 120-second execution limit. Luna receives rendered field metadata and can search a large snapshot.');
  lines.push('Codex acknowledged GPT-6 Luna at max reasoning and priority tier on ' + result.modelAudit.acknowledged + '/' + result.modelAudit.recordedLegs + ' recorded Luna legs; ' + result.modelAudit.expectedOnCompletedTrials + ' expected trial' + (result.modelAudit.expectedOnCompletedTrials === 1 ? '' : 's') + ', ' + result.modelAudit.missingRecords + ' missing record' + (result.modelAudit.missingRecords === 1 ? '' : 's') + '. Turn statuses: ' + JSON.stringify(result.modelAudit.turnStatuses) + '. Unexpected tool items: ' + result.modelAudit.unexpectedToolCount + '.');
  lines.push('Final cumulative token totals: input ' + result.modelAudit.tokenUsage.inputTokens + ', uncached input ' + result.modelAudit.uncachedInputTokens + ', cached input ' + result.modelAudit.tokenUsage.cachedInputTokens + ', output ' + result.modelAudit.tokenUsage.outputTokens + ', reasoning output ' + result.modelAudit.tokenUsage.reasoningOutputTokens + '. Subscription usage has no dollar cost estimate.');
  lines.push('Tool calls: ' + result.totals.toolCalls + '. Batch commands requested: ' + result.totals.batchCommandsRequested + ', executed: ' + result.totals.batchCommandsExecuted + '. Browser actions: ' + result.totals.actions + '. Browser process groups with zero remaining processes: ' + result.cleanup.browserZero + '/' + result.totals.completed + '. Final Codex app-server processes: ' + (result.cleanup.codexProcessesAfter ?? 'pending') + '.');
  if (result.possibleCriterionAlias.length) lines.push('Possible frozen URL criterion mismatch: ' + result.possibleCriterionAlias.map(row => row.mode + '/' + row.task + '/' + row.run).join(', ') + ' reached the versioned French Python documentation path while the URL check failed. Strict failures remain unchanged. Separate adjudication would be needed.');
  lines.push('', '## Reproduction', '');
  lines.push('The [public result data](public-results.json) contains frozen hashes and sanitized per-attempt outcomes. Rebuild this report from the raw campaign files with bun bench/browser-luna-report.ts --input RUN_DIR --output REPORT_DIR. For a historical campaign, add --source-bench-dir HISTORICAL_CHECKOUT/bench; every frozen source hash must still match that tree. Add --partial only while trials are still pending.');
  lines.push('The earlier Jev-only 45.2% report used 84 valid attempts after excluding six defective criteria from 90 trials, with three repetitions. Its criteria and denominator differ from this campaign, so its percentage is context rather than a direct improvement measure.');
  if (!result.complete) lines.push('This report is partial. Rerun the command without --partial after the campaign finishes.');
  return lines.join('\n') + '\n';
}

export function runReport(input: string, output: string, partial = false, sourceBenchDir = import.meta.dir): ReturnType<typeof summarize> {
  const protocol = readJson(join(input, 'protocol.json'));
  verifySourceHashes(protocol, sourceBenchDir);
  const model = existsSync(join(input, 'model.json')) ? readJson(join(input, 'model.json')) : {};
  const samples: Sample[] = [];
  for (const task of protocol.tasks as Data[]) for (let run = 1; run <= protocol.repetitions; run++) for (const mode of protocol.modes as string[]) {
    const path = join(input, mode + '-' + task.id + '-' + run + '.json');
    if (!existsSync(path)) continue;
    try { samples.push({ task, mode, run, raw: readJson(path) }); }
    catch (error) { if (!partial) throw new Error('Unreadable result: ' + mode + '/' + task.id + '/' + run, { cause: error }); }
  }
  const cleanup = existsSync(join(input, 'cleanup.json')) ? readJson(join(input, 'cleanup.json')) : {};
  const codexProcessesAfter = finite(cleanup.codexProcessesAfter);
  const result = summarize(protocol, samples, model, codexProcessesAfter);
  if (!partial && !result.complete) throw new Error('Campaign has ' + result.totals.pending + ' pending attempts. Use --partial for a draft.');
  if (!partial && codexProcessesAfter !== 0) throw new Error('Final Codex app-server cleanup is missing or nonzero.');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'public-results.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(output, 'report.md'), reportMarkdown(result, protocol.tasks));
  return result;
}

function cli(args: string[]) {
  let input: string | undefined, output: string | undefined, sourceBenchDir: string | undefined, partial = false;
  let start = 0;
  if (args[0] && !args[0].startsWith('--')) {
    [input, output] = args;
    if (!output || output.startsWith('--')) throw new Error('Expected input and output directory arguments.');
    start = 2;
  }
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--partial') { partial = true; continue; }
    if (!['--input', '--output', '--source-bench-dir'].includes(String(arg))) throw new Error('Unknown report argument: ' + arg);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Expected a directory after ' + arg + '.');
    if (arg === '--input') input = value;
    else if (arg === '--output') output = value;
    else sourceBenchDir = resolve(value);
  }
  if (!input || !output) throw new Error('Required: --input <run-directory> --output <report-directory>.');
  const result = runReport(resolve(input), resolve(output), partial, sourceBenchDir);
  console.log(JSON.stringify({ completed: result.totals.completed, expected: result.totals.expected, pending: result.totals.pending,
    direct: result.modes.luna!.successful, hybrid: result.modes.hybrid!.successful, codexProcessesAfter: result.cleanup.codexProcessesAfter }));
}

if (import.meta.main) cli(process.argv.slice(2));
