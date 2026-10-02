import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { TECH_ICON_IDS, type Project, type ProjectIcon, type ProjectId, type TechIconId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { folderGone, messageOf, notFound, refused } from './errors.ts';
import { FileIndex } from './files.ts';
import { documentsDir } from './platform/folders.ts';
import { threadTerminalId } from './terminals.ts';
import type { FilesPage } from './files.ts';
import type { ProjectIconRow } from './journal/rows.ts';
import { detectProjectIcon, type DetectedIcon } from './project-icons.ts';

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

/**
 * Whether `folder` is still a directory, off the event loop: true, false, or
 * null when the disk gave no clear answer. A file in its place is not a folder.
 */
export function probeFolder(folder: string): Promise<boolean | null> {
  return stat(folder).then(
    (found) => found.isDirectory(),
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

/** How long one icon detection may read the folder before it is given up. */
export const ICON_DETECT_TIMEOUT_MS = 5_000;
/** Detections running at once in the background. */
const ICON_WORKERS = 2;

/** What a client is told of a stored icon: an image's version or a stack's id, nothing for none. */
function iconOf(row: ProjectIconRow | undefined): ProjectIcon | undefined {
  if (row?.kind === 'image' && row.version !== null) return { kind: 'image', version: row.version };
  if (row?.kind === 'tech' && (TECH_ICON_IDS as readonly string[]).includes(row.tech ?? '')) return { kind: 'tech', id: row.tech as TechIconId };
  return undefined;
}

function rowOf(icon: DetectedIcon): ProjectIconRow {
  if (icon.kind === 'image') return { kind: 'image', tech: null, version: icon.version };
  if (icon.kind === 'tech') return { kind: 'tech', tech: icon.id, version: null };
  return { kind: 'none', tech: null, version: null };
}

/** What two spellings of one folder share: the path itself, lowercased where the file system ignores case. */
function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

interface GitFlag {
  value: boolean | undefined;
  /** The folder itself is gone. Undefined before a check gave a clear answer. */
  missing?: boolean | undefined;
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
  /** Replaced by a test to hold or fail the folder check. */
  folderProbe: (folder: string) => Promise<boolean | null> = probeFolder;
  /** How long `projects.list` waits for the checks it starts; lowered by a test. */
  gitWaitMs = GIT_PROBE_TIMEOUT_MS;
  /** Replaced by a test to count or hold detections. */
  iconDetect: (folder: string) => Promise<DetectedIcon> = detectProjectIcon;
  /** How long a detection may take; lowered by a test. */
  iconWaitMs = ICON_DETECT_TIMEOUT_MS;
  /** Projects waiting for a background detection, and every one queued since this core started. */
  private readonly iconQueue: ProjectId[] = [];
  private readonly iconQueued = new Set<ProjectId>();
  private iconWorkers = 0;
  private iconSweepDone = false;

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
    const existing = this.list().find((project) => this.isDrafts(project));
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

  /** Compared the way `add` dedupes: the drafts folder registered in another case is still the drafts. */
  isDrafts(project: Project): boolean {
    return pathKey(project.path) === pathKey(this.draftsPath());
  }

  /** The files a mention can name, ranked on the query. */
  listFiles(projectId: ProjectId, query: string, limit?: number): Promise<FilesPage> {
    const project = this.require(projectId);
    if (typeof query !== 'string') throw refused('projects.files wants a string query', { projectId });
    return this.files.list(project.path, query, limit);
  }

  list(): Project[] {
    const counts = this.core.journal.archivedThreadCounts();
    const icons = this.core.journal.projectIcons();
    return this.core.journal.listProjects().map((project) => this.described(project, true, counts, icons));
  }

  /**
   * The list a client asks for, with a fresh `.git` answer per folder: a
   * `git init` done in a terminal shows on the very next answer. Each check
   * runs off the event loop and gets `gitWaitMs`; past it, or when a folder's
   * previous check is still pending (a share whose host is gone), that folder
   * answers from its last check instead of holding the list.
   */
  async listFresh(): Promise<Project[]> {
    const projects = this.core.journal.listProjects();
    const checks: Promise<void>[] = [];
    for (const project of projects) {
      const check = this.refreshGit(project.path);
      if (check !== null) checks.push(check);
    }
    if (checks.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.gitWaitMs);
        timer.unref?.();
      });
      await Promise.race([Promise.all(checks), deadline]);
      clearTimeout(timer);
    }
    // Every folder was just checked or is still being checked: no second probe.
    const counts = this.core.journal.archivedThreadCounts();
    const icons = this.core.journal.projectIcons();
    const answer = this.core.journal.listProjects().map((project) => this.described(project, false, counts, icons));
    // Icons come from the journal only. A project never checked, or checked
    // with nothing found, is detected once per core in the background, after
    // this answer has left: a client hears `project.updated` when one appears.
    if (!this.iconSweepDone) {
      this.iconSweepDone = true;
      for (const project of answer) {
        const row = icons.get(project.id);
        if (!this.isDrafts(project) && (row === undefined || row.kind === 'none')) this.queueIcon(project.id);
      }
    }
    return answer;
  }

  /**
   * Detects a project's icon again, stores it and answers the project;
   * `project.updated` follows when what clients see changed. Refused when the
   * folder could not be read in time, the stored icon left as it was.
   */
  async refreshIcon(projectId: ProjectId): Promise<Project> {
    const project = this.require(projectId);
    const outcome = await this.detectIcon(projectId);
    if (outcome === 'timeout') {
      throw refused(`the project's folder could not be read within ${this.iconWaitMs} ms; its icon is unchanged`, { field: 'projectId', projectId, path: project.path });
    }
    return this.require(projectId);
  }

  /** The stored image of a project whose icon is one, as a data URL. Never reads the folder. */
  iconImage(projectId: ProjectId): { version: string; dataUrl: string } {
    this.require(projectId);
    const image = this.core.journal.projectIconImage(projectId);
    if (image === null) {
      throw refused('projects.icon: this project has no image icon; its icon field says which kind it has', { field: 'projectId', projectId, expected: "a project whose icon.kind is 'image'" });
    }
    return { version: image.version, dataUrl: `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}` };
  }

  /** Queues a background detection, at most once per project per core. */
  private queueIcon(projectId: ProjectId): void {
    if (this.iconQueued.has(projectId)) return;
    this.iconQueued.add(projectId);
    this.iconQueue.push(projectId);
    while (this.iconWorkers < ICON_WORKERS && this.iconWorkers < this.iconQueue.length) {
      this.iconWorkers += 1;
      void this.iconWorker();
    }
  }

  private async iconWorker(): Promise<void> {
    try {
      // Off the caller's turn: an add or a list answers before any folder is read.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let next = this.iconQueue.shift(); next !== undefined && !this.core.stopping; next = this.iconQueue.shift()) {
        await this.detectIcon(next).catch(() => undefined);
      }
    } finally {
      this.iconWorkers -= 1;
    }
  }

  /** One detection, stored, and announced when what a client sees moved. */
  private async detectIcon(projectId: ProjectId): Promise<'changed' | 'same' | 'timeout' | 'gone'> {
    if (this.core.stopping) return 'gone';
    const project = this.core.journal.getProject(projectId);
    if (project === null) return 'gone';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.iconWaitMs);
      timer.unref?.();
    });
    const found = await Promise.race([this.iconDetect(project.path).catch(() => null), deadline]);
    clearTimeout(timer);
    if (this.core.stopping || this.removing.has(projectId) || this.core.journal.getProject(projectId) === null) return 'gone';
    if (found === null) return 'timeout';
    const before = JSON.stringify(iconOf(this.core.journal.projectIcons().get(projectId)) ?? null);
    this.core.journal.putProjectIcon(projectId, found, Date.now());
    if (JSON.stringify(iconOf(rowOf(found)) ?? null) === before) return 'same';
    this.announce(projectId);
    return 'changed';
  }

  /**
   * A project named by id, by name (any case) or by its absolute folder, among
   * the ones the owner added. `method` and `field` name the parameter in a
   * refusal; a name two projects share is refused with both ids.
   */
  find(query: unknown, method: string, field: string, context: Record<string, unknown> = {}): Project {
    const expected = 'the id, name or absolute folder of a project added to Boite';
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw refused(`${method}.${field} must name a project`, { ...context, field, expected });
    }
    const wanted = query.trim();
    const projects = this.core.journal.listProjects();
    const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text);
    const byId = projects.find((project) => project.id === wanted);
    const byPath = isAbsolute(wanted) ? projects.find((project) => fold(resolve(project.path)) === fold(resolve(wanted))) : undefined;
    const byName = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase());
    if (byId === undefined && byPath === undefined && byName.length > 1) {
      throw refused(`${byName.length} projects are named ${wanted}; name one by its id or folder`, {
        ...context, field, project: wanted, candidates: byName.map((project) => ({ id: project.id, path: project.path })), expected: 'a project id or folder',
      });
    }
    const found = byId ?? byPath ?? byName[0];
    if (found === undefined) throw notFound(`no project ${wanted} in Boite`, { ...context, field, project: wanted, expected });
    return this.require(found.id);
  }

  require(projectId: ProjectId | null): Project {
    if (projectId === null) throw refused('this agent session has no project');
    if (this.removing.has(projectId)) throw refused('this project is being removed', { projectId });
    const project = this.core.journal.getProject(projectId);
    if (project === null) throw notFound(`unknown project ${projectId}`, { projectId });
    return this.described(project);
  }

  /**
   * The project, once its folder answered as a directory. Refused by the
   * folder when it is gone, and every client hears the project is `missing`;
   * a disk that gave no clear answer passes, as it does for the `.git` check.
   * The drafts folder is made on demand and never refused here.
   */
  async requireFolder(projectId: ProjectId): Promise<Project> {
    const project = this.require(projectId);
    if (this.isDrafts(project)) return project;
    const present = await this.folderProbe(project.path).catch(() => null);
    if (present === null) return project;
    this.noteFolder(project.path, !present);
    if (!present) {
      throw folderGone(project.path, { field: 'projectId', projectId, project: project.name });
    }
    return project;
  }

  /** Records what a check said of a folder and tells the clients when a project appeared or vanished. */
  private noteFolder(path: string, missing: boolean): void {
    const flag = this.git.get(path) ?? { value: undefined, inflight: false };
    const before = flag.missing;
    flag.missing = missing;
    if (missing) flag.value = false;
    this.git.set(path, flag);
    // The first answer of a folder that is there changes nothing a client drew.
    if (before === missing || (before === undefined && !missing) || this.core.stopping) return;
    for (const project of this.core.journal.listProjects()) {
      if (project.path === path && !this.removing.has(project.id)) this.announce(project.id);
    }
  }

  /** The project a folder already is, archived ones included, or null. */
  registered(path: string): Project | null {
    const key = pathKey(resolve(path));
    const existing = this.core.journal.listProjects().find((project) => pathKey(project.path) === key);
    return existing === undefined ? null : this.described(existing);
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

    // Windows paths ignore case, so `d:\dev\app` is the project `D:\Dev\App`
    // already registered. The git flag is keyed by the stored spelling, the
    // one `described` and `refreshGit` read.
    const key = pathKey(full);
    const existing = this.core.journal.listProjects().find((project) => pathKey(project.path) === key);
    // The folder just answered, so this check does too; the answer is exact from the start.
    this.git.set(existing?.path ?? full, { value: existsSync(join(full, '.git')), missing: false, inflight: false });
    // No second check of a folder that was just checked.
    if (existing !== undefined) return this.described(existing, false);

    const project: Project = {
      id: newId('prj_'),
      name: name !== undefined && name.length > 0 ? name : basename(full),
      path: full,
      createdAt: Date.now(),
    };
    this.core.journal.append({ type: 'project.added', threadId: null, version: 1, payload: project }, () => {
      this.core.journal.putProject(project);
    });
    const answered = this.described(project, false);
    this.core.bus.emit('project.added', answered);
    // Its icon is read after this answer, in the background; `project.updated` brings it.
    if (!this.isDrafts(project)) this.queueIcon(project.id);
    return answered;
  }

  /**
   * Puts a project away or brings it back. Only the flag moves: its threads,
   * their processes and its folder stay as they are, so a restore is exact.
   */
  archive(projectId: ProjectId, archived: boolean): Project {
    const project = this.require(projectId);
    if (typeof archived !== 'boolean') throw refused('projects.archive.archived must be a boolean', { field: 'archived', expected: 'true or false' });
    if (archived && this.isDrafts(project)) {
      throw refused('the drafts project cannot be archived: a thread with no folder lands in it', { field: 'projectId', projectId, expected: 'a project other than the drafts' });
    }
    if ((project.archived === true) === archived) return project;
    const next: Project = { id: project.id, name: project.name, path: project.path, createdAt: project.createdAt, ...(archived ? { archived: true } : {}), ...(project.worktreeDefault ? { worktreeDefault: true } : {}) };
    this.core.journal.append({ type: 'project.archived', threadId: null, version: 1, payload: { projectId, archived } }, () => {
      this.core.journal.putProject(next);
    });
    return this.announce(projectId);
  }

  setAutoArchiveMergedPr(projectId: ProjectId, enabled: boolean): Project {
    this.require(projectId);
    if (typeof enabled !== 'boolean') throw refused('projects.setAutoArchiveMergedPr.enabled must be a boolean', { field: 'enabled', expected: 'true or false' });
    this.core.journal.append({ type: 'project.autoArchiveMergedPrChanged', threadId: null, version: 1, payload: { projectId, enabled } }, () => this.core.journal.setSetting(`project-auto-archive-merged-pr:${projectId}`, enabled));
    return this.announce(projectId);
  }

  async setWorktreeDefault(projectId: ProjectId, enabled: boolean): Promise<Project> {
    const project = this.require(projectId);
    if (typeof enabled !== 'boolean') throw refused('projects.setWorktreeDefault.enabled must be a boolean', { field: 'enabled', expected: 'true or false' });
    if (enabled && !this.isDrafts(project)) await this.requireFolder(projectId);
    if (enabled && (this.isDrafts(project) || await hasGitMarker(project.path) !== true)) {
      throw refused('projects.setWorktreeDefault.projectId must name a Git repository', { field: 'projectId', projectId, expected: 'a Git repository other than the drafts project' });
    }
    // Re-read after the disk check so a concurrent archive retains its flag.
    const current = this.require(projectId);
    if ((current.worktreeDefault === true) === enabled) return current;
    this.core.journal.append({ type: 'project.worktreeDefaultChanged', threadId: null, version: 1, payload: { projectId, enabled } }, () => {
      this.core.journal.putProject({ ...current, worktreeDefault: enabled });
    });
    return this.announce(projectId);
  }

  /** Tells every client how a project now reads, after anything its answer counts has moved. */
  announce(projectId: ProjectId): Project {
    const stored = this.core.journal.getProject(projectId);
    if (stored === null) throw notFound(`unknown project ${projectId}`, { projectId });
    const answered = this.described(stored, false);
    this.core.bus.emit('project.updated', answered);
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
      await this.core.threads.codeCheckpoints.discard(threadIds).catch(error => {
        this.core.log('warn', `file checkpoints of removed project ${projectId} were not deleted: ${messageOf(error)}`);
      });
      for (const threadId of threadIds) this.core.bus.emit('thread.removed', { threadId });
      this.core.bus.emit('project.removed', { projectId });
      this.core.bus.emit('thread.deletionsUpdated', {});
      this.files.forget(project.path);
      this.git.delete(project.path);
      this.iconQueued.delete(projectId);
    } finally {
      this.removing.delete(projectId);
    }
  }

  /**
   * What a client is told beyond the stored row: whether the folder is a git
   * repository, by the same test `Worktrees.add` refuses on, and whether it is
   * the drafts folder. The flag is the last check's answer and never touches
   * the disk here: each answer starts the next check in the background, so a
   * folder that gained or lost its `.git` shows it on the following answer
   * (`listFresh` waits for it instead). Before any check has answered,
   * `repository` is left out. `archivedThreads` is counted here too, once
   * per list when the caller hands the counts over, and the icon is the one
   * stored by the last detection, read from the journal, never the folder.
   */
  private described(
    project: Project,
    refresh = true,
    counts = this.core.journal.archivedThreadCounts(),
    icons = this.core.journal.projectIcons(),
  ): Project {
    const flag = this.git.get(project.path);
    if (refresh) this.refreshGit(project.path);
    const archivedThreads = counts.get(project.id) ?? 0;
    const icon = iconOf(icons.get(project.id));
    return {
      ...project,
      autoArchiveMergedPr: this.core.journal.getSetting(`project-auto-archive-merged-pr:${project.id}`) !== false,
      ...(archivedThreads > 0 ? { archivedThreads } : {}),
      ...(icon === undefined ? {} : { icon }),
      ...(flag?.value === undefined ? {} : { repository: flag.value }),
      ...(flag?.missing === true ? { missing: true } : {}),
      ...(this.isDrafts(project) ? { kind: 'drafts' as const } : {}),
    };
  }

  /** Starts a check of `path`, or returns null when one is already pending. */
  private refreshGit(path: string): Promise<void> | null {
    const flag = this.git.get(path) ?? { value: undefined, inflight: false };
    if (flag.inflight) return null;
    flag.inflight = true;
    this.git.set(path, flag);
    // One check per folder at a time, held until the disk answers: a dead share
    // costs one pending check, never a pile of them.
    return this.gitProbe(path).then(
      async (found) => {
        // No clear answer keeps the last one: a sleeping share is not a lost repository.
        if (found !== null) flag.value = found;
        // A `.git` that answered sits in a folder that is there; without one the folder itself is asked.
        const present = found === true ? true : found === false ? await this.folderProbe(path).catch(() => null) : null;
        flag.inflight = false;
        if (present !== null && this.git.get(path) === flag) this.noteFolder(path, !present);
      },
      () => {
        flag.inflight = false;
      },
    );
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
  core.router.register('projects.list', () => core.projects.listFresh());
  core.router.register('projects.add', (params) => core.projects.add(params.path, params.name));
  core.router.register('projects.drafts', () => core.projects.drafts());
  core.router.register('projects.icon', (params) => core.projects.iconImage(params.projectId));
  core.router.register('projects.refreshIcon', (params) => core.projects.refreshIcon(params.projectId));
  core.router.register('projects.setAutoArchiveMergedPr', params => core.projects.setAutoArchiveMergedPr(params.projectId, params.enabled));
  core.router.register('projects.setWorktreeDefault', (params) => core.projects.setWorktreeDefault(params.projectId, params.enabled));
  core.router.register('projects.archive', (params) => core.projects.archive(params.projectId, params.archived ?? true));
  core.router.register('projects.remove', async (params) => {
    await core.projects.remove(params.projectId);
    return { ok: true } as const;
  });
  core.router.register('projects.files', (params) =>
    core.projects.listFiles(params.projectId, params.query, params.limit),
  );
}
