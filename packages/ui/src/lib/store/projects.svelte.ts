import type { Project, ProjectId } from '@boite/contracts';
import { strings } from '../strings';
import { work } from '../work-prefs.svelte';
import type { Draft } from '../store.svelte';
import type { StoreContext } from './context';
import { retainRows } from './snapshot-reads';

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
   * The draft the boot lands on reuses the list the boot fetched under five
   * seconds ago; a draft the user opens asks again, however soon after.
   */
  bootListAt = 0;
  #landing = false;

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
    const known = this.projects.find((p) => p.id === stored && p.archived !== true);
    if (known) return known.id;
    const recent = this.ctx.store.threads.filter((t) => !t.archived && !t.parentThreadId && !this.#inArchivedProject(t.projectId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent?.projectId ?? this.projects.find((p) => p.archived !== true)?.id ?? null;
  }

  /** Where the app opens: a new thread's draft in the last used project, as if New thread had been pressed. */
  async openLanding(): Promise<void> {
    const s = this.ctx.store;
    if (!s.visible) return;
    // Settings opened while the core was still answering stays open.
    if (s.openThread || this.draft || s.page !== 'chat') return;
    // The drafts, so the first screen is a composer, not a folder picker; or the last project.
    this.#land(() => s.startDraft(work.current.startIn === 'drafts' ? null : s.lastProject()));
  }

  #land(open: () => void): void {
    this.#landing = true;
    try { open(); } finally { this.#landing = false; }
  }

  /** The most recent thread, a draft in the first project, or nothing on a first run. */
  async openWhereLeft(): Promise<void> {
    const s = this.ctx.store;
    if (!s.visible || s.page !== 'chat') return;
    if (s.openThread || this.draft) return;
    const live = s.threads.filter((t) => !t.archived && !t.parentThreadId && !this.#inArchivedProject(t.projectId));
    const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      await s.open(recent.id);
      return;
    }
    this.#land(() => s.startDraft(this.projects.find((p) => p.archived !== true)?.id ?? null));
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** The native folder picker in the shell; a browser has no such thing and types a path. */
  async pickProject(options: { navigate?: boolean; current?: () => boolean } = {}): Promise<Project | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !s.pickerAvailable) return null;
    const generation = this.ctx.threads.openGeneration;
    const current = () => this.ctx.currentNavigation(client, generation) && (options.current?.() ?? true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      if (!current()) return null;
      const picked = await open({ directory: true, multiple: false });
      if (!current() || typeof picked !== 'string' || picked.length === 0) return null;
      return await s.addProject(picked, options);
    } catch (error) {
      if (current()) this.ctx.fail(error);
      return null;
    }
  }

  browseProjects(path?: string) {
    if (!this.ctx.client) throw new Error(strings.errors.noEndpoint);
    return this.ctx.client.call('projects.browse', path ? { path } : {});
  }

  async addProject(path: string, options: { navigate?: boolean } = {}): Promise<Project | null> {
    const client = this.ctx.client;
    if (!client) return null;
    const generation = this.ctx.threads.openGeneration;
    const clientGeneration = this.ctx.clientGeneration;
    try {
      const project = await client.call('projects.add', { path });
      if (this.ctx.client !== client || this.ctx.clientGeneration !== clientGeneration) return null;
      if (!this.projects.some((p) => p.id === project.id))
        this.projects = [...this.projects, project];
      if (options.navigate !== false && this.ctx.currentNavigation(client, generation)) this.ctx.store.startDraft(project.id);
      return project;
    } catch (error) {
      if (this.ctx.currentNavigation(client, generation)) this.ctx.fail(error);
      return null;
    }
  }

  /** Folders dropped on the window. The core refuses a file, and the toast says so. */
  async addProjects(paths: string[]): Promise<void> {
    const s = this.ctx.store;
    // Explorer paths belong to this computer even while a remote core is open.
    if (window.__TAURI_INTERNALS__ && !s.localCore) await s.useLocalCore();
    if (!s.owner || s.connection !== 'ready') return;
    const client = this.ctx.client;
    if (!client) return;
    const clientGeneration = this.ctx.clientGeneration;
    const navigation = this.ctx.threads.openGeneration;
    let first: Project | null = null;
    for (const path of paths) {
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      const project = await s.addProject(path, { navigate: false });
      first ??= project;
    }
    if (first && this.ctx.currentNavigation(client, navigation)) s.startDraft(first.id);
  }

  async refreshProjects(): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const fresh = this.#landing && Date.now() - this.bootListAt < 5_000;
    if (!client || this.ctx.store.connection !== 'ready' || fresh) return;
    const read = this.ctx.projectReads.begin();
    try {
      const listed = await client.call('projects.list', {});
      // Another machine took this Store meanwhile: project ids can collide between machines.
      if (!this.ctx.currentClient(client, clientGeneration) || !read.active) return;
      this.projects = retainRows(this.projects, read.apply(listed, this.projects));
    } catch {
      /* the list the app holds stays */
    } finally { read.cancel(); }
  }

  /**
   * The drafts project, asked of the core on the first send into it. The core
   * makes the folder then, and the thread the send creates goes in it.
   */
  async ensureDrafts(): Promise<ProjectId | null> {
    const known = this.ctx.store.draftsProject;
    if (known) return known.id;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const project = await client.call('projects.drafts', {});
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      if (!this.projects.some((p) => p.id === project.id)) this.projects = [...this.projects, project];
      return project.id;
    } catch (error) {
      // A switched machine closed the old client: its rejection is not this machine's error.
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return null;
    }
  }

  async removeProject(projectId: ProjectId): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      await client.call('projects.remove', { projectId });
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      await this.dropProject(projectId);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  /**
   * Puts a project away or brings it back. Put away, the screen leaves it:
   * the thread or draft that was open in it gives way to where the app lands.
   */
  async archiveProject(projectId: ProjectId, archived: boolean): Promise<boolean> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      const project = await client.call('projects.archive', { projectId, archived });
      if (!this.ctx.currentClient(client, clientGeneration)) return false;
      this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return false;
    }
    const s = this.ctx.store;
    if (archived && (s.openThread?.projectId === projectId || this.draft?.projectId === projectId)) {
      this.ctx.threads.invalidateNavigation();
      void this.ctx.threads.unsubscribe();
      this.ctx.drafts.park();
      if (s.openThread?.projectId === projectId) s.openThread = null;
      if (this.draft?.projectId === projectId) this.draft = null;
      await s.openWhereLeft();
    }
    return true;
  }

  /**
   * Project images fetched from this Store's core, by project and version. A
   * list names only the version; the bytes are asked for once, when a tile
   * first draws it, and a new version is a new key.
   */
  iconUrls = $state<Record<string, string>>({});
  #iconLoads = new Set<string>();

  /** The image of a project whose icon is one, once fetched; null until then, or when it has none. */
  projectIconUrl(project: Project): string | null {
    const icon = project.icon;
    return icon?.kind === 'image' ? (this.iconUrls[`${project.id}:${icon.version}`] ?? null) : null;
  }

  /** Fetches a project's image the first time a tile needs it. A failure leaves the initial. */
  async loadProjectIcon(project: Project): Promise<void> {
    const icon = project.icon;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (icon?.kind !== 'image' || !client) return;
    const key = `${project.id}:${icon.version}`;
    const loadKey = `${clientGeneration}:${key}`;
    if (this.iconUrls[key] !== undefined || this.#iconLoads.has(loadKey)) return;
    this.#iconLoads.add(loadKey);
    try {
      const answer = await client.call('projects.icon', { projectId: project.id });
      // Another machine took this Store meanwhile: project ids can collide between machines.
      if (!this.ctx.currentClient(client, clientGeneration) || !answer.dataUrl.startsWith('data:image/')) return;
      // The list may name an older version than the core now holds: the current
      // image answers for it too, or the tile would ask again for a key never filled.
      this.iconUrls = { ...this.iconUrls, [key]: answer.dataUrl, [`${project.id}:${answer.version}`]: answer.dataUrl };
    } catch {
      /* the initial stands */
    } finally {
      // Never left in flight: a refused or dropped answer is asked again by the next tile.
      this.#iconLoads.delete(loadKey);
    }
  }

  /** Asks the core to read the project's folder for its icon again. */
  async refreshProjectIcon(projectId: ProjectId): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      const project = await client.call('projects.refreshIcon', { projectId });
      if (this.ctx.currentClient(client, clientGeneration)) this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async setProjectWorktreeDefault(projectId: ProjectId, enabled: boolean): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      const project = await client.call('projects.setWorktreeDefault', { projectId, enabled });
      if (this.ctx.currentClient(client, clientGeneration)) this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  #archivePolicyWrites = $state<string[]>([]);

  projectAutoArchiveMergedPrBusy(projectId: ProjectId): boolean {
    return this.#archivePolicyWrites.includes(JSON.stringify([this.ctx.clientGeneration, projectId]));
  }

  async setProjectAutoArchiveMergedPr(projectId: ProjectId, enabled: boolean): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !this.ctx.store.owner || this.ctx.store.connection !== 'ready' || this.projects.find(project => project.id === projectId)?.autoArchiveMergedPr === undefined) return;
    const key = JSON.stringify([clientGeneration, projectId]);
    if (this.#archivePolicyWrites.includes(key)) return;
    this.#archivePolicyWrites = [...this.#archivePolicyWrites, key];
    try {
      const project = await client.call('projects.setAutoArchiveMergedPr', { projectId, enabled });
      if (this.ctx.currentClient(client, clientGeneration)) this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    } finally {
      this.#archivePolicyWrites = this.#archivePolicyWrites.filter(pending => pending !== key);
    }
  }

  /** A project as the core now answers it, from this client's call or another's `project.updated`. */
  upsertProject(project: Project): void {
    this.ctx.projectReads.change(project.id, project);
    const index = this.projects.findIndex((p) => p.id === project.id);
    if (index >= 0) this.projects[index] = project;
    else this.projects = [...this.projects, project];
  }

  /** Whether a thread's project is put away, so the landing never picks it. */
  #inArchivedProject(projectId: ProjectId | null): boolean {
    return projectId !== null && this.projects.some((p) => p.id === projectId && p.archived === true);
  }

  /** What a project going away costs the UI, whether this client removed it or another did. */
  async dropProject(projectId: ProjectId): Promise<void> {
    this.ctx.projectReads.change(projectId, null);
    const s = this.ctx.store;
    this.ctx.drafts.forget(projectId);
    for (const thread of s.threads.filter(t => t.projectId === projectId)) delete s.composerStates[thread.id];
    this.projects = this.projects.filter((p) => p.id !== projectId);
    s.threads = s.threads.filter((t) => t.projectId !== projectId);
    if (s.openThread?.projectId === projectId || this.draft?.projectId === projectId) {
      this.ctx.threads.invalidateNavigation();
      void this.ctx.threads.unsubscribe();
      if (s.openThread?.projectId === projectId) s.openThread = null;
      if (this.draft?.projectId === projectId) this.draft = null;
    }
    await s.openWhereLeft();
  }

  // -------------------------------------------------------------------------
  // The draft
  // -------------------------------------------------------------------------

  /** An empty chat in a project, composer focused. Nothing reaches the core until the first send. */
  startDraft(projectId?: ProjectId | null, options: { refresh?: boolean } = {}): void {
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
    s.trace = [];
    workbench.tracedThreadId = null;
    this.ctx.requests.keepRequestsOf(null);
    this.ctx.drafts.resume(target);
    this.ctx.drafts.persist();
    if (target !== null) this.collapsedProjects = this.collapsedProjects.filter(id => id !== target);
    if (target !== null) this.rememberProject(target);
    if (options.refresh !== false) void this.refreshProjects();
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
    if (this.ctx.drafts.has(target)) { this.ctx.store.error = strings.errors.draftExists; return; }
    const project = target === null ? null : this.projects.find((p) => p.id === target);
    // The drafts folder is no repository: the worktree switch does not follow the draft there.
    const drafts = target === null || project?.kind === 'drafts';
    this.ctx.drafts.forget(draft.projectId);
    const { incognito, ...kept } = draft;
    this.draft = { ...kept, ...(incognito && drafts ? { incognito } : {}), projectId: target, worktree: drafts || project?.repository !== true ? false : draft.worktreeExplicit ? draft.worktree : project?.worktreeDefault === true };
    if (target === null) return;
    this.rememberProject(target);
    this.collapsedProjects = this.collapsedProjects.filter((id) => id !== target);
  }

  /** The draft's incognito switch, offered in the drafts only. */
  setDraftIncognito(incognito: boolean): void {
    const draft = this.draft;
    if (!draft || (incognito && !this.draftInDrafts)) return;
    const { incognito: _was, ...rest } = draft;
    this.draft = incognito ? { ...rest, incognito: true } : rest;
  }

  /** The draft's worktree switch: on, the first send asks the core for a branch and a worktree. */
  setDraftWorktree(worktree: boolean): void {
    const draft = this.draft;
    if (!draft) return;
    this.draft = { ...draft, worktree, worktreeExplicit: true };
  }
}
