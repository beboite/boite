/** What a parent and the `boite delegate` rows read about a child: its open cards, how to answer them and where its worktree is. */
import { delegationAnswer, delegationAnswerForm, type DelegationInput, type DelegationWorktree, type PermissionRequest, type QuestionAnswer, type QuestionRequest, type ThreadSummary } from '@boite/contracts';
import { refused } from '../errors.ts';

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** The message that wakes a parent when its child asks something. */
export function questionWake(child: ThreadSummary, question: QuestionRequest): string {
  const options = question.options.length ? `\nOptions: ${question.options.map(o => JSON.stringify(o.label)).join(' | ')}` : '';
  return [
    `${child.title} (${child.id}) asks: ${clip(question.text, 2500)}${clip(options, 800)}`,
    question.async === true ? 'It keeps working meanwhile.' : 'It is blocked until it gets an answer.',
    `Your next boite delegate send ${child.id} "<answer>" answers it (${delegationAnswerForm(question)}). Answer from the task and the user's instructions; ask the user when they do not settle it.`,
  ].join('\n');
}

/** The message that tells a parent its child waits on the user's approval, which it cannot give. */
export function permissionWake(child: ThreadSummary, request: PermissionRequest): string {
  return [
    `${child.title} (${child.id}) waits for the user's approval to use ${request.toolName}${request.description ? `: ${clip(request.description, 1500)}` : ''}.`,
    'Only the user can approve it, in that subagent\'s conversation; tell them if your work depends on it. Your messages reach it once it runs again.',
  ].join('\n');
}

/** A parent's text as the answer to its child's question, refused with the options when it fits none. */
export function answerFor(question: QuestionRequest, text: string): QuestionAnswer {
  const answer = delegationAnswer(question, text);
  if (typeof answer === 'string') throw refused(answer, { field: 'text', questionId: question.id, expected: question.options.map(o => o.label) });
  return answer;
}

/** One line per open card, for `delegate list` and `delegate wait`. */
export function needLine(childId: string, need: DelegationInput): string {
  if (need.kind === 'permission') return `  needs the user's approval: ${need.toolName}${need.description ? ` (${clip(need.description.replace(/\s+/g, ' '), 160)})` : ''}; only the user can approve it, in its conversation`;
  const options = need.options.length ? ` options: ${need.options.map(label => JSON.stringify(label)).join(' | ')}` : '';
  return `  asks${need.blocking ? ' (blocked)' : ''}: ${JSON.stringify(clip(need.text.replace(/\s+/g, ' '), 300))}${clip(options, 300)}; answer: boite delegate send ${childId} "<answer>"`;
}

/** Where the child's work is: the branch to merge, or that nothing was left to merge. */
export function worktreeLine(worktree: DelegationWorktree): string {
  const base = worktree.base ? worktree.base.slice(0, 12) : 'its base';
  const error = worktree.error ? ` (${worktree.error})` : '';
  switch (worktree.state) {
    case 'pending': return `Worktree: ${worktree.path} on branch ${worktree.branch}, made from your HEAD when its first turn starts${error}.`;
    case 'active': return `Worktree: ${worktree.path} on branch ${worktree.branch}, in use${error}.`;
    case 'removed': return `Worktree: removed with its branch ${worktree.branch}, no commit and no change beyond ${base}.`;
    case 'kept': {
      const what = [`${worktree.commits ?? 0} commit${worktree.commits === 1 ? '' : 's'} beyond ${base}`, ...(worktree.dirty ? ['uncommitted changes'] : [])].join(' and ');
      return `Worktree kept: ${worktree.path} on branch ${worktree.branch}, ${what}${error}. Merge it with git merge ${worktree.branch}${worktree.dirty ? ' once its changes are committed' : ''}.`;
    }
  }
}
