import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Project, ProjectId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { notFound, refused } from './errors.ts';

export class ProjectStore {
  constructor(private readonly core: Core) {}

  list(): Project[] {
    return this.core.journal.listProjects();
  }

  require(projectId: ProjectId): Project {
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
    return project;
  }

  remove(projectId: ProjectId): void {
    this.require(projectId);
    const threadIds = this.core.journal.append(
      { type: 'project.removed', threadId: null, version: 1, payload: { projectId } },
      () => {
        const removed = this.core.journal.deleteThreadsOfProject(projectId);
        this.core.journal.deleteProject(projectId);
        return removed;
      },
    );
    for (const threadId of threadIds) this.core.bus.emit('thread.removed', { threadId });
  }
}

export function registerProjectMethods(core: Core): void {
  core.router.register('projects.list', () => core.projects.list());
  core.router.register('projects.add', (params) => core.projects.add(params.path, params.name));
  core.router.register('projects.remove', (params) => {
    core.projects.remove(params.projectId);
    return { ok: true } as const;
  });
}
