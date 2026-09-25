import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Project, ProjectId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { notFound, refused } from './errors.ts';
import { FileIndex } from './files.ts';
import { documentsDir } from './platform/folders.ts';
import { threadTerminalId } from './terminals.ts';
import type { FilesPage } from './files.ts';

/** How long a `.git` check may take before the last known answer stands. */
export const GIT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether `folder` holds a `.git`, off the event loop: true, false, or null
 * when the disk gave no clear answer (a share whose host is gone). A
 * synchronous check there blocked the whole core for 21 s on Windows.
 */
export function probeGit(folder: string): Promise<boolean | null> {
  return stat(join(folder, '.git')).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? false : null),
  );
}

/** `probeGit` with a deadline: null when the disk did not answer in time. */
export function hasGitMarker(folder: string, timeoutMs = GIT_PROBE_TIMEOUT_MS): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    void probeGit(folder).then((found) => { clearTimeout(timer); resolve(found); });
  });
}

interface GitFlag {
  value: boolean | undefined;
  inflight: boolean;
}

export class ProjectStore {
  private readonly removing = new Set<ProjectId>();
  private readonly files = new FileIndex();
  private draftsDir: string | null = null;
  /** The last `.git` answer per project folder. Answers read it; a check in the background refreshes it. */
  private readonly git = new Map<string, GitFlag>();
  /** Replaced by a test to hold a check pending. */
  gitProbe: (folder: string) => Promise<boolean | null> = probeGit;

  constructor(private readonly core: Core) {
    // The first `projects.list` after a start already has answers.
    for (const project of core.journal.listProjects()) this.refreshGit(project.path);
  }

  /**
   * Where drafts live: `BOITE_DRAFTS_DIR`, else `Boite` in the Documents
   * folder. Resolved once per core; a test sets the variable before its core.
   */
  draftsPath(): string {
    if (this.draftsDir === null) {
      const fromEnv = process.env.BOITE_DRAFTS_DIR;
      this.draftsDir = resolve(fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(documentsDir(), 'Boite'));
    }
    return this.draftsDir;
  }

  /** The drafts project, its folder and its row made on the first call. */
  drafts(): Project {
    const path = this.draftsPath();
    const existing = this.list().find((project) => project.path === path);
    if (existing !== undefined) {
      mkdirSync(path, { recursive: true });
      return existing;
    }
    try {
      mkdirSync(path, { recursive: true });
    } catch (error) {
      throw refused(`the drafts folder cannot be made: ${error instanceof Error ? error.message : String(error)}`, { path });
    }
    return this.add(path, 'Drafts');
  }

  isDrafts(project: Project): boolean {
    return project.path === this.draftsPath();
  }

  /** The files a mention can name, ranked on the query. */
  listFiles(projectId: ProjectId, query: string, limit?: number): Promise<FilesPage> {
    const project = this.require(projectId);
    if (typeof query !== 'string') throw refused('projects.files wants a string query', { projectId });
    return this.files.list(project.path, query, limit);
  }

  list(): Project[] {
    return this.core.journal.listProjects().map((project) => this.described(project));
  }

  require(projectId: ProjectId | null): Project {
    if (projectId === null) throw refused('this agent session has no project');
    if (this.removing.has(projectId)) throw refused('this project is being removed', { projectId });
    const project = this.core.journal.getProject(projectId);
    if (project === null) throw notFound(`unknown project ${projectId}`, { projectId });
    return this.described(project);
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
    // The folder just answered, so this check does too; the answer is exact from the start.
    this.git.set(full, { value: existsSync(join(full, '.git')), inflight: false });

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
    const answered = this.described(project);
    this.core.bus.emit('project.added', answered);
    return answered;
  }

  async remove(projectId: ProjectId): Promise<void> {
    const project = this.require(projectId);
    if (this.core.workforce.records.list('mission').some(mission => mission.projectId === projectId)
      || this.core.workforce.records.list('team').some(team => team.projectIds.includes(projectId))
      || this.core.workforce.records.list('resource').some(resource => resource.scope.kind === 'project' && resource.scope.id === projectId)
      || this.core.workforce.records.list('memory').some(memory => memory.scope.kind === 'project' && memory.scope.id === projectId)) {
      throw refused('this project is referenced by persistent agents; keep it registered to preserve their workspaces and shared context', { projectId });
    }
    this.removing.add(projectId);
    try {
      const threads = this.core.journal.listThreads(projectId);
      for (const thread of threads) this.core.threads.archive(thread.id, true);
      await Promise.all(threads.map((thread) => this.core.scheduler.stopAndWait(thread.id)));
      await Promise.all(threads.map((thread) => this.core.procs.stopAndWait(thread.id)));
      // A thread's shell runs under its own trace id: it is gone too before the records go.
      await Promise.all(threads.map((thread) => this.core.procs.stopAndWait(threadTerminalId(thread.id))));
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
      this.git.delete(project.path);
    } finally {
      this.removing.delete(projectId);
    }
  }

  /**
   * What a client is told beyond the stored row: whether the folder is a git
   * repository, by the same test `Worktrees.add` refuses on, and whether it is
   * the drafts folder. The flag is the last check's answer and never touches
   * the disk here: each answer starts the next check in the background, so a
   * folder that gained or lost its `.git` shows it on the following answer.
   * Before any check has answered, `repository` is left out.
   */
  private described(project: Project): Project {
    const flag = this.git.get(project.path);
    this.refreshGit(project.path);
    return {
      ...project,
      ...(flag?.value === undefined ? {} : { repository: flag.value }),
      ...(this.isDrafts(project) ? { kind: 'drafts' as const } : {}),
    };
  }

  private refreshGit(path: string): void {
    const flag = this.git.get(path) ?? { value: undefined, inflight: false };
    if (flag.inflight) return;
    flag.inflight = true;
    this.git.set(path, flag);
    // One check per folder at a time, held until the disk answers: a dead share
    // costs one pending check, never a pile of them.
    void this.gitProbe(path).then((found) => {
      flag.inflight = false;
      // No clear answer keeps the last one: a sleeping share is not a lost repository.
      if (found !== null) flag.value = found;
    });
  }
}

export function registerProjectMethods(core: Core): void {
  core.router.register('projects.browse', async ({ path }) => {
    if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path)))
      throw refused('projects.browse.path must be an absolute directory path');
    const full = resolve(path ?? homedir());
    try {
      const entries = await readdir(full, { withFileTypes: true });
      return {
        path: full,
        parent: dirname(full) === full ? null : dirname(full),
        directories: entries.filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: join(full, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (error) {
      throw refused(`projects.browse.path: cannot read directory "${full}": ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  core.router.register('projects.list', () => core.projects.list());
  core.router.register('projects.add', (params) => core.projects.add(params.path, params.name));
  core.router.register('projects.drafts', () => core.projects.drafts());
  core.router.register('projects.remove', async (params) => {
    await core.projects.remove(params.projectId);
    return { ok: true } as const;
  });
  core.router.register('projects.files', (params) =>
    core.projects.listFiles(params.projectId, params.query, params.limit),
  );
}
