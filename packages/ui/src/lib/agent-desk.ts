import type { AgentWatch, Message, MessagePart, Thread } from '@boite/contracts';

/**
 * What the desk (the right panel's `desk` surface of a persistent agent's
 * thread) reads: how each thread on it stands, what the running turn has done
 * so far, and the day's spend against its budget.
 */

/** A desk card's state, the one its chip says: what the user most needs to know about that thread. */
export type DeskState = 'needs-you' | 'stalled' | 'failed' | 'working' | 'queued' | 'merged' | 'review' | 'done' | 'idle' | 'archived';

/**
 * The chip a desk card shows, first match wins: a question for the user, a
 * turn gone silent, a failure, then work under way, then where its pull
 * request stands, then how the thread rests.
 */
export function deskState(watch: Pick<AgentWatch, 'state' | 'stalledSince' | 'pullRequest'>): DeskState {
  if (watch.state === 'needs-you') return 'needs-you';
  if (watch.stalledSince !== null && (watch.state === 'working' || watch.state === 'queued')) return 'stalled';
  if (watch.state === 'failed') return 'failed';
  if (watch.state === 'working' || watch.state === 'queued') return watch.state;
  if (watch.pullRequest?.state === 'merged') return 'merged';
  if (watch.pullRequest && (watch.pullRequest.state === 'open' || watch.pullRequest.state === 'draft')) return 'review';
  return watch.state === 'archived' ? 'archived' : watch.state === 'done' ? 'done' : 'idle';
}

/**
 * The colour a state takes, from the app's status tokens: live for what waits
 * on someone, danger for what broke, success for what landed (a merged pull
 * request included), the accent only for work under way, as the thread
 * list's running mark.
 */
export function deskTone(state: DeskState): 'accent' | 'live' | 'danger' | 'success' | 'muted' {
  if (state === 'needs-you' || state === 'stalled' || state === 'review') return 'live';
  if (state === 'failed') return 'danger';
  if (state === 'working' || state === 'queued') return 'accent';
  if (state === 'done' || state === 'merged') return 'success';
  return 'muted';
}

/** Cards that need the user first, then the ones at work, then the rest by their last activity. */
export function deskOrder(watches: readonly AgentWatch[]): AgentWatch[] {
  const rank: Record<DeskState, number> = { 'needs-you': 0, stalled: 1, failed: 2, working: 3, queued: 3, review: 4, merged: 5, idle: 6, done: 7, archived: 8 };
  return [...watches].sort((a, b) => rank[deskState(a)] - rank[deskState(b)] || b.lastActivityAt - a.lastActivityAt);
}

export type ToolStep = Extract<MessagePart, { type: 'tool' }>;

/** The calls a turn made so far, oldest first: what the desk's Now lists live. */
export function turnSteps(messages: readonly Message[], turnId: string): ToolStep[] {
  const steps: ToolStep[] = [];
  for (const message of messages) {
    if (message.turnId !== turnId || message.role !== 'assistant') continue;
    for (const part of message.parts) if (part.type === 'tool') steps.push(part);
  }
  return steps;
}

/** The turn running on a thread, when one is. */
export function runningTurn(thread: Pick<Thread, 'turns'> | null | undefined) {
  return thread?.turns.findLast(turn => turn.status === 'running') ?? null;
}

/** How far the day's spend went into the budget, 0 to 1, and whether it reached it; null without a budget. */
export function budgetMeter(spent: number, budget: number | null | undefined): { ratio: number; reached: boolean } | null {
  if (budget === null || budget === undefined || !(budget > 0)) return null;
  return { ratio: Math.min(1, Math.max(0, spent / budget)), reached: spent >= budget };
}

/** Dollars the way a meter reads them: two decimals, cents under a dollar kept. */
export function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}
