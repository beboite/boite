import { expect, test } from 'bun:test';
import { validateReview, verifyLabSources, combineLabReports, labTokenUsage, type LabReview } from './browser-lab-report.ts';

const raw = { observations: [{ id: 1 }, { id: 2 }], model: { turn: { status: 'completed' } }, finished: true, processesAfter: 0 };
const review = (): LabReview => ({ criteria: Array.from({ length: 3 }, () => ({ met: true, observations: [1], note: 'Page and controls satisfy the requirement.' })), capturesViewed: [1], category: 'complete' });
test('self-reported finish cannot replace independent evidence or clean completion', () => {
  expect(validateReview(review(), raw)).toBe(true);
  expect(validateReview(review(), { ...raw, model: { ...raw.model, timedOut: true } })).toBe(false);
  expect(validateReview(review(), { ...raw, processesAfter: 1 })).toBe(false);
  expect(validateReview(review(), { ...raw, cancelled: 'stop' })).toBe(false);
  expect(validateReview(review(), { ...raw, cleanupError: 'failed' })).toBe(false);
  expect(validateReview({ ...review(), excluded: { cohort: 'all affected task arms', reason: 'Instrumented transport rejected a valid large response.' } }, raw)).toBe(false);
  expect(validateReview(review(), { ...raw, model: { ...raw.model, events: [{ method: 'item/started', params: { item: { type: 'commandExecution' } } }] } })).toBe(false);
  const noEvidence = review(); noEvidence.criteria[0]!.observations = [];
  expect(() => validateReview(noEvidence, raw)).toThrow('needs observation');
  const badEvidence = review(); badEvidence.criteria[0]!.observations = [3];
  expect(() => validateReview(badEvidence, raw)).toThrow('missing observation');
  const noCapture = review(); noCapture.capturesViewed = [];
  expect(() => validateReview(noCapture, raw)).toThrow('viewed captures');
  const falsePass = review(); falsePass.criteria[0]!.met = false;
  expect(() => validateReview(falsePass, raw)).toThrow('contradicts');
});
test('empty or partial source manifests cannot bypass frozen-source validation', () => {
  expect(() => verifyLabSources('.', undefined as any)).toThrow('Missing source hash');
  expect(() => verifyLabSources('.', {})).toThrow('Missing source hash');
  expect(() => verifyLabSources('.', { 'browser-lab.ts': 'a'.repeat(64) })).toThrow('browser-lab-page.ts');
});
test('fresh decision threads sum their own final cumulative totals without double counting updates', () => {
  const event = (totalTokens: number) => ({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens }, last: { totalTokens } } } });
  expect(labTokenUsage({ calls: [{ events: [event(100), event(250)] }, { events: [event(80)] }] }).finalTotal.totalTokens).toBe(330);
  expect(labTokenUsage({ events: [event(100), event(250)] }).finalTotal.totalTokens).toBe(250);
});
test('combining lanes preserves failed attempts and rejects mixed or duplicate protocols', () => {
  const lane = (task: string, campaignLane: string): any => ({ campaign: '2026-09-24', expected: 2, reviewed: 2, pending: [], complete: true,
    protocol: { tasks: [{ id: task }], modes: ['dom'], repetitions: 2, campaignLane, timeoutMs: 180000 },
    cleanup: { browserZero: 2, modelGroupsZero: true }, attempts: [
      { task, mode: 'dom', verified: true, category: 'complete', timing: { totalMs: 1000 } },
      { task, mode: 'dom', verified: false, category: 'budget', timing: { totalMs: 180000 } },
    ] });
  const a = lane('first', 'a'), b = lane('second', 'b');
  const report = combineLabReports([a, b]);
  expect(report.expected).toBe(4);
  expect(report.modes.dom.succeeded).toBe(2);
  expect(report.modes.dom.allTiming.n).toBe(4);
  expect(report.modes.dom.allTiming.medianMs).toBe(90500);
  b.attempts[0].excluded = { cohort: 'whole affected task', reason: 'Invalid setup.' };
  b.attempts[1].excluded = { cohort: 'whole affected task', reason: 'Invalid setup.' };
  const corrected = combineLabReports([a, b]);
  expect(corrected.modes.dom).toMatchObject({ expected: 4, reviewed: 4, scored: 2, excluded: 2, succeeded: 1 });
  expect(corrected.modes.dom.allTiming.n).toBe(2);
  expect(corrected.attempts).toHaveLength(4);
  expect(() => combineLabReports([a, a])).toThrow('Duplicate lane');
  b.protocol.timeoutMs = 360000;
  expect(() => combineLabReports([a, b])).toThrow('protocols differ');
});
test('public review notes refuse private paths and credential-like strings', () => {
  const publicUrl = review(); publicUrl.criteria[0]!.note = 'Observed NASA page https://www.nasa.gov/history/alsj-and-afj/.';
  expect(validateReview(publicUrl, raw)).toBe(true);
  const privatePath = review(); privatePath.criteria[0]!.note = 'Read C:/Users/example/profile';
  expect(() => validateReview(privatePath, raw)).toThrow('Private path');
  const credential = review(); credential.criteria[0]!.note = 'token=not-a-real-secret';
  expect(() => validateReview(credential, raw)).toThrow('credential');
});
