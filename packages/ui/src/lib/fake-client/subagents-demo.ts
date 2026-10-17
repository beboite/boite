import type { Message, PermissionRequest, Thread, ThreadStatus, Turn } from '@boite/contracts';
import type { FakeContext } from './context';
import { askAsync, settlePermission } from './requests';

/**
 * `?fake=1&subagents=1`: two parents at work in the first project. One has two
 * sub-agents at work, the chip its row carries; the other has one sub-agent
 * asking a question without stopping and one stopped on a permission, so the
 * parent reads Needs you and its dock carries both. A page reads them from
 * `questions.list` and `permissions.list`, and what a child asks later goes
 * out as `question.asked` or `permission.requested` to every connection, the
 * parent's subscribers included, as the core sends a child's.
 */
export function seedSubagentsDemo(ctx: FakeContext): void {
  const at = Date.now() - 4 * 60_000;
  const root = ctx.thread('t-trace');
  const make = (id: string, title: string, task: string, status: ThreadStatus, parentThreadId: string | null, startedAt: number): Thread => {
    const turn: Turn = { id: `turn-${id}`, threadId: id, status: 'running', queuedAt: startedAt, startedAt, finishedAt: null, usage: null, error: null };
    const thread: Thread = {
      ...root, id, parentThreadId, title, titleSource: 'user', status, unread: false, archived: false, pinned: false, branch: null,
      sessionId: `session-${id}`, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, activity: undefined, background: [], backgroundHistory: [], memoryEvents: [],
      pullRequest: null, createdAt: startedAt, updatedAt: startedAt + 30_000, messagesBefore: null, commands: [], turns: [turn],
      messages: [
        { id: `m-${id}-1`, threadId: id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: task }], state: 'complete', createdAt: startedAt },
        { id: `m-${id}-2`, threadId: id, turnId: turn.id, role: 'assistant', parts: [{ type: 'text', text: 'On it.' }], state: 'streaming', createdAt: startedAt + 5_000 }
      ]
    };
    delete thread.promptCache;
    ctx.threads.set(id, thread);
    return thread;
  };

  const working = make('t-subagents-work', 'Split the store into parts', 'Split the store and hand the parts to sub-agents.', 'running', null, at);
  make('t-subagents-work-1', 'Move the requests part', 'Move the permission and question cards into their own part.', 'running', working.id, at + 20_000);
  make('t-subagents-work-2', 'Move the threads part', 'Move the thread rows and their reads into their own part.', 'running', working.id, at + 25_000);

  const asking = make('t-subagents-ask', 'Migrate the settings page', 'Migrate the settings page to the new cards, one sub-agent per section.', 'running', null, at + 40_000);
  const asker = make('t-subagents-ask-1', 'Migrate the storage keys', 'Move the stored settings to their new keys.', 'running', asking.id, at + 60_000);
  askAsync(ctx, asker, asker.turns[0]!, asker.messages[1]!, 'Which key should the migrated settings live under?', ['boite.settings.v2', 'Keep boite.settings'], false);
  const blocked = make('t-subagents-ask-2', 'Run the migration', 'Run the migration script and report what moved.', 'waiting', asking.id, at + 70_000);
  const message: Message = blocked.messages[1]!;
  const request: PermissionRequest = {
    id: 'req-subagents-1', threadId: blocked.id, turnId: blocked.turns[0]!.id, toolName: 'Bash',
    input: { command: 'bun run scripts/migrate-settings.ts', description: 'Run the settings migration' },
    description: 'Run the settings migration', createdAt: at + 80_000
  };
  message.parts.push({ type: 'permission', requestId: request.id, toolName: request.toolName, decision: null });
  ctx.pendingPermissions.set(request.id, {
    request,
    resolve: (decision) => {
      settlePermission(ctx, blocked, message, message.parts.length - 1, request, decision);
      blocked.status = 'running';
      ctx.touch(blocked);
    }
  });
}
