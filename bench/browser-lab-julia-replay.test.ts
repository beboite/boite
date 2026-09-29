import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseReplayDataset, prepareReplayRequest, projectReplayState, runReplay, selectReplayCases } from './browser-lab-julia-replay.ts';

const suffix = '\nCandidate control entries in original snapshot order:\nbutton first\nbutton LAST_CONTROL\nTabs:\nother tab\nCandidate links:\nhttps://example.org/LAST_LINK';
const action = {
  id: 'action', task: { id: 'workflow', goal: 'Find the observed target.' }, kind: 'local_action' as const,
  state: 'Title: observed\nURL: https://example.org/\nBody:\n' + 'x'.repeat(500) + 'OMITTED_BODY' + suffix,
  question: 'Which observed control opens the target?', options: ['First control', 'Second control'], expected: 0, acceptableIndices: [0, 1],
};
const fact = { ...action, id: 'fact', kind: 'fact_verification' as const, state: 'Title: observed\nURL: https://example.org/\n1 h\n4,4 km\n40 comments\n49,99\u00a0EUR', acceptableIndices: [0] };
const completion = { ...fact, id: 'completion', kind: 'completion_verification' as const };

describe('Julia replay inputs', () => {
  test('target-state removes only the action body tail and retains the complete candidate suffix', () => {
    const state = projectReplayState(action, 'target-state');
    expect(state.startsWith('Title: observed\nURL: https://example.org/\nBody:\n' + 'x'.repeat(500))).toBe(true);
    expect(state).not.toContain('OMITTED_BODY');
    expect(state.endsWith(suffix)).toBe(true);
    expect(state).toContain('Body prefix shortened to 500 characters; all supplied candidate control/link entries and tabs retained.');
    expect(projectReplayState(fact, 'target-state')).toBe(fact.state);
    expect(projectReplayState(completion, 'target-state')).toBe(completion.state);
    expect(projectReplayState(action, 'full')).toBe(action.state);
    expect(() => projectReplayState({ ...action, state: 'missing candidate suffix' }, 'target-state')).toThrow('candidate context marker');
  });

  test('local-router selects actions only and explicitly omits page content', () => {
    expect(selectReplayCases([action, fact, completion], 'local-router').map(row => row.id)).toEqual(['action']);
    const state = projectReplayState(action, 'local-router');
    expect(state).toBe('Title: observed\nURL: https://example.org/\nPage body and DOM inventory omitted in this explicit local-subgoal router ablation; options still come from observed controls.');
    expect(() => projectReplayState(fact, 'local-router')).toThrow('local_action');
  });

  test('labels and provenance cannot change the exact transmitted goal, question, state and options', () => {
    const original = prepareReplayRequest(fact, 'full', 'onnx');
    const relabeled = { ...fact, expected: 1, acceptableIndices: [1], provenance: { secret: 'NEVER_TRANSMIT' }, rationale: 'GOLD_HINT' };
    expect(prepareReplayRequest(relabeled, 'full', 'onnx')).toEqual(original);
    expect(Object.keys(original)).toEqual(['rows', 'backend', 'maxLength']);
    expect(Object.keys(original.rows[0]!)).toEqual(['state', 'question', 'options', 'type']);
    expect(original.rows[0]!.state).toBe('Task goal: ' + fact.task.goal + '\n' + fact.state);
    expect(original.rows[0]!.options).toEqual(fact.options);
    expect(JSON.stringify(original)).not.toMatch(/expected|acceptable|provenance|GOLD_HINT|NEVER_TRANSMIT/);
  });

  test('public source preserves 52 inputs and excludes 12 fact/completion cases from local-router', () => {
    const dataset = parseReplayDataset(JSON.parse(readFileSync(new URL('./results/2026-09-29-julia/natural-decision-cases.json', import.meta.url), 'utf8')));
    expect(dataset.cases).toHaveLength(52);
    expect(selectReplayCases(dataset.cases, 'local-router')).toHaveLength(40);
    for (const row of dataset.cases) {
      expect(prepareReplayRequest(row, 'full', 'torch').rows[0]!.state).toBe('Task goal: ' + row.task.goal + '\n' + row.state);
      if (row.kind !== 'local_action') expect(projectReplayState(row, 'target-state')).toBe(row.state);
      else expect(projectReplayState(row, 'target-state').endsWith(row.state.slice(row.state.indexOf('\nCandidate control entries in original snapshot order:')))).toBe(true);
    }
    expect(() => parseReplayDataset({ cases: [action, action] })).toThrow('duplicate');
    expect(() => parseReplayDataset({ cases: [{ ...action, acceptableIndices: [1] }] })).toThrow('expected');
  });
});

test('opt-in runner is sequential, records exact input hashes, scores both labels and rejects reused output before requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'julia-replay-test-'));
  try {
    const datasetPath = join(directory, 'dataset.json'), output = join(directory, 'results');
    writeFileSync(datasetPath, JSON.stringify({ metadata: { study: 'Test fixture' }, cases: [action, fact, completion] }));
    const environment = { BOITE_BENCH_JULIA: '1', BOITE_BENCH_OUTPUT: output, BOITE_JULIA_DATASET: datasetPath, BOITE_JULIA_BACKEND: 'onnx', BOITE_JULIA_REPLAY_MODES: 'full,target-state,local-router' };
    let calls = 0, active = 0, peak = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++; active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      if (String(input).endsWith('/health')) return Response.json({ ready: true, metadata: { model: 'fixture' } });
      const payload = JSON.parse(String(init?.body));
      expect(payload.backend).toBe('onnx');
      expect(JSON.stringify(payload)).not.toContain('acceptableIndices');
      if (payload.rows[0].state.includes('40 comments')) return Response.json({ error: 'fixture option contract' }, { status: 422 });
      return Response.json({ results: [{ index: 1, logits: [0, 1], probabilities: [0.25, 0.75], elapsedMs: 2, inputTokens: 10 }] });
    }) as typeof fetch;
    await expect(runReplay({ ...environment, BOITE_BENCH_JULIA: '0' }, fakeFetch)).rejects.toThrow('BOITE_BENCH_JULIA=1');
    await expect(runReplay({ ...environment, BOITE_JULIA_URL: 'https://example.org' }, fakeFetch)).rejects.toThrow('loopback');
    expect(calls).toBe(0);
    const result = await runReplay(environment, fakeFetch);
    expect(peak).toBe(1);
    expect(calls).toBe(8);
    expect(result.results).toHaveLength(7);
    expect(result.results.filter(row => row.accepted)).toHaveLength(3);
    expect(result.results.filter(row => row.historicalCorrect)).toHaveLength(0);
    expect(result.results.filter(row => row.semanticCorrect)).toHaveLength(3);
    for (const row of result.results) {
      const bytes = readFileSync(join(output, row.inputFile));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.inputSha256);
    }
    await expect(runReplay(environment, fakeFetch)).rejects.toThrow('fresh');
    expect(calls).toBe(8);
    const subset = await runReplay({ ...environment, BOITE_BENCH_OUTPUT: join(directory, 'subset'),
      BOITE_JULIA_REPLAY_MODES: 'full', BOITE_JULIA_CASES: 'completion,action' }, fakeFetch);
    expect(subset.results.map(row => row.id)).toEqual(['action', 'completion']);
    expect(calls).toBe(11);
    expect(peak).toBe(1);
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('julia-replay-test-')) throw new Error('Unexpected test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
