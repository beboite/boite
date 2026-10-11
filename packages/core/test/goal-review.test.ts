import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ThreadActivity } from '@boite/contracts';
import { ActivityStore } from '../src/activity.ts';
import { parseVerdict } from '../src/activity-prompt.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

const isReview = (ctx: TurnContext) => ctx.prompt.includes('You review a Boite goal');

/** An echo agent that answers with `answer(ctx)` and finishes at once. */
function agent(answer: (ctx: TurnContext) => string): () => void {
  return setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: answer(ctx) });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
}

test.each([
  ['plain', 'All good.\nVERDICT: PASS', 'pass', 'All good.'],
  ['bold markdown', '- Missing test\n**VERDICT: PARTIAL**', 'partial', '- Missing test'],
  ['last line wins', 'VERDICT: PASS was my first guess.\n- The build fails\nVERDICT: FAIL', 'fail', 'VERDICT: PASS was my first guess.\n- The build fails'],
  ['no verdict', 'I looked around.', 'missing', 'The reviewer ended without a VERDICT line.\nI looked around.'],
] as const)('verdict: %s', (_name, text, verdict, summary) => {
  expect(parseVerdict(text)).toEqual({ verdict, summary });
});

test('a reviewed goal sends its claim to a fresh reviewer and works on the findings until a pass', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const coder: string[] = [];
  const reviews: { threadId: string; prompt: string }[] = [];
  restore = agent(ctx => {
    if (!isReview(ctx)) {
      coder.push(ctx.prompt);
      return `Changed parser.ts in round ${coder.length} and ran bun test.\n[BOITE_GOAL_COMPLETE]`;
    }
    reviews.push({ threadId: ctx.thread.id, prompt: ctx.prompt });
    return reviews.length === 1 ? '- The parser test fails: expected 2, got 3\nVERDICT: FAIL' : 'Checks pass.\nVERDICT: PASS';
  });
  // Subagents are off: a reviewer, like a workflow step, does not need them.
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Fix the parser', review: true } });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');

  const review = h.core.activity.get(threadId).goal!.review!;
  expect(review.verdicts.map(v => [v.round, v.verdict, v.summary])).toEqual([[1, 'fail', '- The parser test fails: expected 2, got 3'], [2, 'pass', 'Checks pass.']]);
  expect(review).toMatchObject({ phase: 'working', reviewerThreadId: null, delivered: 1 });
  // Each round is a new conversation, a child of the goal's thread, holding the claim it judges.
  expect(reviews.map(r => r.threadId)).toEqual(review.verdicts.map(v => v.threadId));
  expect(new Set(reviews.map(r => r.threadId)).size).toBe(2);
  for (const r of reviews) expect(h.core.threads.get(r.threadId).parentThreadId).toBe(threadId);
  expect(reviews[0]!.prompt).toContain('Changed parser.ts in round 1');
  expect(reviews[1]!.prompt).toContain('Changed parser.ts in round 2');
  expect(reviews.every(r => h.core.activity.ownsReviewer(r.threadId))).toBe(true);
  // Only the turn after the failed review carries its findings.
  expect(coder).toHaveLength(2);
  expect(coder[0]).not.toContain('did not pass');
  expect(coder[1]).toContain('Review 1 did not pass');
  expect(coder[1]).toContain('expected 2, got 3');
  // A reviewer's answer goes to the goal, never to the parent as mail.
  expect((h.core.journal.db.query('SELECT count(*) AS n FROM delegation_messages').get() as { n: number }).n).toBe(0);
  const thread = await client.call('threads.get', { threadId });
  const prompts = thread.messages.filter(m => m.role === 'user').map(m => m.parts[0]);
  expect(prompts).toEqual([
    { type: 'text', text: '/goal2 Fix the parser', activity: { kind: 'goal', iteration: 1 } },
    { type: 'text', text: '/goal2 Fix the parser', activity: { kind: 'goal', iteration: 2, review: { round: 1, feedback: '- The parser test fails: expected 2, got 3' } } },
  ]);
});

test('a reviewed goal stops for the user after five failed reviews, and each reply allows one more', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let reviews = 0;
  let passNext = false;
  restore = agent(ctx => {
    if (!isReview(ctx)) return ctx.prompt === 'Try the other parser' ? 'Switching.' : 'Done.\n[BOITE_GOAL_COMPLETE]';
    reviews++;
    return passNext ? 'Fixed.\nVERDICT: PASS' : `- Still broken (${reviews})\nVERDICT: PARTIAL`;
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Fix it', review: true } });
  await waitFor(() => h.core.activity.get(threadId).goal?.blocked === true);
  const goal = h.core.activity.get(threadId).goal!;
  expect(reviews).toBe(5);
  expect(goal).toMatchObject({ status: 'paused', blocked: true, error: '5 reviews did not pass. Reply to steer the agent; the goal resumes after your reply.' });
  expect(goal.review!.delivered).toBe(4);
  await Bun.sleep(300);
  expect(reviews).toBe(5);

  passNext = true;
  h.core.threads.startTurn(threadId, 'Try the other parser');
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(reviews).toBe(6);
  expect(h.core.activity.get(threadId).goal!.review!.verdicts.map(v => v.verdict)).toEqual(['partial', 'partial', 'partial', 'partial', 'partial', 'pass']);
  const last = (await client.call('threads.get', { threadId })).messages.filter(m => m.role === 'user').at(-1)!.parts[0];
  expect(last).toMatchObject({ activity: { review: { round: 5, feedback: '- Still broken (5)' } } });
});

test('pausing a reviewed goal stops its reviewer, and resuming starts a fresh review', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const reviewers: string[] = [];
  const stopped: string[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      if (!isReview(ctx)) {
        ctx.emit.part(id, 0, { type: 'text', text: 'Done.\n[BOITE_GOAL_COMPLETE]' });
        ctx.emit.complete(id, 'complete');
        return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
      }
      reviewers.push(ctx.thread.id);
      if (reviewers.length > 1) {
        ctx.emit.part(id, 0, { type: 'text', text: 'VERDICT: PASS' });
        ctx.emit.complete(id, 'complete');
        return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
      }
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      return { stop() { stopped.push(ctx.thread.id); finish(); }, done: done.then(() => ({ status: 'stopped' as const, sessionId: null, usage: null })) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Ship it', review: true } });
  await waitFor(() => reviewers.length === 1 && h.core.threads.get(reviewers[0]!).status === 'running');
  expect(h.core.activity.get(threadId).goal!.review).toMatchObject({ phase: 'reviewing', reviewerThreadId: reviewers[0] });

  await client.call('threads.activity.control', { threadId, kind: 'goal', action: 'pause' });
  await waitFor(() => h.core.activity.get(threadId).goal!.review!.reviewerThreadId === null);
  // A child's stop goes through delegation, which can reach the driver twice.
  expect(new Set(stopped)).toEqual(new Set([reviewers[0]!]));
  expect(h.core.activity.get(threadId).goal).toMatchObject({ status: 'paused', review: { phase: 'reviewing', verdicts: [] } });

  await client.call('threads.activity.control', { threadId, kind: 'goal', action: 'resume' });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(reviewers).toHaveLength(2);
  expect(reviewers[1]).not.toBe(reviewers[0]);
  expect(h.core.activity.get(threadId).goal!.review!.verdicts.map(v => [v.round, v.threadId])).toEqual([[1, reviewers[1]!]]);
});

test('a restarted core keeps its reviewers and drops the interrupted review', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const saved: ThreadActivity = { tasks: [], loop: null, goal: { objective: 'Ship it', status: 'active', iterations: 1, error: null, review: {
    phase: 'reviewing', maxRounds: 5, reviewerThreadId: 'thr_interrupted', claimTurnId: null, delivered: 0,
    verdicts: [{ round: 1, verdict: 'fail', summary: '- x', threadId: 'thr_earlier', finishedAt: 1 }],
  } } };
  h.core.journal.setSetting(`activity:${threadId}`, saved);
  const loaded = new ActivityStore(h.core);
  try {
    expect(loaded.get(threadId).goal).toMatchObject({ status: 'paused', error: 'Core restarted. Resume to continue.', review: { phase: 'reviewing', reviewerThreadId: null } });
    expect(loaded.ownsReviewer('thr_interrupted')).toBe(true);
    expect(loaded.ownsReviewer('thr_earlier')).toBe(true);
  } finally { loaded.close(); }
});

test('a reviewed goal refuses a review flag that is not a boolean', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await expect(client.call('threads.activity.set', { threadId, goal: { objective: 'x', review: 'yes' as unknown as boolean } })).rejects.toThrow('goal.review must be a boolean');
});
