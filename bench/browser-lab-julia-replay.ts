import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJuliaResult } from './browser-lab-julia-choice.ts';

export type ReplayMode = 'full' | 'target-state' | 'local-router';
export type JuliaBackend = 'torch' | 'onnx';
export interface ReplayCase {
  id: string;
  task: { id: string; goal: string };
  state: string;
  question: string;
  options: string[];
  expected: number;
  acceptableIndices: number[];
  kind: 'local_action' | 'fact_verification' | 'completion_verification';
}

interface ReplaySample {
  configuration: ReplayMode;
  id: string;
  task: string;
  kind: ReplayCase['kind'];
  expected: number;
  acceptableIndices: number[];
  originalStateCharacters: number;
  preparedStateCharacters: number;
  inputFile: string;
  inputSha256: string;
  httpStatus?: number;
  response?: unknown;
  rawResponse?: string;
  error?: string;
  predicted?: number;
  inputTokens?: number;
  serverMs?: number;
  accepted: boolean;
  historicalCorrect: boolean;
  semanticCorrect: boolean;
  wallMs: number;
}

const modes: ReplayMode[] = ['full', 'target-state', 'local-router'];
const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: expected a nonempty string.`);
  return value;
}
function index(value: unknown, count: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= count) throw new Error(`${field}: expected a zero-based integer below ${count}.`);
  return value as number;
}

/** Accept both a metadata envelope and the flat metadata in the public source. */
export function parseReplayDataset(value: unknown): { metadata: Record<string, unknown>; cases: ReplayCase[] } {
  if (!object(value) || !Array.isArray(value.cases) || !value.cases.length) throw new Error('dataset.cases: expected a nonempty array.');
  if (value.metadata !== undefined && !object(value.metadata)) throw new Error('dataset.metadata: expected an object.');
  const metadata = object(value.metadata) ? value.metadata : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cases'));
  const seen = new Set<string>();
  const cases = value.cases.map((raw: unknown, offset: number): ReplayCase => {
    if (!object(raw) || !object(raw.task)) throw new Error(`cases[${offset}].task: expected an object.`);
    const id = text(raw.id, `cases[${offset}].id`);
    if (seen.has(id)) throw new Error(`cases[${offset}].id: duplicate case ID.`);
    seen.add(id);
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 20) throw new Error(`${id}.options: expected 2 to 20 options.`);
    const options = raw.options.map((option: unknown, optionIndex: number) => text(option, `${id}.options[${optionIndex}]`));
    const expected = index(raw.expected, options.length, `${id}.expected`);
    if (!Array.isArray(raw.acceptableIndices) || !raw.acceptableIndices.length) throw new Error(`${id}.acceptableIndices: expected a nonempty array.`);
    const acceptableIndices = raw.acceptableIndices.map((label: unknown) => index(label, options.length, `${id}.acceptableIndices`));
    if (new Set(acceptableIndices).size !== acceptableIndices.length || !acceptableIndices.includes(expected)) throw new Error(`${id}.acceptableIndices: expected unique labels including expected.`);
    if (!['local_action', 'fact_verification', 'completion_verification'].includes(String(raw.kind))) throw new Error(`${id}.kind: expected a supported replay kind.`);
    return { id, task: { id: text(raw.task.id, `${id}.task.id`), goal: text(raw.task.goal, `${id}.task.goal`) },
      state: text(raw.state, `${id}.state`), question: text(raw.question, `${id}.question`), options, expected, acceptableIndices,
      kind: raw.kind as ReplayCase['kind'] };
  });
  return { metadata, cases };
}

/** Preserve the historical target-state and local-router policies exactly. */
export function projectReplayState(row: ReplayCase, mode: ReplayMode): string {
  if (mode === 'full') return row.state;
  if (mode === 'local-router') {
    if (row.kind !== 'local_action') throw new Error('local-router: expected a local_action case.');
    return row.state.split('\n').slice(0, 2).join('\n')
      + '\nPage body and DOM inventory omitted in this explicit local-subgoal router ablation; options still come from observed controls.';
  }
  if (mode !== 'target-state') throw new Error('mode: expected full, target-state or local-router.');
  if (row.kind !== 'local_action') return row.state;
  const marker = '\nCandidate control entries in original snapshot order:';
  const at = row.state.indexOf(marker);
  if (at < 0) throw new Error(`${row.id}: missing candidate context marker.`);
  const lines = row.state.slice(0, at).split('\n');
  return lines.slice(0, 3).join('\n') + '\n' + lines.slice(3).join('\n').slice(0, 500)
    + '\nBody prefix shortened to 500 characters; all supplied candidate control/link entries and tabs retained.\n' + row.state.slice(at);
}

export function selectReplayCases(cases: ReplayCase[], mode: ReplayMode) {
  return mode === 'local-router' ? cases.filter(row => row.kind === 'local_action') : [...cases];
}

/** Enumerate allowed input fields; labels and provenance never enter the request. */
export function prepareReplayRequest(row: ReplayCase, mode: ReplayMode, backend: JuliaBackend) {
  return { rows: [{ state: 'Task goal: ' + row.task.goal + '\n' + projectReplayState(row, mode),
    question: row.question, options: [...row.options], type: 'choice' as const }], backend, maxLength: 8192 };
}

function settings(environment: Record<string, string | undefined>) {
  if (environment.BOITE_BENCH_JULIA !== '1') throw new Error('Replay is opt-in: set BOITE_BENCH_JULIA=1.');
  const backend = environment.BOITE_JULIA_BACKEND ?? 'torch';
  if (backend !== 'torch' && backend !== 'onnx') throw new Error('BOITE_JULIA_BACKEND: expected torch or onnx.');
  const selectedModes = (environment.BOITE_JULIA_REPLAY_MODES ?? modes.join(',')).split(',').map(value => value.trim());
  if (!selectedModes.length || new Set(selectedModes).size !== selectedModes.length || selectedModes.some(mode => !modes.includes(mode as ReplayMode))) throw new Error('BOITE_JULIA_REPLAY_MODES: expected distinct full,target-state,local-router modes.');
  const endpoint = new URL(environment.BOITE_JULIA_URL ?? 'http://127.0.0.1:18884');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('BOITE_JULIA_URL: expected an HTTP loopback origin without credentials, query or path.');
  const output = resolve(text(environment.BOITE_BENCH_OUTPUT, 'BOITE_BENCH_OUTPUT'));
  if (existsSync(output)) throw new Error('BOITE_BENCH_OUTPUT: expected a fresh output directory.');
  const dataset = environment.BOITE_JULIA_DATASET
    ? resolve(environment.BOITE_JULIA_DATASET)
    : fileURLToPath(new URL('./results/2026-09-29-julia/natural-decision-cases.json', import.meta.url));
  const ids = environment.BOITE_JULIA_CASES?.split(',').map(value => value.trim());
  if (ids && (ids.some(id => !id) || new Set(ids).size !== ids.length)) throw new Error('BOITE_JULIA_CASES: expected distinct comma-separated case IDs.');
  return { backend: backend as JuliaBackend, modes: selectedModes as ReplayMode[], endpoint, output, dataset, ids, token: environment.BOITE_JULIA_TOKEN?.trim() };
}

function summaries(results: ReplaySample[], selectedModes: ReplayMode[]) {
  return selectedModes.map(configuration => {
    const rows = results.filter(row => row.configuration === configuration);
    const accepted = rows.filter(row => row.accepted).length;
    return { configuration, completed: rows.length, accepted, rejected: rows.length - accepted,
      historicalCorrect: rows.filter(row => row.historicalCorrect).length,
      semanticCorrect: rows.filter(row => row.semanticCorrect).length,
      historicalAccuracyAmongAccepted: accepted ? rows.filter(row => row.historicalCorrect).length / accepted : null,
      semanticAccuracyAmongAccepted: accepted ? rows.filter(row => row.semanticCorrect).length / accepted : null };
  });
}

/** Fetch injection supports offline verification; the CLI itself uses loopback HTTP. */
export async function runReplay(environment: Record<string, string | undefined>, fetcher: typeof fetch = fetch) {
  const config = settings(environment);
  const datasetBytes = readFileSync(config.dataset);
  const dataset = parseReplayDataset(JSON.parse(datasetBytes.toString('utf8')));
  if (config.ids?.some(id => !dataset.cases.some(row => row.id === id))) throw new Error('BOITE_JULIA_CASES: unknown case ID.');
  const selected = config.ids ? dataset.cases.filter(row => config.ids!.includes(row.id)) : dataset.cases;
  const jobs = config.modes.flatMap(mode => selectReplayCases(selected, mode).map(row => ({ mode, row, payload: prepareReplayRequest(row, mode, config.backend) })));
  if (!jobs.length) throw new Error('No cases match the selected modes and IDs.');
  mkdirSync(dirname(config.output), { recursive: true });
  // Exclusive leaf creation makes reuse fail even if another run raced the check.
  mkdirSync(config.output);
  const write = (name: string, value: unknown) => writeFileSync(join(config.output, name), JSON.stringify(value, null, 2) + '\n');
  const protocol: Record<string, unknown> = {
    schemaVersion: 1, startedAt: new Date().toISOString(), protocolSourceSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    datasetSha256: sha256(datasetBytes), datasetMetadata: dataset.metadata, datasetCaseCount: dataset.cases.length,
    selectedCaseIds: selected.map(row => row.id), configurations: config.modes, backend: config.backend, maxLength: 8192,
    casesPerConfiguration: config.modes.map(mode => ({ mode, count: selectReplayCases(selected, mode).length })),
    tokenConfigured: !!config.token, transport: 'HTTP loopback, redirects rejected, sequential single-row requests',
    inputHashDefinition: 'SHA-256 of the exact UTF-8 POST body, also saved without labels in input files.',
    projectionPolicies: {
      full: 'Complete supplied state unchanged, prefixed with the original task goal.',
      'target-state': 'Local actions retain the first three prefix lines, the first 500 following body characters and the entire candidate suffix. Fact and completion states stay unchanged.',
      'local-router': 'Local actions only. Retain the first two title/URL lines and append an explicit page body and DOM omission note.',
    },
    interpretation: 'Expert-curated observation replay with supplied local subgoals and candidates. Scores cover input preparation and selection, not autonomous browser completion or an independent holdout.',
  };
  write('protocol.json', protocol);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.token) headers.Authorization = 'Bearer ' + config.token;
  try {
    const response = await fetcher(new URL('/health', config.endpoint), { headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
    const body: unknown = await response.json();
    protocol.health = { httpStatus: response.status, response: body };
    write('protocol.json', protocol);
    if (!response.ok || !object(body) || body.ready !== true) throw new Error('Julia health: expected an HTTP success with ready=true.');
  } catch (error) {
    protocol.healthError = error instanceof Error ? error.message : String(error);
    write('protocol.json', protocol);
    throw error;
  }
  const results: ReplaySample[] = [];
  for (const [ordinal, job] of jobs.entries()) {
    const input = JSON.stringify(job.payload);
    const inputFile = `input-${String(ordinal + 1).padStart(4, '0')}.json`;
    writeFileSync(join(config.output, inputFile), input);
    const sample: ReplaySample = { configuration: job.mode, id: job.row.id, task: job.row.task.id, kind: job.row.kind,
      expected: job.row.expected, acceptableIndices: [...job.row.acceptableIndices], originalStateCharacters: job.row.state.length,
      preparedStateCharacters: job.payload.rows[0]!.state.length, inputFile, inputSha256: sha256(input),
      accepted: false, historicalCorrect: false, semanticCorrect: false, wallMs: 0 };
    const start = performance.now();
    try {
      const response = await fetcher(new URL('/predict', config.endpoint), { method: 'POST', headers, body: input,
        redirect: 'error', signal: AbortSignal.timeout(120000) });
      sample.httpStatus = response.status;
      const responseText = await response.text();
      try { sample.response = JSON.parse(responseText); }
      catch { sample.rawResponse = responseText; throw new Error('Julia response: expected valid JSON.'); }
      if (!response.ok) throw new Error(`Julia HTTP ${response.status}.`);
      const parsed = parseJuliaResult(sample.response, job.row.options.length);
      sample.predicted = parsed.index; sample.inputTokens = parsed.inputTokens; sample.serverMs = parsed.elapsedMs;
      sample.accepted = true;
      sample.historicalCorrect = parsed.index === job.row.expected;
      sample.semanticCorrect = job.row.acceptableIndices.includes(parsed.index);
    } catch (error) { sample.error = error instanceof Error ? error.message : String(error); }
    sample.wallMs = performance.now() - start;
    results.push(sample);
    write('results.json', results);
    write('summary.json', summaries(results, config.modes));
    console.log(JSON.stringify({ configuration: job.mode, completed: results.length, total: jobs.length, last: job.row.id,
      httpStatus: sample.httpStatus, accepted: sample.accepted, historicalCorrect: sample.historicalCorrect,
      semanticCorrect: sample.semanticCorrect, inputTokens: sample.inputTokens, wallMs: sample.wallMs }));
  }
  const summary = summaries(results, config.modes);
  protocol.completedAt = new Date().toISOString();
  write('protocol.json', protocol);
  console.log(`JULIA_REPLAY_COMPLETE CASES=${results.length} MODES=${config.modes.length} BACKEND=${config.backend}`);
  return { results, summary, protocol };
}

if (import.meta.main) {
  runReplay(process.env).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
