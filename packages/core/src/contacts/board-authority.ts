/** Synchronous authority admission: receipt, card and revision commit together, with no await. */
import type { SharedBoardCard, SharedBoardCommand, SharedBoardReceipt, SharedThreadRef } from '@boite/contracts';
import { refused } from '../errors.ts';
import { AGENT_OPEN_TODOS_MAX } from '../todos.ts';
import type { SharedPeerContext } from './projects.ts';
import type { SharedBoard } from './board.ts';
import { sameProject } from './project-policy.ts';
import { fingerprint } from './project-journal.ts';
import type { BoardProgress } from './board-journal.ts';

export function receipt(board: SharedBoard, ctx: SharedPeerContext, requestId: string, outcome: SharedBoardReceipt['outcome'], cardId: string): SharedBoardReceipt {
  const entry = board.journal.entry(ctx.shared.id, cardId);
  return { requestId, outcome, revision: board.journal.revision(ctx.shared.id), card: entry?.kind === 'card' ? entry.card : null };
}
function sameWorker(a: SharedThreadRef, b: SharedThreadRef): boolean { return sameProject(a.project, b.project) && a.threadId === b.threadId && a.address.coreId === b.address.coreId && a.address.threadId === b.address.threadId; }

export function applyAtAuthority(board: SharedBoard, ctx: SharedPeerContext, command: SharedBoardCommand, workerInfo?: {agent: string; machine: string}, stoppedClaim?: string): SharedBoardReceipt {
  board.check(ctx, true);
  const id = ctx.shared.id;
  return board.core.bus.afterCommit(() => board.core.sharedProjects.journal.transaction(() => board.core.sharedProjects.journal.once(`board:${id}:${board.journal.actor(ctx.source)}`, command.requestId, command, () => {
    const entry = board.journal.entry(id, command.cardId);
    if (entry?.kind === 'deleted') return receipt(board, ctx, command.requestId, 'deleted', command.cardId);
    const current = entry?.kind === 'card' ? entry.card : null;
    if (ctx.source.kind === 'agent') {
      if (command.kind === 'remove' || command.kind === 'update' && command.status === 'done' || current?.status === 'done') throw refused('board: only the user confirms, removes or reopens a confirmed card');
      if (command.kind === 'update' && command.status === 'claimed' && current?.status !== 'open') return receipt(board, ctx, command.requestId, 'conflict', command.cardId);
      if (command.kind === 'add' && board.journal.snapshot(id).cards.filter(c => c.status !== 'done').length >= AGENT_OPEN_TODOS_MAX) throw refused(`board: an agent adds fewer than ${AGENT_OPEN_TODOS_MAX} open or claimed cards`);
    }
    if ((command.kind === 'add') === !!current) return receipt(board, ctx, command.requestId, 'conflict', command.cardId);
    const now = Date.now(), revision = board.journal.revision(id) + 1;
    let card: SharedBoardCard;
    if (command.kind === 'remove') {
      board.journal.append(id, { kind: 'deleted', revision, tombstone: {id: command.cardId, revision, deletedAt: now} });
      board.changed(id);
      return receipt(board, ctx, command.requestId, 'applied', command.cardId);
    }
    if (command.kind === 'add') card = { id: command.cardId, text: command.text, status: 'open', revision, createdBy: ctx.source, assignment: null, goal: null, createdAt: now, updatedAt: now };
    else {
      card = { ...current!, revision, updatedAt: now };
      if (command.kind === 'update') card = { ...card, ...(command.text === undefined ? {} : {text: command.text}), ...(command.status === undefined ? {} : {status: command.status}) };
      if (command.kind === 'claim') {
        if (!sameProject(command.worker.project, ctx.source.project) || ctx.source.kind === 'agent' && command.worker.threadId !== ctx.source.threadId) throw refused('command.worker: expected the authenticated source worker on its own host');
        const occupied = board.journal.snapshot(id).cards.some(c => c.assignment && sameWorker(c.assignment.worker, command.worker));
        if (current!.revision !== command.expectedRevision || current!.status !== 'open' || current!.assignment || occupied) return receipt(board, ctx, command.requestId, 'conflict', command.cardId);
        const claimId = fingerprint({association: id, actor: board.journal.actor(ctx.source), card: command.cardId, request: command.requestId});
        card.assignment = { claimId, actor: ctx.source, worker: command.worker, state: 'reserved', ...(workerInfo ? {workerInfo} : {}) };
        card.goal = null;
      }
      if (command.kind === 'release') {
        if (!current!.assignment || current!.assignment.claimId !== command.claimId) return receipt(board, ctx, command.requestId, 'conflict', command.cardId);
        if (ctx.source.kind === 'agent' && board.journal.actor(current!.assignment.actor) !== board.journal.actor(ctx.source)) throw refused('claimId: only the claimant agent or a user releases a reservation');
        if (stoppedClaim !== command.claimId) throw refused('claimId: release requires the assigned host to confirm its execution stopped');
        card.assignment = null; card.goal = null; card.status = 'open';
      }
    }
    board.journal.append(id, { kind: 'card', card, revision });
    board.changed(id);
    return receipt(board, ctx, command.requestId, 'applied', command.cardId);
  })));
}

export function progressAtAuthority(board: SharedBoard, ctx: SharedPeerContext, p: BoardProgress): SharedBoardReceipt {
  board.check(ctx, true);
  const id = ctx.shared.id, requestId = fingerprint({card: p.cardId, claim: p.claimId, sequence: p.sequence});
  return board.core.bus.afterCommit(() => board.core.sharedProjects.journal.transaction(() => board.core.sharedProjects.journal.once(`board-progress:${id}:${board.journal.actor(ctx.source)}`, requestId, p, () => {
    const entry = board.journal.entry(id, p.cardId);
    if (entry?.kind === 'deleted') return receipt(board, ctx, requestId, 'deleted', p.cardId);
    if (entry?.kind !== 'card' || entry.card.assignment?.claimId !== p.claimId) return receipt(board, ctx, requestId, 'conflict', p.cardId);
    const card = entry.card, assignment = card.assignment!;
    if (!sameProject(p.worker.project, ctx.source.project) || !sameWorker(assignment.worker, p.worker)
      || ctx.source.kind === 'agent' && ctx.source.threadId !== p.worker.threadId) throw refused('board.progress.worker: only the assigned worker host attests its journalled goal');
    const sequenceKey = `shared-board-sequence:${fingerprint([id, p.cardId, p.claimId])}`;
    const previous = board.core.journal.getSetting(sequenceKey) as number | null;
    if (p.sequence <= (previous ?? 0)) return receipt(board, ctx, requestId, 'conflict', p.cardId);
    board.core.journal.setSetting(sequenceKey, p.sequence);
    const revision = board.journal.revision(id) + 1;
    // A user-confirmed card remains confirmed; only a successful reviewed goal asks for confirmation.
    // The worker timestamp identifies its verdict; comparing clocks between owners would lose passes.
    const passKey = `shared-board-pass:${fingerprint([id, p.cardId, p.claimId])}`;
    const passed = p.goal?.status === 'complete' && p.reviewPassedAt !== null;
    const freshPass = passed && board.core.journal.getSetting(passKey) !== p.reviewPassedAt;
    if (passed) board.core.journal.setSetting(passKey, p.reviewPassedAt);
    const status = card.status === 'open' && freshPass ? 'claimed' : card.status;
    const updated: SharedBoardCard = { ...card, goal: p.goal, status, revision,
      assignment: { ...assignment, state: p.goal === null ? 'uncertain' : p.goal.status === 'complete' ? 'complete' : 'running' } };
    board.journal.append(id, {kind: 'card', revision, card: updated});
    board.changed(id);
    return receipt(board, ctx, requestId, 'applied', p.cardId);
  })));
}
