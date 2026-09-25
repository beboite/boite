import type { Project, ProjectId } from '@boite/contracts';
import { strings } from '../strings';
import { work } from '../work-prefs.svelte';
import type { Draft } from '../store.svelte';
import type { StoreContext } from './context';

/** The projects in the sidebar, the draft a new thread starts as, and where the app lands. */
export class Projects {
  projects = $state<Project[]>([]);
  draft = $state<Draft | null>(null);
  collapsedProjects = $state<string[]>([]);
  /**
   * What the core reads from disk on each answer, whether a folder is a git
   * repository, can change while the app is open: a draft asks again, so its
   * worktree switch follows a `git init` done in a terminal. A failure keeps
   * the list the app has; the boot already reported a core that cannot answer.
   * A list the boot fetched under five seconds ago is fresh enough.
   */
  projectsAt = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** The project of the open thread or of the draft, the one the composer writes into. */
  get openProject(): Project | null {
    const id = this.ctx.store.openThread?.projectId ?? this.draft?.projectId ?? null;
    return id === null ? null : (this.projects.find((p) => p.id === id) ?? null);
  }

  /** The project `projects.drafts` made, once the core has made it. */
  get draftsProject(): Project | null {
    return this.projects.find((p) => p.kind === 'drafts') ?? null;
  }

  /** The drafts, whether the core has made them yet or not: where a draft with no project goes. */
  get draftInDrafts(): boolean {
    const draft = this.draft;
    if (!draft) return false;
    return draft.projectId === null || this.projects.find((p) => p.id === draft.projectId)?.kind === 'drafts';
  }

  isCollapsed(projectId: ProjectId): boolean {
    return this.collapsedProjects.includes(projectId);
  }

  toggleProject(projectId: ProjectId): void {
    this.collapsedProjects = this.ctx.store.isCollapsed(projectId)
      ? this.collapsedProjects.filter((id) => id !== projectId)
      : [...this.collapsedProjects, projectId];
  }

  /** Per core, so two machines each land on their own project. */
  #lastProjectKey(): string { return 'boite.lastProject.v1:' + JSON.stringify([this.ctx.store.endpointUrl, this.ctx.store.core?.dataDir]); }
  rememberProject(projectId: ProjectId): void {
    try { localStorage.setItem(this.#lastProjectKey(), projectId); } catch { /* storage unavailable: the recent thread decides */ }
  }

  /** The project last opened or drafted in on this device, else the one of the most recent thread, else the first. */
  lastProject(): ProjectId | null {
    let stored: string | null = null;
    try { stored = localStorage.getItem(this.#lastProjectKey()); } catch { /* storage unavailable */ }
    const known = this.projects.find((p) => p.id === stored);
    if (known) return known.id;
    const recent = this.ctx.store.threads.filter((t) => !t.archived && !t.parentThreadId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent?.projectId ?? this.projects[0]?.id ?? null;
  }

  /** Where the app opens: a new thread's draft in the last used project, as if New thread had been pressed. */
  async openLanding(): Promise<void> {
    const s = this.ctx.store;
    if (!s.visible) return;
    // Settings opened while the core was still answering stays open.
    if (s.openThread || this.draft || s.page !== 'chat') return;
    // The drafts, so the first screen is a composer, not a folder picker; or the last project.
    s.startDraft(work.current.startIn === 'drafts' ? null : s.lastProject());
  }

  /** The most recent thread, a draft in the first project, or nothing on a first run. */
  async openWhereLeft(): Promise<void> {
    const s = this.ctx.store;
    if (!s.visible) return;
    if (s.openThread || this.draft) return;
    const live = s.threads.filter((t) => !t.archived && !t.parentThreadId);
    const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      await s.open(recent.id);
      return;
    }
    s.startDraft(this.projects[0]?.id ?? null);
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** The native folder picker in the shell; a browser has no such thing and types a path. */
  async pickProject(): Promise<Project | null> {
    const s = this.ctx.store;
    if (!s.pickerAvailable) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== 'string' || picked.length === 0) return null;
      return await s.addProject(picked);
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  browseProjects(path?: string) {
    if (!this.ctx.client) throw new Error(strings.errors.noEndpoint);
    return this.ctx.client.call('projects.browse', path ? { path } : {});
  }

  async addProject(path: string): Promise<Project | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const project = await client.call('projects.add', { path });
      if (!this.projects.some((p) => p.id === project.id))
        this.projects = [...this.projects, project];
      this.ctx.store.startDraft(project.id);
      return project;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  /** Folders dropped on the window. The core refuses a file, and the toast says so. */
  async addProjects(paths: string[]): Promise<void> {
    const s = this.ctx.store;
    // Explorer paths belong to this computer even while a remote core is open.
    if (window.__TAURI_INTERNALS__ && !s.localCore) await s.useLocalCore();
    if (!s.owner || s.connection !== 'ready') return;
    let first: Project | null = null;
    for (const path of paths) {
      const project = await s.addProject(path);
      first ??= project;
    }
    if (first) s.startDraft(first.id);
  }

  async refreshProjects(): Promise<void> {
    const client = this.ctx.client;
    if (!client || this.ctx.store.connection !== 'ready' || Date.now() - this.projectsAt < 5_000) return;
    try {
      const fresh = new Map((await client.call('projects.list', {})).map((project) => [project.id, project]));
      // Another machine took this Store meanwhile: project ids can collide between machines.
      if (this.ctx.client !== client) return;
      if (this.projects.every((project) => project.repository === fresh.get(project.id)?.repository)) return;
      this.projects = this.projects.map((project) => fresh.get(project.id) ?? project);
    } catch {
      /* the list the app holds stays */
    }
  }

  /**
   * The drafts project, asked of the core on the first send into it. The core
   * makes the folder then, and the thread the send creates goes in it.
   */
  async ensureDrafts(): Promise<ProjectId | null> {
    const known = this.ctx.store.draftsProject;
    if (known) return known.id;
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const project = await client.call('projects.drafts', {});
      if (this.ctx.client !== client) return null;
      if (!this.projects.some((p) => p.id === project.id)) this.projects = [...this.projects, project];
      return project.id;
    } catch (error) {
      // A switched machine closed the old client: its rejection is not this machine's error.
      if (this.ctx.client === client) this.ctx.fail(error);
      return null;
    }
  }

  async removeProject(projectId: ProjectId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('projects.remove', { projectId });
      await this.dropProject(projectId);
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /** What a project going away costs the UI, whether this client removed it or another did. */
  async dropProject(projectId: ProjectId): Promise<void> {
    const s = this.ctx.store;
    this.projects = this.projects.filter((p) => p.id !== projectId);
    s.threads = s.threads.filter((t) => t.projectId !== projectId);
    if (s.openThread?.projectId === projectId) s.openThread = null;
    if (this.draft?.projectId === projectId) this.draft = null;
    await s.openWhereLeft();
  }

  // -------------------------------------------------------------------------
  // The draft
  // -------------------------------------------------------------------------

  /** An empty chat in a project, composer focused. Nothing reaches the core until the first send. */
  startDraft(projectId?: ProjectId | null): void {
    const s = this.ctx.store;
    const { threads, workbench } = this.ctx;
    // Named, a project; null, the drafts; unnamed, the project on screen, in
    // either preset, so work spread over several folders stays in its folder.
    // With nothing on screen, where this device opens: the drafts or the last project.
    const drafts = s.draftsProject?.id ?? null;
    const target = projectId === null ? drafts
      : projectId ?? s.openProject?.id ?? (work.current.startIn === 'drafts' ? drafts : s.lastProject());
    threads.rememberReadingThread();
    void threads.unsubscribe();
    threads.leaveArchived(null);
    s.openThread = null;
    s.draftChoice = null;
    s.trace = [];
    workbench.tracedThreadId = null;
    this.ctx.requests.keepRequestsOf(null);
    this.draft = { projectId: target, worktree: false };
    if (target !== null) this.rememberProject(target);
    void this.refreshProjects();
    s.page = 'chat';
    s.sidebarOpen = false;
  }

  /**
   * The draft moves to another project. Everything reading it follows on its
   * own (`openProject`, the composer's placeholder, the sidebar group), and a
   * folded project is opened, because a draft nobody can see is a lost draft.
   */
  setDraftProject(projectId: ProjectId | null): void {
    const draft = this.draft;
    const target = projectId ?? this.ctx.store.draftsProject?.id ?? null;
    if (!draft || draft.projectId === target) return;
    if (target !== null && !this.projects.some((p) => p.id === target)) return;
    const project = target === null ? null : this.projects.find((p) => p.id === target);
    // The drafts folder is no repository: the worktree switch does not follow the draft there.
    const drafts = target === null || project?.kind === 'drafts';
    this.draft = { projectId: target, worktree: drafts ? false : draft.worktree };
    if (target === null) return;
    this.rememberProject(target);
    this.collapsedProjects = this.collapsedProjects.filter((id) => id !== target);
  }

  /** The draft's worktree switch: on, the first send asks the core for a branch and a worktree. */
  setDraftWorktree(worktree: boolean): void {
    const draft = this.draft;
    if (!draft || draft.worktree === worktree) return;
    this.draft = { ...draft, worktree };
  }
}
