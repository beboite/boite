import type { GoalChecklist, GoalReview, Thread, ThreadStatus, Turn } from '@boite/contracts';
import type { FakeContext } from './context';

/**
 * The project board with work on it, on `?fake=1&board=1`: two cards in To
 * do, one whose `/goal2` works through its checklist, one under review, and
 * the seed's claimed and confirmed cards.
 */
export function seedBoardDemo(ctx: FakeContext): void {
  const at = ctx.now() - 20 * 60_000;
  const root = ctx.thread('t-trace');
  const checklist = (done: number, texts: string[]): GoalChecklist => ({
    threadId: null, phase: 'idle', model: 'claude/claude-opus-5-5', effort: 'medium', error: null,
    items: texts.map((text, index) => ({ id: index + 1, text, source: text, status: index < done ? 'done' : 'open' }))
  });
  const review = (phase: GoalReview['phase']): GoalReview => ({ phase, maxRounds: 5, reviewerThreadId: null, claimTurnId: null, delivered: 0, verdicts: [] });
  const make = (id: string, title: string, status: ThreadStatus, model: string, phase: GoalReview['phase'], list: GoalChecklist): Thread => {
    const turn: Turn = { id: `turn-${id}`, threadId: id, status: status === 'running' ? 'running' : 'done', queuedAt: at, startedAt: at, finishedAt: status === 'running' ? null : at + 600_000, usage: null, error: null };
    const thread: Thread = {
      ...root, id, parentThreadId: null, title, titleSource: 'user', status, model, unread: false, archived: false, pinned: false, branch: null,
      sessionId: `session-${id}`, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, background: [], backgroundHistory: [], memoryEvents: [],
      activity: { goal: { objective: title, status: 'active', iterations: 2, error: null, review: review(phase), checklist: list }, loop: null, tasks: [] },
      pullRequest: null, createdAt: at, updatedAt: at + 600_000, messagesBefore: null, commands: [], turns: [turn],
      messages: [{ id: `m-${id}-1`, threadId: id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: `/goal2 ${title}` }], state: 'complete', createdAt: at }]
    };
    delete thread.promptCache;
    ctx.threads.set(id, thread);
    return thread;
  };
  const dark = make('t-board-dark', 'Dark theme for the settings page', 'running', 'claude-opus-5-5', 'working',
    checklist(2, ['Dark theme colours', 'A switch in Settings', 'Follow the system theme', 'Desktop and phone captures', 'Tests for the setting']));
  const scroll = make('t-board-scroll', 'Phone chat scroll', 'idle', 'claude-opus-5-5', 'reviewing',
    checklist(4, ['Keep the reader in place', 'No jump on a new page', 'A test that fails before', 'A capture on a phone']));
  const card = (id: string, text: string, goalThreadId: string | null, offset: number) =>
    ({ id, projectId: 'p-boite', text, status: 'open' as const, threadId: null, goalThreadId, createdAt: at + offset, updatedAt: at + offset });
  ctx.todos.push(
    card('board-todo-1', 'Export invoices as CSV', null, 1_000),
    card('board-todo-2', 'Keyboard shortcut to open the panel', null, 2_000),
    card('board-todo-3', dark.title, dark.id, 3_000),
    card('board-todo-4', scroll.title, scroll.id, 4_000)
  );
}
