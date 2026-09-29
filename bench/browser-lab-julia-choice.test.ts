import { expect, test } from 'bun:test';
import { assessInitialNavigation, compactJuliaState, counterbalancedModes, parseCandidateDecision, parseJuliaResult, permuteCandidateDecision, prepareJuliaChoice, rememberObservedUrls, validateChoiceIndex } from './browser-lab-julia-choice.ts';

const observation = { snapshot: '- textbox "Search" [ref=e1]\n- link "History" [ref=e2]\n  - /url: https://example.com/history',
  pageText: 'Search\nHistory', links: [{ text: 'History', url: 'https://example.com/history' }],
  tabs: { tabs: [{ tabId: 'tab-one', url: 'https://example.com/' }] }, remainingSeconds: 150 };
const draft = () => ({ subgoal: 'Find the history page', memory: 'Observed History link', preferredIndex: 1,
  candidates: [
    { description: 'Fill the observed search field', command: { action: 'fill', selector: '@e1', value: 'history' } },
    { description: 'Click the History link', command: { action: 'click', selector: '@e2' } },
    { description: 'Open observed History URL in a separate tab', command: { action: 'tab_new', url: 'https://example.com/history' } },
    { description: 'Scroll to view more current-page content', command: { action: 'scroll', direction: 'down', amount: 400 } },
  ] });
const parse = (value: unknown, image = true) => parseCandidateDecision(JSON.stringify(value), observation, image);

test('current ref aliases normalize before grounding and duplicate comparison', () => {
  for (const selector of ['e1', '@e1', 'ref=e1', '[ref=e1]']) {
    const value = draft(); value.candidates[0]!.command.selector = selector;
    expect(parse(value).candidates[0]!.command.selector).toBe('@e1');
  }
  const framed = { ...observation, snapshot: '- textbox [ref=f2e1]\n- link [ref=e2]' };
  for (const selector of ['f2e1', '@f2e1', 'ref=f2e1', '[ref=f2e1]']) {
    const value = draft(); value.candidates[0]!.command.selector = selector;
    expect(parseCandidateDecision(JSON.stringify(value), framed, true).candidates[0]!.command.selector).toBe('@f2e1');
  }
  for (const selector of ['e99', 'ref=e99', '[ref=e99]', '#e1', 'e1garbage']) {
    const value = draft(); value.candidates[0]!.command.selector = selector;
    expect(() => parse(value)).toThrow('current observation');
  }
  const duplicate = draft(); duplicate.candidates[1]!.command = { action: 'fill', selector: 'ref=e1', value: 'history' } as any;
  expect(() => parse(duplicate)).toThrow('duplicate');
});

test('previously delivered exact URLs stay usable without granting old refs or other task domains', () => {
  const value = draft();
  value.candidates[2]!.command = { action: 'open', url: 'https://example.com/earlier' } as any;
  const knownUrls = new Set(['https://example.com/earlier']);
  expect(parseCandidateDecision(JSON.stringify(value), observation, true, ['example.com'], knownUrls).candidates[2]!.command.url)
    .toBe('https://example.com/earlier');
  expect(() => parseCandidateDecision(JSON.stringify(value), observation, true, ['example.com'])).toThrow('observed URL');
  expect(() => parseCandidateDecision(JSON.stringify(value), observation, true, ['other.example'], knownUrls)).toThrow('task domains');
  value.candidates[2]!.command.url = 'https://example.com/earlier/';
  expect(() => parseCandidateDecision(JSON.stringify(value), observation, true, ['example.com'], knownUrls)).toThrow('observed URL');
  value.candidates[2]!.command.url = 'https://example.com/earlier';
  value.candidates[0]!.command.selector = '@e99';
  expect(() => parseCandidateDecision(JSON.stringify(value), observation, true, ['example.com'], knownUrls)).toThrow('current observation');
});

test('URL memory records only delivered page, link, tab and snapshot URLs', () => {
  const urls = new Set(['https://example.com/already']);
  const delivered = { ...observation, url: 'https://example.com/current', snapshot: observation.snapshot + '\n  - /url: https://example.com/snapshot-only',
    rawHistory: [{ state: { links: [{ url: 'https://example.com/hidden-history' }] } }],
    state: { links: [{ url: 'https://example.com/hidden-state' }] } };
  expect(rememberObservedUrls(delivered, urls)).toBe(urls);
  expect([...urls].sort()).toEqual(['https://example.com/', 'https://example.com/already', 'https://example.com/current',
    'https://example.com/history', 'https://example.com/snapshot-only'].sort());
  const freshEmpty = { url: 'https://example.com/new', snapshot: '(empty page)', links: [], tabs: { tabs: [] } };
  rememberObservedUrls(freshEmpty, urls);
  expect(urls.has('https://example.com/history')).toBe(true);
  expect(urls.has('https://example.com/new')).toBe(true);
});

test('planner candidates retain grounded actions and preferred index without choosing a fallback', () => {
  expect(parse(draft())).toEqual(draft());
  expect(parseCandidateDecision('```json\n' + JSON.stringify(draft()) + '\n```', observation, true)).toEqual(draft());
  const invalid = draft(); invalid.candidates[1]!.command = { action: 'click', selector: '@e99' } as any;
  expect(() => parse(invalid)).toThrow('current observation');
  invalid.candidates[1]!.command = { action: 'open', url: 'https://example.com/invented' } as any;
  expect(() => parse(invalid)).toThrow('observed URL');
  invalid.candidates[1]!.command = { action: 'tab_switch', tabId: 'invented' } as any;
  expect(() => parse(invalid)).toThrow('current tab ID');
  expect(() => parseCandidateDecision(JSON.stringify(draft()), observation, true, ['other.example'])).toThrow('task domains');
});

test('candidate count, memory, subgoal, index and command schema fail closed', () => {
  for (const preferredIndex of [-1, 4, 1.5, '1', undefined]) expect(() => parse({ ...draft(), preferredIndex })).toThrow('preferredIndex');
  expect(() => parse({ ...draft(), candidates: draft().candidates.slice(0, 1) })).toThrow('2 to 12');
  expect(parse({ ...draft(), candidates: draft().candidates.slice(0, 2), preferredIndex: 0 }).candidates).toHaveLength(2);
  expect(() => parse({ ...draft(), candidates: Array.from({ length: 13 }, () => draft().candidates[0]) })).toThrow('2 to 12');
  expect(() => parse({ ...draft(), memory: 'x'.repeat(6001) })).toThrow('6000');
  expect(() => parse({ ...draft(), subgoal: 'x'.repeat(1501) })).toThrow('1500');
  const longDescription = draft(); longDescription.candidates[0]!.description = 'x'.repeat(141);
  expect(() => parse(longDescription)).toThrow('140');
  expect(parse({ ...draft(), memory: 'x'.repeat(6000) }).memory.length).toBe(6000);
  const invalid = draft(); invalid.candidates[1]!.command = { action: 'click', selector: '@e2', code: 'arbitrary' } as any;
  expect(() => parse(invalid)).toThrow('unexpected field');
  invalid.candidates[1] = invalid.candidates[0]!;
  expect(() => parse(invalid)).toThrow('duplicate');
  expect(() => parseCandidateDecision('The best option is 2', observation, true)).toThrow();
});

test('coordinate candidates require a current screenshot and finite viewport positions', () => {
  const value = draft(); value.candidates[1]!.command = { action: 'click_xy', x: 123, y: 456 } as any;
  expect(parse(value).candidates[1]!.command.action).toBe('click_xy');
  expect(() => parse(value, false)).toThrow('current screenshot');
  for (const x of [-1, 1280, null]) {
    (value.candidates[1]!.command as any).x = x;
    expect(() => parse(value)).toThrow('1280x800');
  }
});

test('Julia payload contains only allowed fields and never leaks preferredIndex or commands', () => {
  const decision = parse(draft());
  const prepared = prepareJuliaChoice('Find history', observation, decision);
  expect(Object.keys(prepared.payload)).toEqual(['rows', 'maxLength']);
  expect(Object.keys(prepared.payload.rows[0]!)).toEqual(['state', 'question', 'options', 'type']);
  expect(prepared.payload.rows[0]!.question).toStartWith(decision.subgoal + '\n');
  expect(JSON.parse(prepared.payload.rows[0]!.state)).toEqual({ taskGoal: 'Find history', subgoal: decision.subgoal, memory: decision.memory, observation: compactJuliaState(observation, decision) });
  const serialized = JSON.stringify(prepared.payload);
  expect(serialized).not.toContain('preferredIndex');
  expect(serialized).not.toContain('"command"');
  const differentPreference = prepareJuliaChoice('Find history', observation, { ...decision, preferredIndex: 3 });
  expect(differentPreference.payload).toEqual(prepared.payload);
  expect(prepared.lengths.state).toBe(prepared.payload.rows[0]!.state.length);
  expect(prepared.lengths.options).toEqual(decision.candidates.map(candidate => candidate.description.length));
});

test('Julia state scopes long observations with explicit omission counts and preserves candidate targets', () => {
  const long = { ...observation, pageText: 'a'.repeat(50000) };
  const prepared = prepareJuliaChoice('Find history', long, parse(draft()));
  const state = JSON.parse(prepared.payload.rows[0]!.state).observation;
  expect(state.pageText.length).toBe(1600);
  expect(state.omissions.pageTextOmittedCharacters).toBe(48400);
  expect(state.snapshot).toContain('[ref=e2]');
  expect(state.snapshot).toContain('https://example.com/history');
  expect(prepared.lengths.observation).toBe(JSON.stringify(long).length);
  expect(long.pageText.length).toBe(50000);
  expect(() => prepareJuliaChoice('Find history', { ...observation, snapshot: '- link [ref=e2] ' + 'x'.repeat(7000) }, parse(draft()))).toThrow('overflow');
});

test('Julia response requires a valid index and complete finite inference evidence', () => {
  const result = { index: 2, probabilities: [0.1, 0.2, 0.5, 0.2], logits: [1, 2, 4, 2], elapsedMs: 12.5, inputTokens: 100 };
  expect(parseJuliaResult({ results: [result] }, 4)).toEqual(result);
  for (const index of [-1, 4, 0.5, '2', undefined]) {
    expect(() => parseJuliaResult({ results: [{ ...result, index }] }, 4)).toThrow('index');
    expect(() => validateChoiceIndex(index, 4)).toThrow();
  }
  expect(() => parseJuliaResult({ results: [{ ...result, inputTokens: 8193 }] }, 4)).toThrow('overflow');
  expect(() => parseJuliaResult({ results: [{ ...result, probabilities: [0.5] }] }, 4)).toThrow('probabilities');
  expect(() => parseJuliaResult({ results: [{ ...result, logits: [1, 2, NaN, 4] }] }, 4)).toThrow('logits');
  expect(() => parseJuliaResult({ results: [] }, 4)).toThrow('one result');
});

test('candidate permutation is reproducible and preserves the preferred command without mutating input', () => {
  const decision = parse(draft()), original = structuredClone(decision);
  const first = permuteCandidateDecision(decision, 'history-task:1');
  expect(permuteCandidateDecision(decision, 'history-task:1')).toEqual(first);
  expect(first.originalIndices.slice().sort()).toEqual([0, 1, 2, 3]);
  expect(first.decision.candidates[first.decision.preferredIndex]).toEqual(decision.candidates[decision.preferredIndex]);
  for (const [index, originalIndex] of first.originalIndices.entries()) expect(first.decision.candidates[index]).toEqual(decision.candidates[originalIndex]!);
  expect(decision).toEqual(original);
});

test('permutation and Julia input remain independent of preferredIndex and distribute its position across steps', () => {
  const decision = parse(draft());
  const positions = new Set<number>();
  for (let step = 1; step <= 64; step++) {
    const seed = `history-task:${step}`;
    const first = permuteCandidateDecision(decision, seed);
    const changedPreference = permuteCandidateDecision({ ...decision, preferredIndex: 3 }, seed);
    expect(changedPreference.originalIndices).toEqual(first.originalIndices);
    expect(prepareJuliaChoice('Find history', observation, changedPreference.decision).payload)
      .toEqual(prepareJuliaChoice('Find history', observation, first.decision).payload);
    positions.add(first.decision.preferredIndex);
  }
  expect([...positions].sort()).toEqual([0, 1, 2, 3]);
});

test('arm order alternates by frozen task offset and preserves configured modes', () => {
  const modes = ['candidate-model', 'candidate-julia'];
  expect(counterbalancedModes(modes, 0)).toEqual(modes);
  expect(counterbalancedModes(modes, 1)).toEqual(['candidate-julia', 'candidate-model']);
  expect(counterbalancedModes(modes, 2)).toEqual(modes);
  expect(counterbalancedModes(['candidate-julia'], 3)).toEqual(['candidate-julia']);
  expect(modes).toEqual(['candidate-model', 'candidate-julia']);
});

test('initial navigation recovery requires exact requested URL and usable document evidence', () => {
  const requested = 'https://example.com/task';
  const state = { url: requested, readyState: 'complete', title: 'Public task page', bodyText: 'Visible content '.repeat(10) };
  expect(assessInitialNavigation(requested, state)).toEqual({ accepted: true, reasons: [] });
  expect(assessInitialNavigation(requested, { ...state, readyState: 'interactive' }).accepted).toBe(true);
  for (const invalid of [undefined, { ...state, url: requested + '/' }, { ...state, readyState: 'loading' },
    { ...state, bodyText: 'x'.repeat(50) }, { ...state, bodyText: ' '.repeat(100) }, { ...state, title: "This site can't be reached" },
    { ...state, title: 'ERR_CONNECTION_REFUSED' }, { ...state, title: 'Privacy error' }]) {
    const result = assessInitialNavigation(requested, invalid);
    expect(result.accepted).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  }
});
