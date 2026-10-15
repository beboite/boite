import type { DelegationInput, PermissionRequest, QuestionAnswer, QuestionRequest } from './index';

/** Settings cards are the owner's to decide: they never go to a delegated agent's parent. */
export const delegationAnswerable = (question: QuestionRequest): boolean => question.setting === undefined && question.agentSetting === undefined;

/** What a delegated child waits on from someone, oldest first. */
export function delegationNeeds(questions: QuestionRequest[], permissions: PermissionRequest[]): DelegationInput[] {
  const open: (DelegationInput & { at: number })[] = [
    ...questions.filter(delegationAnswerable).map(q => ({ kind: 'question' as const, id: q.id, text: q.text, options: q.options.map(o => o.label), allowText: q.allowText, multiple: q.multiple, blocking: q.async !== true, at: q.createdAt })),
    ...permissions.map(p => ({ kind: 'permission' as const, id: p.id, toolName: p.toolName, description: p.description, at: p.createdAt })),
  ];
  return open.sort((a, b) => a.at - b.at).map(({ at: _at, ...need }) => need);
}

/** The question a parent's message to its child answers: a blocking one first, else the oldest. */
export function delegationQuestion(questions: QuestionRequest[]): QuestionRequest | undefined {
  const open = questions.filter(delegationAnswerable);
  return open.find(q => q.async !== true) ?? open[0];
}

/** How a parent answers a question, in the words its refusal and its wake message use. */
export function delegationAnswerForm(question: QuestionRequest): string {
  if (!question.options.length) return 'free text';
  const labels = `${question.multiple ? 'one or more option labels separated by commas' : 'one option label'} as written`;
  return question.allowText ? `${labels}, or free text` : labels;
}

/**
 * A parent's text as the answer to its child's question: an option label in
 * any case, several separated by commas where the question takes several,
 * else free text where it takes some. A string is the refusal, with the options.
 */
export function delegationAnswer(question: QuestionRequest, text: string): QuestionAnswer | string {
  const trimmed = text.trim();
  const byLabel = (label: string) => question.options.find(o => o.label.trim().toLowerCase() === label.trim().toLowerCase());
  const whole = byLabel(trimmed);
  if (whole) return { optionIds: [whole.id] };
  if (question.multiple && question.options.length) {
    const picked = trimmed.split(',').map(part => part.trim()).filter(Boolean).map(byLabel);
    if (picked.length > 1 && picked.every(option => option !== undefined)) return { optionIds: [...new Set(picked.map(option => option!.id))] };
  }
  if (question.allowText) return { optionIds: [], text };
  return `text: the subagent's question takes ${delegationAnswerForm(question)}: ${question.options.map(o => JSON.stringify(o.label)).join(', ')}`;
}
