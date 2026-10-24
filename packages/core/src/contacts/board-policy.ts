import { TODO_STATUSES, TODO_TEXT_MAX, GOAL_CHECKLIST_MAX_ITEMS, GOAL_CHECKLIST_TEXT_MAX, GOAL_CHECKLIST_SOURCE_MAX } from '@boite/contracts';
import type { SharedBoardCard, SharedBoardChange, SharedBoardCommand, SharedBoardPage, SharedProject, TodoGoal } from '@boite/contracts';
import { invalidParams } from '../errors.ts';
import { text } from '../coordination-letter.ts';
import { sourceActor, sameProject, threadRef, projectRef } from './project-policy.ts';

export function integer(value: unknown, field: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw invalidParams(`${field}: expected a safe integer >= ${min}`);
  return value as number;
}
export function boardWorkerInfo(value: unknown): {agent: string; machine: string} | undefined {
  if (value === undefined) return undefined;
  const p = value as {agent?: string; machine?: string} | null;
  return {agent: text(p?.agent, 'workerInfo.agent', 200), machine: text(p?.machine, 'workerInfo.machine', 100)};
}
export function boardCommand(value: unknown): SharedBoardCommand {
  const p = value as SharedBoardCommand;
  if (!p || typeof p !== 'object') throw invalidParams('command: expected a board command');
  const base = { requestId: text(p.requestId, 'command.requestId', 100), cardId: text(p.cardId, 'command.cardId', 128) };
  if (p.kind === 'add') return { ...base, kind: p.kind, text: text(p.text, 'command.text', TODO_TEXT_MAX) };
  if (p.kind === 'update') {
    if (p.status !== undefined && !TODO_STATUSES.includes(p.status)) throw invalidParams('command.status: expected open, claimed or done');
    if (p.text === undefined && p.status === undefined) throw invalidParams('command.update: expected text or status');
    return { ...base, kind: p.kind, ...(p.text === undefined ? {} : { text: text(p.text, 'command.text', TODO_TEXT_MAX) }), ...(p.status === undefined ? {} : { status: p.status }) };
  }
  if (p.kind === 'remove') return { ...base, kind: p.kind };
  if (p.kind === 'claim') return { ...base, kind: p.kind, expectedRevision: integer(p.expectedRevision, 'command.expectedRevision', 1), worker: threadRef(p.worker) };
  if (p.kind === 'release') return { ...base, kind: p.kind, claimId: text(p.claimId, 'command.claimId', 100) };
  throw invalidParams('command.kind: expected add, update, remove, claim or release');
}
/** Whitelist the goal/checklist projection. Raw activity, prompt and verdict text never cross. */
export function boardGoal(value: unknown): TodoGoal | null {
  if (value === null) return null;
  const p = value as TodoGoal;
  if (!p || !['active', 'paused', 'complete'].includes(p.status) || typeof p.reviewing !== 'boolean') throw invalidParams('goal: expected status, reviewing and checklist');
  let checklist: TodoGoal['checklist'] = null;
  if (p.checklist !== null) {
    const c = p.checklist;
    if (!c || !['idle', 'writing', 'checking'].includes(c.phase) || !Array.isArray(c.items) || c.items.length > GOAL_CHECKLIST_MAX_ITEMS) throw invalidParams(`goal.checklist: expected phase and up to ${GOAL_CHECKLIST_MAX_ITEMS} items`);
    const ids = new Set<number>();
    checklist = { threadId: null, phase: c.phase, model: c.model === null ? null : text(c.model, 'checklist.model', 200), effort: c.effort === null ? null : text(c.effort, 'checklist.effort', 100), error: c.error === null ? null : text(c.error, 'checklist.error', 2000), items: c.items.map(item => {
      const id = integer(item.id, 'checklist.item.id', 1);
      if (ids.has(id) || !['open', 'done', 'cancelled'].includes(item.status)) throw invalidParams('checklist.items: expected unique ids and open, done or cancelled status');
      ids.add(id);
      const source = typeof item.source === 'string' ? item.source.slice(0, GOAL_CHECKLIST_SOURCE_MAX).replace(/[\u0000-\u001f\u007f]/g, ' ') : '';
      return { id, text: text(item.text, 'checklist.item.text', GOAL_CHECKLIST_TEXT_MAX).replace(/[\u0000-\u001f\u007f]/g, ' '), source, status: item.status, ...(item.added === true ? {added: true} : {}), ...(item.changed === true ? {changed: true} : {}), ...(item.bounced === undefined ? {} : {bounced: integer(item.bounced, 'checklist.item.bounced')}) };
    }) };
  }
  return { status: p.status, reviewing: p.reviewing, checklist };
}
export function boardCard(value: unknown, shared: SharedProject): SharedBoardCard {
  const p = value as SharedBoardCard;
  if (!p || !TODO_STATUSES.includes(p.status)) throw invalidParams('board.card: expected a card status');
  const creatorRef = projectRef(p.createdBy?.project, 'board.createdBy.project');
  const creator = shared.projects.find(ref => sameProject(ref, creatorRef));
  if (!creator) throw invalidParams('board.createdBy: expected an associated endpoint');
  const assignment = p.assignment === null ? null : { claimId: text(p.assignment?.claimId, 'assignment.claimId', 100), state: p.assignment?.state, actor: p.assignment?.actor, worker: threadRef(p.assignment?.worker), ...(p.assignment?.workerInfo ? {workerInfo: boardWorkerInfo(p.assignment.workerInfo)} : {}) };
  if (assignment) {
    const actorRef = projectRef(assignment.actor?.project, 'board.assignment.actor.project');
    const source = shared.projects.find(ref => sameProject(ref, actorRef));
    if (!source || !sameProject(assignment.worker.project, source) || !['reserved', 'running', 'uncertain', 'complete'].includes(assignment.state)) throw invalidParams('board.assignment: expected the attested worker host');
    assignment.actor = sourceActor(assignment.actor, source);
    assignment.claimId = text(assignment.claimId, 'assignment.claimId', 100);
  }
  return { id: text(p.id, 'card.id', 128), text: text(p.text, 'card.text', TODO_TEXT_MAX), status: p.status, revision: integer(p.revision, 'card.revision', 1), createdBy: sourceActor(p.createdBy, creator), assignment, goal: boardGoal(p.goal), createdAt: integer(p.createdAt, 'card.createdAt'), updatedAt: integer(p.updatedAt, 'card.updatedAt') };
}
export function boardDelta(value: unknown, shared: SharedProject): Extract<SharedBoardPage, {kind: 'delta'}> {
  const p = value as Extract<SharedBoardPage, {kind: 'delta'}>;
  if (!p || p.kind !== 'delta' || !Array.isArray(p.changes) || p.changes.length > 64 || typeof p.more !== 'boolean') throw invalidParams('board.page: expected a bounded delta');
  const from = integer(p.from, 'board.from'), to = integer(p.to, 'board.to');
  const changes: SharedBoardChange[] = p.changes.map((change, index) => {
    const revision = integer(change.revision, 'board.change.revision', 1);
    if (revision !== from + index + 1) throw invalidParams('board.change.revision: expected contiguous authority revisions');
    if (change.kind === 'card') { const card = boardCard(change.card, shared); if (card.revision !== revision) throw invalidParams('board.card.revision: expected change revision'); return { kind: 'card', card, revision }; }
    if (change.kind !== 'deleted' || !change.tombstone) throw invalidParams('board.change: expected card or deleted');
    const tombstone = { id: text(change.tombstone.id, 'tombstone.id', 128), revision: integer(change.tombstone.revision, 'tombstone.revision', 1), deletedAt: integer(change.tombstone.deletedAt, 'tombstone.deletedAt') };
    if (tombstone.revision !== revision) throw invalidParams('board.tombstone.revision: expected change revision');
    return { kind: 'deleted', revision, tombstone };
  });
  if (to !== from + changes.length || p.more && changes.length === 0) throw invalidParams('board.to: expected contiguous progress');
  return { kind: 'delta', from, to, changes, more: p.more };
}
