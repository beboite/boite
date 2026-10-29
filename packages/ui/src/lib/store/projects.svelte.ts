import type { Project, ProjectId } from '@boite/contracts';
import { wasDropped } from '../client';
import { strings } from '../strings';
import { work } from '../work-prefs.svelte';
import type { Draft } from '../store.svelte';
import type { StoreContext } from './context';
import { retainRows } from './snapshot-reads';
import { created, draftKey } from './drafts.svelte';
import { secureId } from '../secure-id';

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
    this.#fold(this.ctx.store.isCollapsed(projectId)
      ? this.collapsedProjects.filter((id) => id !== projectId)
      : [...this.collapsedProjects, projectId]);
  }

  /** A project something must show (a draft in it, a thread moved there) opens, and stays open after a restart. */
  unfold(projectId: ProjectId): void {
    if (this.isCollapsed(projectId)) this.#fold(this.collapsedProjects.filter((id) => id !== projectId));
  }

  /**
   * Folds belong to this device and survive a restart. Per core, like the drafts:
   * project ids can collide between machines, and the shell's own core may change port.
   */
  #foldsKey(): string {
    const s = this.ctx.store;
    return 'boite.foldedProjects.v1:' + JSON.stringify([s.localCore ? 'local' : s.machineId || s.endpointUrl, s.core?.hostname, s.core?.dataDir]);
  }

  #fold(ids: string[]): void {
    this.collapsedProjects = ids;
    try {
      if (ids.length === 0) localStorage.removeItem(this.#foldsKey());
      else localStorage.setItem(this.#foldsKey(), JSON.stringify(ids));
    } catch { /* storage unavailable: the folds last until the app closes */ }
  }

  /** A project removed while this device was away leaves the folds once the machine lists its projects. */
  pruneFolds(): void {
    const listed = new Set(this.projects.map((p) => p.id));
    const kept = this.collapsedProjects.filter((id) => listed.has(id));
    if (kept.length !== this.collapsedProjects.length) this.#fold(kept);
  }

  /** The folds this device left on the core that just answered. Unreadable storage keeps the ones on screen. */
  restoreFolds(): void {
    let stored: unknown;
    try { stored = JSON.parse(localStorage.getItem(this.#foldsKey()) ?? '[]'); } catch { return; }
    this.collapsedProjects = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
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
    // An agent's own thread belongs to the Agents page: the chat starts from the threads around it.
    if ((s.openThread && !s.openThread.agentSessionId) || this.draft) return;
    const live = s.threads.filter((t) => !t.archived && !t.parentThreadId && !t.agentSessionId && !this.#inArchivedProject(t.projectId));
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
      this.pruneFolds();
    } catch {
      /* the list the app holds stays */
    } finally { read.cancel(); }
  }

  /**
   * The drafts project, asked of the core on the first send into it. The core
   * makes the folder then, and the thread the send creates goes in it.
   */
  /** `quiet`: a background start that tries again later, so a failure is not the user's to read. */
  async ensureDrafts(options: { quiet?: boolean } = {}): Promise<ProjectId | null> {
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
      if (this.ctx.currentClient(client, clientGeneration) && !options.quiet) this.ctx.fail(error);
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
   * A machine that is not connected still shows the projects it last sent:
   * the choice is kept on this device and sent when the machine is back.
   */
  async archiveProject(projectId: ProjectId, archived: boolean): Promise<boolean> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return false;
    if (client.state !== 'ready') {
      const project = this.projects.find((p) => p.id === projectId);
      if (!project) return false;
      this.#writePending({ ...this.#readPending(), [projectId]: archived });
      this.upsertProject(withArchived(project, archived));
    } else {
      try {
        const project = await client.call('projects.archive', { projectId, archived });
        if (!this.ctx.currentClient(client, clientGeneration)) return false;
        this.upsertProject(project);
      } catch (error) {
        if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
        return false;
      }
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

  /** Per core, like the last project: archive choices made while it was away. */
  #pendingKey(): string { return 'boite.pendingArchive.v1:' + JSON.stringify([this.ctx.store.endpointUrl, this.ctx.store.core?.dataDir]); }
  #readPending(): Record<string, boolean> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.#pendingKey()) ?? '{}');
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
    } catch {
      return {};
    }
  }
  #writePending(pending: Record<string, boolean>): void {
    try {
      if (Object.keys(pending).length === 0) localStorage.removeItem(this.#pendingKey());
      else localStorage.setItem(this.#pendingKey(), JSON.stringify(pending));
    } catch { /* storage unavailable: the choice lasts until this client reloads */ }
  }

  /**
   * A list the machine sent on reconnect, with the archive choices made while
   * it was away laid over it, so the sidebar does not show them undone while
   * they are sent.
   */
  withPendingArchives(projects: Project[]): Project[] {
    const pending = this.#readPending();
    if (Object.keys(pending).length === 0) return projects;
    return projects.map((project) => {
      const archived = pending[project.id];
      return archived === undefined ? project : withArchived(project, archived);
    });
  }

  /**
   * Sends the archive choices made while the machine was away. A project the
   * machine no longer lists drops its choice; a call the connection lost keeps
   * it for the next reconnect.
   */
  sendPendingArchives(listed: Project[]): Promise<void> {
    // Two loads close together would send the same choice twice.
    this.#sending = this.#sending.then(() => this.#sendPending(listed));
    return this.#sending;
  }
  #sending: Promise<void> = Promise.resolve();

  async #sendPending(listed: Project[]): Promise<void> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    const pending = this.#readPending();
    if (!client || Object.keys(pending).length === 0) return;
    const byId = new Map(listed.map((p) => [p.id, p]));
    for (const [projectId, archived] of Object.entries(pending)) {
      if (!this.ctx.currentClient(client, generation) || client.state !== 'ready') return;
      const listedProject = byId.get(projectId);
      if (listedProject) {
        try {
          const project = await client.call('projects.archive', { projectId, archived });
          if (this.ctx.currentClient(client, generation)) this.upsertProject(project);
        } catch (error) {
          // Lost with the connection: the next reconnect sends it again.
          if (wasDropped(error) || client.state !== 'ready' || !this.ctx.currentClient(client, generation)) return;
          // Refused: the machine's own state stands.
          this.ctx.fail(error);
          this.upsertProject(listedProject);
        }
      }
      const rest = this.#readPending();
      if (rest[projectId] === archived) {
        delete rest[projectId];
        this.#writePending(rest);
      }
    }
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

  async renameProject(projectId: ProjectId, name: string): Promise<void> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return;
    try {
      const project = await client.call('projects.rename', { projectId, name });
      if (this.ctx.currentClient(client, generation)) this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, generation)) this.ctx.fail(error);
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

  /** Project policy writes under way, by policy, client generation and project. */
  #policyWrites = $state<string[]>([]);

  projectAutoArchiveMergedPrBusy(projectId: ProjectId): boolean {
    return this.#policyWrites.includes(JSON.stringify(['merged', this.ctx.clientGeneration, projectId]));
  }

  projectAutoRemoveWorktreesBusy(projectId: ProjectId): boolean {
    return this.#policyWrites.includes(JSON.stringify(['worktrees', this.ctx.clientGeneration, projectId]));
  }

  setProjectAutoArchiveMergedPr(projectId: ProjectId, enabled: boolean): Promise<void> {
    return this.#setPolicy('merged', projectId, (project) => project.autoArchiveMergedPr !== undefined,
      (client) => client.call('projects.setAutoArchiveMergedPr', { projectId, enabled }));
  }

  /** Settled worktrees removed on their own; absent on a core that cannot. */
  setProjectAutoRemoveWorktrees(projectId: ProjectId, enabled: boolean): Promise<void> {
    return this.#setPolicy('worktrees', projectId, (project) => project.autoRemoveWorktrees !== undefined,
      (client) => client.call('projects.setAutoRemoveWorktrees', { projectId, enabled }));
  }

  async #setPolicy(policy: string, projectId: ProjectId, known: (project: Project) => boolean, write: (client: NonNullable<StoreContext['client']>) => Promise<Project>): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const current = this.projects.find(project => project.id === projectId);
    if (!client || !this.ctx.store.owner || this.ctx.store.connection !== 'ready' || !current || !known(current)) return;
    const key = JSON.stringify([policy, clientGeneration, projectId]);
    if (this.#policyWrites.includes(key)) return;
    this.#policyWrites = [...this.#policyWrites, key];
    try {
      const project = await write(client);
      if (this.ctx.currentClient(client, clientGeneration)) this.upsertProject(project);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    } finally {
      this.#policyWrites = this.#policyWrites.filter(pending => pending !== key);
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
    this.ctx.drafts.forgetProject(projectId);
    for (const thread of s.threads.filter(t => t.projectId === projectId)) delete s.composerStates[thread.id];
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.unfold(projectId);
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

  /**
   * A chat in a project, composer focused. Nothing reaches the core until the
   * first send. `draftId` reopens that saved draft, in its own project;
   * `fresh` opens an empty one beside the project's other drafts; neither
   * resumes the project's most recently parked draft.
   */
  startDraft(projectId?: ProjectId | null, options: { refresh?: boolean; fresh?: boolean; draftId?: string } = {}): void {
    const s = this.ctx.store;
    const { threads, workbench } = this.ctx;
    // Named, a project; null, the drafts; unnamed, the project on screen, in
    // either preset, so work spread over several folders stays in its folder.
    // With nothing on screen, where this device opens: the drafts or the last project.
    const drafts = s.draftsProject?.id ?? null;
    const owner = options.draftId === undefined ? undefined : this.ctx.drafts.projectOf(options.draftId);
    const draftId = owner === undefined ? undefined : options.draftId;
    // A draft gone since its row was drawn (deleted, sent) opens an empty one, never another parked draft.
    const fresh = options.fresh === true || (options.draftId !== undefined && owner === undefined);
    const target = owner !== undefined ? owner : projectId === null ? drafts
      : projectId ?? s.openProject?.id ?? (work.current.startIn === 'drafts' ? drafts : s.lastProject());
    threads.rememberReadingThread();
    void threads.unsubscribe();
    threads.leaveArchived(null);
    s.openThread = null;
    s.trace = [];
    workbench.tracedThreadId = null;
    this.ctx.requests.keepRequestsOf(null);
    this.ctx.drafts.resume(target, { fresh, ...(draftId === undefined ? {} : { draftId }) });
    this.ctx.drafts.persist();
    if (target !== null) this.unfold(target);
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
    const project = target === null ? null : this.projects.find((p) => p.id === target);
    // The drafts folder is no repository: the worktree switch does not follow the draft there.
    const drafts = target === null || project?.kind === 'drafts';
    // An accepted start owns its privacy and queue until it is cancelled or launched.
    if (draft.incognito && !drafts && !this.ctx.sync.admitPrivacyChange(draftKey(draft))) return;
    // Its saved copy, if any, still names the old project: the open draft replaces it.
    this.ctx.drafts.forget(draftKey(draft));
    const { incognito, ...kept } = this.#withPrivacy(draft, !!draft.incognito && drafts);
    // A draft keeps its id; one opened before ids existed gets one and a creation time, so its old project key stays that project's.
    this.draft = { ...kept, ...(draft.id ? {} : { id: secureId(), createdAt: created() }), ...(incognito && drafts ? { incognito } : {}), projectId: target, worktree: drafts || project?.repository !== true ? false : draft.worktreeExplicit ? draft.worktree : project?.worktreeDefault === true };
    if (target === null) return;
    this.rememberProject(target);
    this.unfold(target);
  }

  /** The draft's incognito switch, offered in the drafts only. */
  setDraftIncognito(incognito: boolean): void {
    const draft = this.draft;
    if (!draft || !!draft.incognito === incognito || (incognito && !this.draftInDrafts)) return;
    if (!this.ctx.sync.admitPrivacyChange(draftKey(draft))) return;
    this.draft = this.#withPrivacy(draft, incognito);
    this.ctx.drafts.persist();
  }

  /** Privacy belongs to one composer identity on the core, so changing it retires that record. */
  #withPrivacy(draft: Draft, incognito: boolean): Draft {
    if (!!draft.incognito === incognito) return draft;
    const previous = draftKey(draft);
    this.ctx.drafts.forget(previous);
    this.ctx.sync.touched('drafts', previous, true);
    const { incognito: _was, ...rest } = draft;
    const next = { ...rest, id: secureId(), ...(incognito ? { incognito: true as const } : {}) };
    this.ctx.sync.touched('drafts', next.id, true);
    return next;
  }

  /** The draft's worktree switch: on, the first send asks the core for a branch and a worktree. */
  setDraftWorktree(worktree: boolean): void {
    const draft = this.draft;
    if (!draft) return;
    this.draft = { ...draft, worktree, worktreeExplicit: true };
  }
}

function withArchived(project: Project, archived: boolean): Project {
  if (archived) return { ...project, archived: true };
  const { archived: _, ...rest } = project;
  return rest;
}
