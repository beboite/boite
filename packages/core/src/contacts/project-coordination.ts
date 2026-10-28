/** Existing agent entry points use exact association scopes once owners associate a contact. */
import type { AgentTranscript, CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Operation } from '../coordination-wire.ts';
import { refused } from '../errors.ts';

export async function projectCoordination(core: Core, threadId: string, peer: CoordinationPeer, method: 'directory' | 'search' | 'read', payload: unknown): Promise<unknown> {
  const service = core.sharedProjects;
  if (!service.hasContact(peer.coreId)) return core.coordination.request(peer, method as Operation, payload);
  const scopes = service.forThread(threadId, peer.coreId).map(shared => ({ threadId, sharedProjectId: shared.id }));
  // Each answer counts only while the association that asked for it still stands once every lookup returned.
  const live = <T>(results: T[]) => {
    const current = new Set(service.forThread(threadId, peer.coreId).map(shared => shared.id));
    return results.filter((_, index) => current.has(scopes[index]!.sharedProjectId));
  };
  if (method === 'directory') {
    const results = live(await Promise.all(scopes.map(scope => service.threads(scope))));
    if (results.some(r => r.unavailable.length)) throw refused('shared project endpoint is unavailable');
    return results.flatMap(r => r.threads.filter(t => t.ref.project.ownerCoreId === peer.coreId).map(t => t.agent)).slice(0, 100);
  }
  if (method === 'search') {
    const query = (payload as { words: string[] }).words.join(' ');
    const results = live(await Promise.all(scopes.map(scope => service.search({ ...scope, query }))));
    if (results.some(r => r.unavailable.length)) throw refused('shared project endpoint is unavailable');
    return results.flatMap(r => r.matches.filter(t => t.coreId === peer.coreId)).slice(0, 100);
  }
  const p = payload as { threadId: string; limit?: number; before?: number };
  for (const scope of scopes) {
    const { threads } = await service.threads(scope);
    const target = threads.find(t => t.ref.project.ownerCoreId === peer.coreId && t.ref.address.threadId === p.threadId)?.ref;
    if (target) return service.read({ ...scope, target, ...(p.limit === undefined ? {} : { limit: p.limit }), ...(p.before === undefined ? {} : { before: p.before }) }) as Promise<AgentTranscript>;
  }
  throw refused('target.threadId: not an allowed thread of this source project association');
}
