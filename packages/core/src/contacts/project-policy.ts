import type { SharedComputePolicy, SharedProject, SharedProjectAccess, SharedProjectActor, SharedProjectRef, SharedThreadRef } from '@boite/contracts';
import { text } from '../coordination-letter.ts';
import { invalidParams, refused } from '../errors.ts';
import { memberThreadId } from './member-address.ts';

export const sameProject = (a: SharedProjectRef, b: SharedProjectRef): boolean => a.ownerCoreId === b.ownerCoreId && a.coreId === b.coreId && a.projectId === b.projectId;
export const projectAddress = (project: SharedProjectRef, threadId: string) => ({coreId: project.ownerCoreId, threadId: project.ownerCoreId === project.coreId ? threadId : memberThreadId(project.coreId, threadId)});
export const disabledCompute = (): SharedComputePolicy => ({ enabled: false, profiles: [], permissionMode: 'default', maxConcurrent: null });
export const initialAccess = (project: SharedProjectRef): SharedProjectAccess => ({ project, revision: 1, board: false, compute: disabledCompute(), revokedAt: null });

export function projectRef(value: unknown, field = 'project'): SharedProjectRef {
  const raw = value as Partial<SharedProjectRef> | null;
  if (!raw || typeof raw.ownerCoreId !== 'string' || !/^[a-f0-9]{64}$/.test(raw.ownerCoreId) || typeof raw.coreId !== 'string' || !/^[a-f0-9]{64}$/.test(raw.coreId)) throw invalidParams(`${field}: expected ownerCoreId and coreId public fingerprints`);
  return { ownerCoreId: raw.ownerCoreId, coreId: raw.coreId, projectId: text(raw.projectId, `${field}.projectId`, 128) };
}
export function threadRef(value: unknown): SharedThreadRef {
  const raw = value as Partial<SharedThreadRef> | null;
  const project = projectRef(raw?.project, 'target.project');
  const threadId = text(raw?.threadId, 'target.threadId', 128);
  const expected = projectAddress(project, threadId);
  if (raw?.address?.coreId !== expected.coreId || raw.address.threadId !== expected.threadId) throw refused('target.address: expected the selected endpoint public thread address');
  return { project, threadId, address: expected };
}
export function computePolicy(value: unknown): SharedComputePolicy {
  const raw = value as Partial<SharedComputePolicy> | null;
  if (!raw || typeof raw.enabled !== 'boolean' || !Array.isArray(raw.profiles) || raw.profiles.length > 100 || !['default', 'plan', 'acceptEdits', 'bypassPermissions', 'yolo', 'dontAsk'].includes(raw.permissionMode as string)
    || (raw.maxConcurrent !== null && (!Number.isSafeInteger(raw.maxConcurrent) || raw.maxConcurrent! < 1))) throw invalidParams('access.compute: expected enabled, profiles, permissionMode and positive maxConcurrent or null');
  return { enabled: raw.enabled, profiles: raw.profiles.map(id => text(id, 'access.compute.profiles', 128)), permissionMode: raw.permissionMode!, maxConcurrent: raw.maxConcurrent! };
}
export function accessRecord(value: unknown, project: SharedProjectRef): SharedProjectAccess {
  const raw = value as Partial<SharedProjectAccess> | null;
  if (!raw || !sameProject(projectRef(raw.project, 'access.project'), project) || !Number.isSafeInteger(raw.revision) || raw.revision! < 1 || typeof raw.board !== 'boolean'
    || raw.revokedAt !== null && (!Number.isSafeInteger(raw.revokedAt) || raw.revokedAt! < 0)) throw invalidParams('access: expected the sender endpoint, positive revision, board and revokedAt');
  return { project, revision: raw.revision!, board: raw.board, compute: computePolicy(raw.compute), revokedAt: raw.revokedAt! };
}
export function offeredProject(value: unknown, sender: string, self: string, owner = self): SharedProject {
  const raw = value as Partial<SharedProject> | null;
  if (!raw || !Array.isArray(raw.projects) || raw.projects.length !== 2 || !Array.isArray(raw.access) || raw.access.length !== 2) throw invalidParams('offer.project: expected two project endpoints and access records');
  const projects: [SharedProjectRef, SharedProjectRef] = [projectRef(raw.projects[0]), projectRef(raw.projects[1])];
  if (projects[0].ownerCoreId !== sender || projects[1].ownerCoreId !== owner || projects[1].coreId !== self || !sameProject(projectRef(raw.authority), projects[0])) throw refused('offer.project: expected authenticated sender and the selected local endpoint');
  if (raw.state !== 'pending' || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.updatedAt)) throw invalidParams('offer.project: expected pending state and timestamps');
  const access: [SharedProjectAccess, SharedProjectAccess] = [accessRecord(raw.access[0], projects[0]), initialAccess(projects[1])];
  // An offer cannot grant anything on the receiver, including board or compute consent.
  if (access[0].revokedAt !== null || JSON.stringify(accessRecord(raw.access[1], projects[1])) !== JSON.stringify(access[1])) throw refused('offer.access: receiver consent must remain disabled');
  return { id: text(raw.id, 'offer.id', 100), projects, authority: projects[0], state: 'pending', access, createdAt: raw.createdAt!, updatedAt: raw.updatedAt! };
}
export function sourceActor(value: unknown, project: SharedProjectRef): SharedProjectActor {
  const raw = value as Partial<SharedProjectActor> | null;
  if (!raw || !sameProject(projectRef(raw.project, 'source.project'), project)) throw refused('source.project: expected the associated sender endpoint');
  if (raw.kind === 'human') return { kind: 'human', project };
  if (raw.kind !== 'agent') throw invalidParams('source.kind: expected human or agent');
  const ref = threadRef({ project, threadId: raw.threadId, address: raw.address });
  return { kind: 'agent', project, threadId: ref.threadId, address: ref.address, agent: text(raw.agent, 'source.agent', 200) };
}
