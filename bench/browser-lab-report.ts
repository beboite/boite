import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tokenUsage, toolAudit } from './browser-luna-report.ts';

type Data = Record<string, any>;
const requiredSources = ['browser-lab.ts', 'browser-lab-page.ts', 'browser-lab-tasks.ts', 'browser-lab-codex.ts', 'browser-lab-engine.ts', 'browser-lab-isolation.ts', 'browser-lab-recording.ts'];
export interface LabReview {
  criteria: Array<{ met: boolean; observations: number[]; note: string }>;
  capturesViewed: number[];
  category: 'complete' | 'site-block' | 'interaction' | 'budget' | 'tool-error' | 'model-error' | 'incorrect-answer';
  excluded?: { cohort: string; reason: string };
}
const json = (path: string): Data => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function times(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { n, medianMs: n ? n % 2 ? sorted[Math.floor(n / 2)]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2 : null,
    p90Ms: n ? sorted[Math.ceil(n * 0.9) - 1]! : null };
}
function safeNote(note: unknown): string {
  if (typeof note !== 'string' || !note.trim()) throw new Error('Each review criterion needs a concrete note.');
  if (/(?<![A-Za-z])[A-Za-z]:[\\/]|(?:\/Users|\/home)\/|bearer\s|api[_-]?key|(?:secret|token|password)[=:]/i.test(note)) throw new Error('Private path or credential-like text in review note.');
  return note.replace(/\u2014/g, '-').replace(/\u2026/g, '...');
}
export function validateReview(review: LabReview, raw: Data, directory?: string) {
  if (review.excluded) { safeNote(review.excluded.cohort); safeNote(review.excluded.reason); }
  const observationIds = new Set((raw.observations ?? []).map((entry: Data) => entry.id));
  if (!Array.isArray(review.criteria) || review.criteria.length !== 3) throw new Error('Exactly three independent rubric decisions required.');
  for (const criterion of review.criteria) {
    if (typeof criterion.met !== 'boolean' || !Array.isArray(criterion.observations)) throw new Error('Invalid rubric decision.');
    safeNote(criterion.note);
    if (criterion.met && !criterion.observations.length) throw new Error('A satisfied criterion needs observation evidence.');
    if (criterion.observations.some(id => !observationIds.has(id))) throw new Error('Review cites missing observation.');
  }
  if (!Array.isArray(review.capturesViewed) || review.capturesViewed.some(id => !observationIds.has(id))) throw new Error('Review cites missing capture.');
  if (review.criteria.some(c => c.met) && !review.capturesViewed.length) throw new Error('A partially or fully successful task needs viewed captures.');
  if (directory) for (const id of review.capturesViewed) {
    if (!existsSync(join(directory, String(id).padStart(3, '0') + '.png'))) throw new Error('Viewed capture file is missing.');
  }
  const allMet = review.criteria.every(c => c.met);
  if (allMet !== (review.category === 'complete')) throw new Error('Review category contradicts rubric decisions.');
  return allMet && !raw.error && !raw.cancelled && !raw.model?.timedOut && raw.model?.turn?.status === 'completed'
    && raw.finished === true && raw.processesAfter === 0 && !raw.cleanupError
    && toolAudit(raw.model?.events).unexpectedTypes.length === 0 && !review.excluded;
}
export function verifyLabSources(input: string, hashes: Data) {
  for (const file of requiredSources) if (typeof hashes?.[file] !== 'string' || !/^[a-f0-9]{64}$/.test(hashes[file])) throw new Error('Missing source hash: ' + file);
  for (const [file, hash] of Object.entries(hashes)) {
    if (!/^[\w-]+\.ts$/.test(file) || sha(join(input, 'source', file)) !== hash) throw new Error('Frozen source hash mismatch: ' + file);
  }
}
function summarizeModes(protocol: Data, rows: Data[]) {
  return Object.fromEntries(protocol.modes.map((mode: string) => {
    const attempts = rows.filter(r => r.mode === mode);
    const eligible = attempts.filter(r => !r.excluded);
    return [mode, { expected: protocol.tasks.length * protocol.repetitions, reviewed: attempts.length, scored: eligible.length, excluded: attempts.length - eligible.length, succeeded: eligible.filter(r => r.verified).length,
      allTiming: times(eligible.filter(r => r.timing.totalMs !== null).map(r => r.timing.totalMs)),
      successfulTiming: times(eligible.filter(r => r.verified && r.timing.totalMs !== null).map(r => r.timing.totalMs)),
      categories: Object.fromEntries([...new Set(eligible.map(r => r.category))].map(category => [category, eligible.filter(r => r.category === category).length])),
    }];
  }));
}
export function labTokenUsage(model: Data = {}) {
  if (!Array.isArray(model.calls)) return { ...tokenUsage(model.events), basis: 'final cumulative thread usage' };
  const usage = tokenUsage([]);
  for (const call of model.calls) {
    const measured = tokenUsage(call.events);
    usage.updates += measured.updates;
    for (const key of Object.keys(usage.finalTotal) as Array<keyof typeof usage.finalTotal>) usage.finalTotal[key] += measured.finalTotal[key];
  }
  return { ...usage, basis: 'sum of final cumulative usage from each independent decision thread' };
}
export function buildLabReport(input: string, reviewFile: string, partial = false) {
  const protocol = json(join(input, 'protocol.json'));
  const reviews = json(reviewFile) as Record<string, LabReview>;
  verifyLabSources(input, protocol.sourceHashes);
  if (!Array.isArray(protocol.tasks) || !protocol.tasks.length || new Set(protocol.tasks.map((t: Data) => t.id)).size !== protocol.tasks.length
    || !Array.isArray(protocol.modes) || !protocol.modes.length || new Set(protocol.modes).size !== protocol.modes.length
    || !Number.isInteger(protocol.repetitions) || protocol.repetitions < 1) throw new Error('Invalid campaign matrix.');
  const expected = protocol.tasks.length * protocol.modes.length * protocol.repetitions;
  const rows: Data[] = [];
  const pending: string[] = [];
  for (let run = 1; run <= protocol.repetitions; run++) for (const task of protocol.tasks) for (const mode of protocol.modes) {
    const id = `${mode}-${task.id}-${run}`, directory = join(input, id), file = join(directory, 'result.json');
    if (!existsSync(file)) { pending.push(id); continue; }
    const raw = json(file), review = reviews[id];
    if (raw.id !== id || raw.task !== task.id || raw.mode !== mode || raw.run !== run) throw new Error('Trial identity differs from protocol: ' + id);
    if (!review) { pending.push(id + ':review'); continue; }
    const config = raw.model?.config;
    const configAcknowledged = config?.model === protocol.model && config?.effort === protocol.effort && config?.serviceTier === protocol.tier && config?.provider === 'openai';
    const verified = validateReview(review, raw, directory) && configAcknowledged;
    const usage = labTokenUsage(raw.model);
    const commands = json(join(directory, 'commands.json')) as unknown as Data[];
    const commandMs = commands.filter(c => c.phase !== 'keepalive').reduce((sum, c) => sum + (num(c.ms) ?? 0), 0);
    const totalMs = num(raw.totalMs) ?? num(raw.elapsedBeforeCleanupMs);
    rows.push({ id, task: task.id, mode, run, verified, category: review.category, excluded: review.excluded ? { cohort: safeNote(review.excluded.cohort), reason: safeNote(review.excluded.reason) } : null,
      criteria: review.criteria.map(c => ({ ...c, note: safeNote(c.note) })), capturesViewed: review.capturesViewed,
      timing: { totalMs, executionMs: num(raw.executionMs), startupMs: num(raw.startupMs), commandMs,
        timedOut: Boolean(raw.model?.timedOut), durationSource: raw.totalMs === undefined ? 'elapsed-before-cleanup' : 'startup-plus-execution' },
      actions: raw.actions, actionErrors: raw.attempts.filter((a: Data) => !a.success).length,
      observations: raw.observations.length, observationErrors: raw.observations.reduce((sum: number, o: Data) => sum + o.errors.length, 0),
      model: { config: raw.model?.config ?? null, configAcknowledged, usage: usage.finalTotal, usageUpdates: usage.updates, usageBasis: usage.basis, tools: toolAudit(raw.model?.events) },
      engine: { kind: raw.engine?.kind, agentBrowserVersion: raw.engine?.agentBrowserVersion, playwrightVersion: raw.engine?.playwrightVersion },
      processesAfter: raw.processesAfter, evidenceHashes: { result: sha(file), commands: sha(join(directory, 'commands.json')),
        observations: Object.fromEntries(raw.observations.map((o: Data) => { const stem = String(o.id).padStart(3, '0'); return [o.id, { json: sha(join(directory, stem + '.json')), png: existsSync(join(directory, stem + '.png')) ? sha(join(directory, stem + '.png')) : null }]; })),
        download: existsSync(join(directory, 'download.zip')) ? sha(join(directory, 'download.zip')) : null },
    });
  }
  if (!partial && pending.length) throw new Error(`${pending.length} attempts or reviews missing.`);
  const cleanup = existsSync(join(input, 'cleanup.json')) ? json(join(input, 'cleanup.json')) : null;
  const modelGroupsZero = Array.isArray(cleanup?.modelGroups) && cleanup.modelGroups.length > 0
    && new Set(cleanup.modelGroups.map((g: Data) => g.group)).size === cleanup.modelGroups.length
    && cleanup.modelGroups.every((g: Data) => typeof g.group === 'string' && g.group.startsWith('benchmark-browser-lab:') && g.remaining === 0);
  if (!partial && (!cleanup || cleanup.stopReason || !modelGroupsZero)) throw new Error('Complete clean shutdown required.');
  return { campaign: protocol.date, expected, reviewed: rows.length, pending, complete: pending.length === 0 && cleanup !== null && !cleanup.stopReason && modelGroupsZero && rows.every(r => r.processesAfter === 0),
    protocol: { tasks: protocol.tasks, modes: protocol.modes, repetitions: protocol.repetitions, timeoutMs: protocol.timeoutMs,
      maxActions: protocol.maxActions, maxDecisions: protocol.maxDecisions ?? null, model: protocol.model, effort: protocol.effort, tier: protocol.tier, recorded: protocol.recorded, isolatedContext: protocol.isolatedContext,
      campaignLane: protocol.campaignLane, campaignConcurrency: protocol.campaignConcurrency, cadence: protocol.cadence ?? 'one conversation per task with steered observations',
      directCapture: protocol.directCapture ?? false, nativeDownloadCorrection: protocol.nativeDownloadCorrection ?? false,
      transportCorrection: protocol.transportCorrection ?? null,
      sourceHashes: protocol.sourceHashes, binaryHash: protocol.binaryHash },
    modes: summarizeModes(protocol, rows), cleanup: { browserZero: rows.filter(r => r.processesAfter === 0).length, modelGroupsZero }, attempts: rows };
}
export function combineLabReports(reports: ReturnType<typeof buildLabReport>[]) {
  if (!reports.length) throw new Error('At least one lane required.');
  const first = reports[0]!;
  const shared = (p: Data) => { const { tasks, campaignLane, ...rest } = p; return rest; };
  const keys = new Set<string>();
  for (const report of reports) {
    if (JSON.stringify(shared(report.protocol)) !== JSON.stringify(shared(first.protocol))) throw new Error('Lane protocols differ.');
    for (const task of report.protocol.tasks) { if (keys.has(task.id)) throw new Error('Duplicate lane task: ' + task.id); keys.add(task.id); }
  }
  const attempts = reports.flatMap(r => r.attempts);
  const protocol = { ...first.protocol, campaignLane: reports.map(r => r.protocol.campaignLane).join(','), tasks: reports.flatMap(r => r.protocol.tasks) };
  return { campaign: first.campaign, lanes: reports.map(r => ({ lane: r.protocol.campaignLane, startedAt: r.campaign, expected: r.expected, complete: r.complete })),
    expected: reports.reduce((sum, r) => sum + r.expected, 0), reviewed: attempts.length, pending: reports.flatMap(r => r.pending), complete: reports.every(r => r.complete),
    protocol, modes: summarizeModes(protocol, attempts), cleanup: { browserZero: reports.reduce((sum, r) => sum + r.cleanup.browserZero, 0), modelGroupsZero: reports.every(r => r.cleanup.modelGroupsZero) }, attempts };
}
if (import.meta.main) {
  const [input, reviews, output, flag] = process.argv.slice(2);
  if (!input || !reviews || !output || (flag !== undefined && flag !== '--partial')) throw new Error('Expected RUN_DIR REVIEW_JSON OUTPUT_DIR [--partial].');
  const report = buildLabReport(resolve(input), resolve(reviews), flag === '--partial');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'public-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ expected: report.expected, reviewed: report.reviewed, complete: report.complete, modes: report.modes }));
}
