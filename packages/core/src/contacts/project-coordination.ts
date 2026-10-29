/** Existing agent entry points use exact association scopes once owners associate a contact. */
import type { AgentTranscript, CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Operation } from '../coordination-wire.ts';
import { refused } from '../errors.ts';

/**
 * Rereads a lookup's answer as the associations standing now allow it. The
 * caller calls it after its own last await, right before it exposes the answer:
 * what came through an association revoked meanwhile is dropped.
 */
export type ScopedAnswer = () => unknown;

export async function projectCoordination(core: Core, threadId: string, peer: CoordinationPeer, method: 'directory' | 'search' | 'read', payload: unknown): Promise<ScopedAnswer> {
  const service = core.sharedProjects;
  if (!service.hasContact(peer.coreId)) {
    const answer = await core.coordination.request(peer, method as Operation, payload);
    return () => answer;
  }
  const scopes = service.forThread(threadId, peer.coreId).map(shared => ({ threadId, sharedProjectId: shared.id }));
  const standing = () => new Set(service.forThread(threadId, peer.coreId).map(shared => shared.id));
  const live = <T>(results: T[]) => {
    const current = standing();
    return results.filter((_, index) => current.has(scopes[index]!.sharedProjectId));
  };
  if (method === 'directory') {
    const results = await Promise.all(scopes.map(scope => service.threads(scope)));
    if (results.some(r => r.unavailable.length)) throw refused('shared project endpoint is unavailable');
    return () => live(results).flatMap(r => r.threads.filter(t => t.ref.project.ownerCoreId === peer.coreId).map(t => t.agent)).slice(0, 100);
  }
  if (method === 'search') {
    const query = (payload as { words: string[] }).words.join(' ');
    const results = await Promise.all(scopes.map(scope => service.search({ ...scope, query })));
    if (results.some(r => r.unavailable.length)) throw refused('shared project endpoint is unavailable');
    return () => live(results).flatMap(r => r.matches.filter(t => t.coreId === peer.coreId)).slice(0, 100);
  }
  const p = payload as { threadId: string; limit?: number; before?: number };
  for (const scope of scopes) {
    const { threads } = await service.threads(scope);
    const target = threads.find(t => t.ref.project.ownerCoreId === peer.coreId && t.ref.address.threadId === p.threadId)?.ref;
    if (!target) continue;
    const answer: AgentTranscript = await service.read({ ...scope, target, ...(p.limit === undefined ? {} : { limit: p.limit }), ...(p.before === undefined ? {} : { before: p.before }) });
    return () => {
      if (!standing().has(scope.sharedProjectId)) throw refused('target.threadId: the source project association was revoked');
      return answer;
    };
  }
  throw refused('target.threadId: not an allowed thread of this source project association');
}
