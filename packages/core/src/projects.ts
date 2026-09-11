import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Project, ProjectId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { notFound, refused } from './errors.ts';
import { FileIndex } from './files.ts';
import type { FilesPage } from './files.ts';

export class ProjectStore {
  private readonly removing = new Set<ProjectId>();
  private readonly files = new FileIndex();
  constructor(private readonly core: Core) {}

  /** The files a mention can name, ranked on the query. */
  listFiles(projectId: ProjectId, query: string, limit?: number): Promise<FilesPage> {
    const project = this.require(projectId);
    if (typeof query !== 'string') throw refused('projects.files wants a string query', { projectId });
    return this.files.list(project.path, query, limit);
  }

  list(): Project[] {
    return this.core.journal.listProjects();
  }

  require(projectId: ProjectId): Project {
    if (this.removing.has(projectId)) throw refused('this project is being removed', { projectId });
    const project = this.core.journal.getProject(projectId);
    if (project === null) throw notFound(`unknown project ${projectId}`, { projectId });
    return project;
  }

  add(path: string, name?: string): Project {
    const full = resolve(path);
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw refused('a project path must be an existing directory', { path: full });

    const existing = this.list().find((project) => project.path === full);
    if (existing !== undefined) return existing;

    const project: Project = {
      id: newId('prj_'),
      name: name !== undefined && name.length > 0 ? name : basename(full),
      path: full,
      createdAt: Date.now(),
    };
    this.core.journal.append({ type: 'project.added', threadId: null, version: 1, payload: project }, () => {
      this.core.journal.putProject(project);
    });
    this.core.bus.emit('project.added', project);
    return project;
  }

  async remove(projectId: ProjectId): Promise<void> {
    const project = this.require(projectId);
    this.removing.add(projectId);
    try {
      const threads = this.core.journal.listThreads(projectId);
      for (const thread of threads) this.core.threads.archive(thread.id, true);
      await Promise.all(threads.map((thread) => this.core.scheduler.stopAndWait(thread.id)));
      await Promise.all(threads.map((thread) => this.core.procs.stopAndWait(thread.id)));
      const threadIds = this.core.journal.append(
        { type: 'project.removed', threadId: null, version: 1, payload: { projectId } },
        () => {
          const removed = this.core.journal.deleteThreadsOfProject(projectId);
          this.core.journal.deleteProject(projectId);
          return removed;
        },
      );
      for (const threadId of threadIds) this.core.bus.emit('thread.removed', { threadId });
      this.core.bus.emit('project.removed', { projectId });
      this.files.forget(project.path);
    } finally {
      this.removing.delete(projectId);
    }
  }
}

export function registerProjectMethods(core: Core): void {
  core.router.register('projects.list', () => core.projects.list());
  core.router.register('projects.add', (params) => core.projects.add(params.path, params.name));
  core.router.register('projects.remove', async (params) => {
    await core.projects.remove(params.projectId);
    return { ok: true } as const;
  });
  core.router.register('projects.files', (params) =>
    core.projects.listFiles(params.projectId, params.query, params.limit),
  );
}
