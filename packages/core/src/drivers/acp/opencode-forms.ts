import type { AcpTurn } from './turn.ts';
import { list, text, type NativeCall } from './opencode-controls.ts';

/** Native forms retain the field keys the server validates in its answer. */
export async function answerOpenCodeForm(turn: AcpTurn, form: Record<string, unknown>, call: NativeCall): Promise<void> {
  const path = `/api/session/${encodeURIComponent(text(form['sessionID']))}/form/${encodeURIComponent(text(form['id']))}`;
  const answer: Record<string, unknown> = {};
  for (const field of list(form['fields'])) {
    if (turn.isStopped || turn.settled) return;
    if (!list(field['when']).every(condition => condition['op'] === 'neq'
      ? answer[text(condition['key'])] !== condition['value']
      : answer[text(condition['key'])] === condition['value'])) continue;
    if (field['hidden'] === true) { if (field['default'] !== undefined) answer[text(field['key'])] = field['default']; continue; }
    const options = field['type'] === 'boolean'
      ? [{ id: 'true', label: 'true' }, { id: 'false', label: 'false' }]
      : list(field['options']).map(option => ({ id: text(option['value']), label: text(option['label']) || text(option['value']) }));
    const ask = { text: [text(form['title']), text(field['title']) || text(field['key']), text(field['description']), text(field['url'])].filter(Boolean).join('\n'),
      options, allowText: field['custom'] === true || options.length === 0, multiple: field['type'] === 'multiselect' };
    const ticket = turn.ctx.askQuestion(ask);
    const index = turn.takeIndex();
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
    const response = await Promise.race([ticket, turn.stopped.then(() => null)]);
    if (response === null || turn.isStopped || turn.settled) return;
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: response });
    const raw = response.text || response.optionIds[0] || '';
    answer[text(field['key'])] = field['type'] === 'multiselect' ? [...response.optionIds, ...(response.text ? [response.text] : [])]
      : field['type'] === 'boolean' ? raw === 'true'
      : field['type'] === 'number' || field['type'] === 'integer' ? Number(raw) : raw;
  }
  await call(`${path}/reply`, 'POST', { answer });
}
