import type { Thread, ThreadSummary } from '@boite/contracts';
import { RETITLE_DELAY_MS } from './providers';
import { refusal, toSummary } from './shared';
import type { FakeContext } from './context';

/** The offline echo writer has no ambiguous-subject decision, so its initial title needs no refinement. */
export async function writeTitle(ctx: FakeContext, thread: Thread, automatic = false): Promise<ThreadSummary> {
  const first = thread.messages.find(message => message.role === 'user');
  if (first === undefined) throw refusal('this thread has no prompt to write a title from', { threadId: thread.id });
  if (ctx.retitling.has(thread.id)) throw refusal('a title is already being written for this thread', { threadId: thread.id });
  const version = thread.titleState?.version ?? 0;
  const title = thread.title;
  const source = thread.titleSource;
  const generation = thread.sessionGeneration ?? 0;
  ctx.retitling.add(thread.id);
  try {
    await new Promise<void>(resolve => setTimeout(resolve, RETITLE_DELAY_MS));
    const current = ctx.threads.get(thread.id);
    if (current !== thread || (automatic && thread.archived) || thread.title !== title || thread.titleSource !== source ||
      (thread.titleState?.version ?? 0) !== version || (thread.sessionGeneration ?? 0) !== generation) return toSummary(current ?? thread);
    const prompt = first.parts.map(part => part.type === 'text' ? part.text : '').join('');
    const words = prompt.replace(/\[(?:sleep:\d+|tool-stream|tool|diff|doc|image|permission(?::\d+)?|question|think|compact|spawn:[^\]]*|error)\]|\bquestion\b/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      thread.title = `Echo: ${words.slice(0, 5).join(' ')}`;
      thread.titleSource = 'agent';
    } else if (!automatic && prompt.trim()) {
      thread.title = prompt.trim().split('\n')[0]!.slice(0, 60);
      thread.titleSource = 'prompt';
    }
    thread.titleState = { version: version + 1, needsRefinement: false };
    return ctx.touch(thread);
  } finally {
    ctx.retitling.delete(thread.id);
  }
}

export function autoTitle(ctx: FakeContext, thread: Thread): void {
  if (thread.titleSource !== 'prompt' || thread.titleState !== undefined) return;
  if (thread.turns.filter(turn => !turn.execution?.operation).length !== 1) return;
  thread.titleState = { version: 1, needsRefinement: true };
  void writeTitle(ctx, thread, true).catch(() => undefined);
}
