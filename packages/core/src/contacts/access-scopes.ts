import { threadActive } from '@boite/contracts';
import { realpathSync } from 'node:fs';
import type { SharedProjectActor, SharedThreadRef } from '@boite/contracts';
import type { Core } from '../core.ts';
import { projectAddress } from './project-policy.ts';
import { refused } from '../errors.ts';
import type { ComputeRecord } from './compute-journal.ts';
import type { SharedPeerContext } from './projects.ts';

export interface AccessBinding {
  job: {id: string | null; sharedProjectId: string; grantRevision: number; source: SharedThreadRef};
  checkoutPath: string;
  threadId: string;
  actor?: SharedProjectActor;
  compute?: ComputeRecord;
  board?: {threadId: string; cardId: string; claimId: string};
  /** Intersect permissions when history contains more than one external authority. */
  additional?: AccessBinding[];
}
interface BoardScope {sharedProjectId: string; cardId: string; claimId: string; revision: number; root: string; actor: SharedProjectActor}
export function computeBinding(record: ComputeRecord): AccessBinding {
  return {job: record.job, checkoutPath: record.checkoutPath!, threadId: record.job.worker!.threadId, compute: record};
}
export function bindBoard(core: Core, ctx: SharedPeerContext, worker: SharedThreadRef, cardId: string, claimId: string): void {
  const thread = core.threads.require(worker.threadId), {index} = core.sharedProjects.endpoints(ctx.shared);
  const protocol = core.providers.require(thread.providerId).protocol;
  if (!core.sharedAccess.execution.support(protocol, thread.providerId, thread.permissionMode).supported || protocol === 'echo' && thread.permissionMode !== 'default') throw refused('shared file policy: board execution requires a protected provider route');
  if (threadActive(thread.status) || core.procs.liveCount(thread.id) > 0) throw refused('shared file policy: board execution requires an idle host conversation');
  const entry = core.sharedBoard.journal.entry(ctx.shared.id, cardId);
  if (entry?.kind !== 'card' || entry.card.assignment?.claimId !== claimId) throw refused('shared file policy: expected the current board claim');
  const scope: BoardScope = {sharedProjectId: ctx.shared.id, cardId, claimId, revision: ctx.shared.access[index].revision, root: realpathSync(thread.cwd), actor: entry.card.assignment.actor};
  core.journal.setSetting(`shared-file-board:${thread.id}`, scope);
}
/** Descendants inherit the host scope. Replacing an owner's goal releases the ordinary local thread. */
export function accessBinding(core: Core, threadId: string): AccessBinding | null {
  const compute = core.sharedCompute.journal.worker(threadId);
  if (compute) return computeBinding(compute);
  const inherited = core.journal.getSetting(`shared-file-descendant:${threadId}`) as {scope: BoardScope; parent: string} | null;
  if (inherited) return boardBinding(core, threadId, inherited.parent, inherited.scope);
  let thread = core.journal.getThread(threadId);
  const seen = new Set<string>();
  while (thread && !seen.has(thread.id)) {
    seen.add(thread.id);
    const active = core.journal.getSetting(`activity:shared:${thread.id}`) as {sharedProjectId: string; cardId: string; claimId: string} | null;
    if (active) {
      const scope = core.journal.getSetting(`shared-file-board:${thread.id}`) as BoardScope | null;
      if (!scope || scope.sharedProjectId !== active.sharedProjectId || scope.claimId !== active.claimId || scope.cardId !== active.cardId) throw refused('shared file policy: this board goal has no captured host protection');
      if (thread.id !== threadId) core.journal.setSetting(`shared-file-descendant:${threadId}`, {scope, parent: thread.id});
      return boardBinding(core, threadId, thread.id, scope);
    }
    const parent = thread.parentThreadId && core.sharedCompute.journal.worker(thread.parentThreadId);
    if (parent) return {...computeBinding(parent), threadId};
    thread = thread.parentThreadId ? core.journal.getThread(thread.parentThreadId) : null;
  }
  return null;
}
function boardBinding(core: Core, threadId: string, parent: string, scope: BoardScope): AccessBinding {
  const shared = core.sharedProjects.require(scope.sharedProjectId), {local} = core.sharedProjects.endpoints(shared);
  return {job: {id: null, sharedProjectId: shared.id, grantRevision: scope.revision, source: {project: local, threadId: parent, address: projectAddress(local, parent)}},
    checkoutPath: scope.root, threadId, actor: scope.actor, board: {threadId: parent, cardId: scope.cardId, claimId: scope.claimId}};
}
