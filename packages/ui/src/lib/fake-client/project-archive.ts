/** A project put away and brought back, and the count of archived threads every answer carries. */
import { RpcErrorCode, type Project } from '@boite/contracts';
import { RpcFailure } from '../client';
import { pathKey } from './checks';
import type { FakeContext } from './context';

/** A project as the core answers it: the stored row plus its count of archived threads, sub-threads left out. */
export function describedProject(ctx: FakeContext, project: Project): Project {
  const { archivedThreads: _stale, missing: _was, ...row } = project;
  const archivedThreads = [...ctx.threads.values()].filter((t) => t.projectId === project.id && t.archived && !t.parentThreadId).length;
  const missing = ctx.goneFolders.has(pathKey(project.path));
  return structuredClone({ ...row, autoArchiveMergedPr: row.autoArchiveMergedPr !== false, ...(missing ? { repository: false, missing: true } : {}), ...(archivedThreads > 0 ? { archivedThreads } : {}) });
}

/** The core's `folderGone`: one sentence for every method that meets a folder no longer on the disk. */
export function folderGone(path: string, data: Record<string, unknown>): RpcFailure {
  return new RpcFailure({
    code: RpcErrorCode.Refused,
    message: `the folder ${path} does not exist any more: it was deleted, moved or renamed`,
    data: { ...data, path, expected: 'an existing folder' }
  });
}

/** As the core's `requireFolder`: refused by a folder that is gone, and every client hears the project is `missing`. */
export function requireFakeFolder(ctx: FakeContext, project: Project): void {
  if (project.kind === 'drafts' || !ctx.goneFolders.has(pathKey(project.path))) return;
  if (project.missing !== true) {
    project.missing = true;
    ctx.emit('project.updated', describedProject(ctx, project));
  }
  throw folderGone(project.path, { field: 'projectId', projectId: project.id, project: project.name });
}

/** As the core's `announce`: every client hears how the project now reads. */
export function announceProject(ctx: FakeContext, projectId: string): Project {
  const project = ctx.projects.find((p) => p.id === projectId);
  if (!project) throw ctx.notFound('project', projectId);
  const answered = describedProject(ctx, project);
  ctx.emit('project.updated', structuredClone(answered));
  return answered;
}

/** As the core: only the flag moves, and the drafts stay where a thread with no folder lands. */
export function archiveProject(ctx: FakeContext, projectId: string, archived: boolean): Project {
  const project = ctx.projects.find((p) => p.id === projectId);
  if (!project) throw ctx.notFound('project', projectId);
  if (archived && project.kind === 'drafts') {
    throw new RpcFailure({
      code: RpcErrorCode.Refused,
      message: 'the drafts project cannot be archived: a thread with no folder lands in it',
      data: { field: 'projectId', projectId, expected: 'a project other than the drafts' }
    });
  }
  if ((project.archived === true) === archived) return describedProject(ctx, project);
  if (archived) project.archived = true;
  else delete project.archived;
  return announceProject(ctx, projectId);
}
