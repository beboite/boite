import { RpcErrorCode, isThreadTerminal, threadTerminalId, type KeybindingCommand, type ProjectId, type RpcEvents, type TerminalState, type ThreadId, type ThreadSummary, type ThreadTerminal } from '@boite/contracts';
import { RpcFailure } from '../client';
// A type only: xterm's screen class rides in the terminal view's chunk, which hands it over.
import type { TerminalAttachment, TerminalSession, TerminalStart } from '../terminal-session.svelte';
import {
  MAX_PANES, activeTab, addTab, firstLayout, nextPane, panesOf, parseLayout, reconcile, removePane, resizePanes, splitPane, terminalIdOf,
  type SplitDirection, type TerminalLayout
} from '../terminal-layout';
import { experimentOn } from '../experiments.svelte';
import type { StoreContext } from './context';

/** Per core and thread: the tabs and splits, and whether the drawer was open. */
const LAYOUT_KEY = 'boite:terminal-layout';
/** Per device: the drawer's tab Ctrl+J opens, the project board or the terminal. */
const DRAWER_TAB_KEY = 'boite:drawer-tab';

type DrawerTab = 'board' | 'terminal';

function readDrawerTab(): DrawerTab {
  try { return localStorage.getItem(DRAWER_TAB_KEY) === 'terminal' ? 'terminal' : 'board'; } catch { return 'board'; }
}

interface StoredLayout { layout: TerminalLayout; open: boolean }

/** The thread drawers and sign-in shells: which are shown, how they are laid out, and the calls that drive them. */
export class Terminals {
  /** Close blocks delayed attachments of that shell on that client until it is opened again on purpose. */
  private readonly closed = new WeakMap<NonNullable<StoreContext['client']>, Set<string>>();
  private readonly opening = new Map<string, { client: StoreContext['client']; result: Promise<TerminalAttachment | null> }>();
  /** Clients whose core predates `terminals.list`: one shell per thread there, the first. */
  private readonly single = new WeakSet<NonNullable<StoreContext['client']>>();
  /** Threads whose layout is being matched with `terminals.list`; their screens wait for it before attaching. */
  private readonly settling = new Map<ThreadId, Promise<void>>();
  /** Per thread, the new shells being numbered, one after the other. */
  private readonly adding = new Map<ThreadId, Promise<void>>();
  /** Threads whose terminal drawer shows. The shells live in the core and outlast a hidden drawer. */
  terminalThreads = $state<ThreadId[]>([]);
  /** Each shown thread's tabs and splits, matched with the shells the core runs. */
  layouts = $state<Partial<Record<ThreadId, TerminalLayout>>>({});
  /** Accounts whose sign-in terminal is open on the Providers page. */
  loginTerminals = $state<string[]>([]);
  /** The project board fills the drawer under the chat, in place of the terminal, in every thread until hidden. */
  boardShown = $state(false);
  /** The tab Ctrl+J opens the drawer on: the one picked last on this device. */
  drawerTab = $state<DrawerTab>(readDrawerTab());

  /** The screens of the shells this client opened, by terminal id. One lives until its shell ends. */
  private readonly sessions = new Map<string, TerminalSession>();
  /** Moves when a screen is made or ends, so what reads `session()` sees the new one. */
  private screens = $state(0);

  constructor(private readonly ctx: StoreContext) {}

  /**
   * The screen of this shell, made the first time. `start` attaches to the
   * shell or starts it. `Session` is the class itself, which the terminal view
   * passes, so the screen's code stays out of the first chunk.
   */
  terminalSession(id: string, start: TerminalStart, Session: typeof TerminalSession): TerminalSession {
    let session = this.sessions.get(id);
    if (session === undefined) {
      session = new Session(this.ctx.store, id, start, () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        this.screens++;
      });
      this.sessions.set(id, session);
      this.screens++;
    }
    return session;
  }

  /** The screen of a shell this client draws, for what the drawer shows about it. */
  session(id: string): TerminalSession | null {
    void this.screens;
    return this.sessions.get(id) ?? null;
  }

  private withSession(id: string, act: (session: TerminalSession) => boolean): boolean {
    const session = this.sessions.get(id);
    return session === undefined ? false : act(session);
  }

  /**
   * The shell's recent commands, newest first. Null on a core that predates
   * `terminals.history`, which the list says instead of showing it empty.
   */
  async terminalHistory(id: string): Promise<string[] | null> {
    const client = this.ctx.client;
    // Offline is not an older core: the list is just empty until the machine is back.
    if (!client) return [];
    try {
      return (await client.call('terminals.history', { id })).commands;
    } catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return null;
      this.ctx.fail(error);
      return [];
    }
  }

  /** The keyboard to a shell's screen, once it is drawn. */
  focusShell(id: string): void {
    this.sessions.get(id)?.focus();
  }

  /** Another core, or none: its shells are not this client's to draw any more. */
  dropSessions(): void {
    for (const session of [...this.sessions.values()]) session.dispose();
    this.layouts = {};
  }

  terminalShown(threadId: ThreadId): boolean {
    return this.terminalThreads.includes(threadId);
  }

  terminalLayout(threadId: ThreadId): TerminalLayout | null {
    return this.layouts[threadId] ?? null;
  }

  /** False on a core that runs one shell per thread: no new tab, no split. */
  terminalsMultiple(): boolean {
    const client = this.ctx.client;
    return client !== null && !this.single.has(client);
  }

  /** The open thread's terminal, shown or hidden. A shell is the owner's to run. */
  toggleTerminal(): void {
    const s = this.ctx.store;
    const open = s.openThread;
    if (!open || !s.owner) return;
    if (s.terminalShown(open.id)) s.hideTerminal(open.id);
    else this.showTerminal(open.id);
  }

  /** The board lives behind the `/goal2` experiment, on a core that links cards to goals, in a thread of a project. */
  boardAvailable(): boolean {
    const s = this.ctx.store;
    return experimentOn('goal2') && s.core?.features?.projectBoard === true && Boolean(s.openThread?.projectId);
  }

  /**
   * Ctrl+J: the drawer under the chat on the tab picked last, or hidden. A
   * paired device has no shell, so its drawer is the board. Without the board
   * the drawer is the terminal's, as before.
   */
  toggleDrawer(): void {
    const s = this.ctx.store;
    const open = s.openThread;
    if (!open) return;
    if (!this.boardAvailable()) { this.toggleTerminal(); return; }
    if (this.boardShown) { this.boardShown = false; return; }
    if (s.owner && this.terminalShown(open.id)) { this.hideTerminal(open.id); return; }
    if (this.drawerTab === 'terminal' && s.owner) this.showTerminal(open.id);
    else this.showBoard();
  }

  /** The header's board button. */
  toggleBoard(): void {
    if (this.boardShown) this.boardShown = false;
    else this.showBoard();
  }

  /**
   * The board in the drawer; the terminals it replaces keep their shells
   * running. Every thread's drawer is put away, not only this one's, since the
   * board follows the user into the next thread.
   */
  showBoard(): void {
    const open = this.ctx.store.openThread;
    if (!open || !this.boardAvailable()) return;
    for (const threadId of this.terminalThreads) this.hideTerminal(threadId);
    this.boardShown = true;
    this.pickTab('board');
  }

  hideBoard(): void {
    this.boardShown = false;
  }

  /**
   * The conversation a project's board opens in from outside the project, a
   * contact's page: its last changed one, not archived. Null when the core
   * serves no board or the project has no conversation to hold it.
   */
  projectBoardThread(projectId: ProjectId): ThreadSummary | null {
    const s = this.ctx.store;
    if (!experimentOn('goal2') || s.core?.features?.projectBoard !== true) return null;
    let last: ThreadSummary | null = null;
    for (const thread of s.threadsOf(projectId)) {
      if (!thread.archived && !thread.incognito && (!last || thread.updatedAt > last.updatedAt)) last = thread;
    }
    return last;
  }

  /**
   * That project's board, in the drawer of that conversation. A Back, a page
   * or another conversation picked while it opens is a newer navigation: the
   * board then stays hidden.
   */
  async openProjectBoard(projectId: ProjectId): Promise<void> {
    const s = this.ctx.store;
    const thread = this.projectBoardThread(projectId);
    if (!thread) return;
    const opening = s.open(thread.id);
    const generation = s.navigationGeneration;
    await opening;
    if (s.navigationGeneration === generation && s.page === 'chat' && s.openThread?.id === thread.id) this.showBoard();
  }

  private pickTab(tab: DrawerTab): void {
    this.drawerTab = tab;
    try { localStorage.setItem(DRAWER_TAB_KEY, tab); } catch { /* private mode keeps it for this session */ }
  }

  /** The drawer of a thread whose drawer was open when the page last showed it, unless the board holds the drawer. */
  restoreTerminal(threadId: ThreadId): void {
    if (!this.ctx.store.owner || this.boardShown || this.terminalShown(threadId) || this.readStored(threadId)?.open !== true) return;
    this.showTerminal(threadId);
  }

  private showTerminal(threadId: ThreadId): void {
    const client = this.ctx.client;
    if (!client) return;
    if (this.boardShown) {
      this.boardShown = false;
      this.pickTab('terminal');
    } else if (this.boardAvailable()) this.pickTab('terminal');
    const closed = this.closed.get(client);
    for (const id of [...(closed ?? [])]) if (isThreadTerminal(threadId, id)) closed?.delete(id);
    this.terminalThreads = [...this.terminalThreads, threadId];
    void this.arrange(threadId, client);
  }

  /**
   * Lays the drawer out from what this device kept and what the core runs, then
   * starts the shell shown at the click, while the frame unfolds and xterm
   * loads. The view joins that request and fits the shell to its measured size.
   */
  private async arrange(threadId: ThreadId, client: NonNullable<StoreContext['client']>): Promise<void> {
    let done!: () => void;
    const settled = new Promise<void>((resolve) => { done = resolve; });
    this.settling.set(threadId, settled);
    try {
      if (!(await this.lay(threadId, client))) return;
    } finally {
      if (this.settling.get(threadId) === settled) this.settling.delete(threadId);
      done();
    }
    const active = this.layouts[threadId]!.active;
    const state = await this.openTerminal(threadId, 80, 24, terminalIdOf(threadId, active));
    if (state === null && this.ctx.client === client && this.layouts[threadId]?.active === active && panesOf(this.layouts[threadId]!).length === 1) this.hideTerminal(threadId);
  }

  /** The layout from what this device kept and what the core runs. False when the drawer is not to show. */
  private async lay(threadId: ThreadId, client: NonNullable<StoreContext['client']>): Promise<boolean> {
    const stored = this.layouts[threadId] ?? this.readStored(threadId)?.layout ?? null;
    let running: ThreadTerminal[] | null = null;
    try {
      running = await client.call('terminals.list', { threadId });
    } catch (error) {
      if (!(error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound)) {
        if (this.ctx.client === client) { this.ctx.fail(error); this.hideTerminal(threadId); }
        return false;
      }
      this.single.add(client);
    }
    if (this.ctx.client !== client || !this.terminalShown(threadId)) return false;
    // Nothing running, after a restart of the core say: one fresh shell.
    const layout = (running === null ? null : reconcile(threadId, stored, running)) ?? firstLayout(threadId);
    this.setLayout(threadId, layout);
    // A shell that ended while the socket was down said nothing: its screen goes with its pane.
    for (const [id, session] of [...this.sessions]) {
      if (isThreadTerminal(threadId, id) && !panesOf(layout).includes(id)) session.dispose();
    }
    return true;
  }

  /**
   * Back on line after a drop: the shells may have ended, or others started, in
   * between. Each shown drawer is laid out again from `terminals.list` before its
   * screens attach, so a shell that ended is not quietly started again.
   */
  reconnected(client: NonNullable<StoreContext['client']>): void {
    if (this.ctx.client !== client) return;
    for (const threadId of this.terminalThreads) {
      if (this.layouts[threadId] !== undefined && !this.settling.has(threadId)) void this.arrange(threadId, client);
    }
  }

  hideTerminal(threadId: ThreadId): void {
    this.terminalThreads = this.terminalThreads.filter((id) => id !== threadId);
    // Hidden before the layout came, or after it failed: the next page must not open it again.
    const layout = this.layouts[threadId] ?? this.readStored(threadId)?.layout;
    if (layout !== undefined) this.writeStored(threadId, { layout, open: false });
  }

  /** One of the thread's shells, attached or started; null when the core refused, with the reason in the toast. */
  openTerminal(threadId: ThreadId, cols: number, rows: number, terminalId?: string): Promise<TerminalAttachment | null> {
    const client = this.ctx.client;
    const id = threadTerminalId(threadId, terminalId);
    if (!client || this.closed.get(client)?.has(id)) return Promise.resolve(null);
    const settling = this.settling.get(threadId);
    if (settling !== undefined) {
      return settling.then(() => {
        const layout = this.layouts[threadId];
        return layout !== undefined && panesOf(layout).includes(id) ? this.openTerminal(threadId, cols, rows, terminalId) : null;
      });
    }
    const pending = this.opening.get(id);
    if (pending?.client === client) return pending.result;
    const params = { threadId, cols, rows, ...(terminalId === undefined ? {} : { terminalId }) };
    // A lazy view can join after output has already arrived while the opening
    // snapshot is in flight. Keep that gap and advance its sequence so the
    // view does not draw the same events twice.
    const output: RpcEvents['terminal.output'][] = [];
    const stop = client.on('terminal.output', (event) => {
      if (event.id === id) output.push(event);
    });
    const result = client.call('terminals.open', params)
      .then((state) => {
        if (this.closed.get(client)?.has(id)) return null;
        // An older core cannot identify snapshot overlap. Refresh its history
        // after the buffered events instead of dropping output the lazy view missed.
        if (state.sequence === undefined && output.length > 0) return client.call('terminals.open', params);
        const after = output.filter((event) => state.sequence !== undefined && event.sequence !== undefined && event.sequence > state.sequence);
        return after.length === 0 ? state : {
          ...state, replayChars: state.output.length,
          output: state.output + after.map((event) => event.data).join(''), sequence: after.at(-1)!.sequence
        };
      })
      .catch((error) => { if (this.ctx.client === client) this.ctx.fail(error); return null; })
      .finally(() => {
        stop();
        if (this.opening.get(id)?.result === result) this.opening.delete(id);
      });
    this.opening.set(id, { client, result });
    return result;
  }

  /** A shell in a new tab at the end, as T3 Code's Ctrl+N. False when none can open here. */
  newTerminal(threadId: ThreadId): boolean {
    const layout = this.layouts[threadId];
    if (layout === undefined || !this.terminalsMultiple() || nextPane(threadId, layout) === null) return false;
    this.addShell(threadId, (current, pane) => addTab(current, pane));
    return true;
  }

  /** A shell beside the active one, `row` side by side and `column` stacked. False when the tab is full. */
  splitTerminal(threadId: ThreadId, direction: SplitDirection): boolean {
    const layout = this.layouts[threadId];
    if (layout === undefined || !this.terminalsMultiple() || nextPane(threadId, layout) === null) return false;
    if (activeTab(layout).panes.length >= MAX_PANES) return false;
    this.addShell(threadId, (current, pane) => splitPane(current, pane, direction));
    return true;
  }

  /**
   * Numbers a new shell past every one the core runs, not only those this
   * window shows: another window may have opened `term-2` since, and its shell
   * is not this tab's. One at a time per thread, so two quick presses take two.
   */
  private addShell(threadId: ThreadId, place: (layout: TerminalLayout, pane: string) => TerminalLayout | null): void {
    const client = this.ctx.client;
    if (!client) return;
    const run = (this.adding.get(threadId) ?? Promise.resolve()).then(async () => {
      let running: ThreadTerminal[];
      try {
        running = await client.call('terminals.list', { threadId });
      } catch (error) {
        if (this.ctx.client === client) this.ctx.fail(error);
        return;
      }
      const layout = this.layouts[threadId];
      if (this.ctx.client !== client || layout === undefined || !this.terminalShown(threadId)) return;
      const pane = nextPane(threadId, layout, running.map((shell) => shell.id));
      const next = pane === null ? null : place(layout, pane);
      if (pane === null || next === null) return;
      this.reopen(pane);
      this.setLayout(threadId, next);
      // Started here, not when its view mounts: a reload right after still finds it.
      void this.openTerminal(threadId, 80, 24, terminalIdOf(threadId, pane));
    });
    const queued = run.finally(() => { if (this.adding.get(threadId) === queued) this.adding.delete(threadId); });
    this.adding.set(threadId, queued);
  }

  /** The pane takes the keyboard; its tab shows. */
  focusTerminal(threadId: ThreadId, pane: string): void {
    const layout = this.layouts[threadId];
    if (layout === undefined || layout.active === pane || !panesOf(layout).includes(pane)) return;
    this.setLayout(threadId, { ...layout, active: pane });
  }

  resizeTerminalPanes(threadId: ThreadId, tabId: string, index: number, share: number): void {
    const layout = this.layouts[threadId];
    if (layout !== undefined) this.setLayout(threadId, resizePanes(layout, tabId, index, share));
  }

  /** Every shell of the tab goes. */
  closeTerminalTab(threadId: ThreadId, tabId: string): void {
    const tab = this.layouts[threadId]?.tabs.find((t) => t.id === tabId);
    for (const pane of tab?.panes ?? []) void this.closeTerminal(pane);
  }

  /** The shell ended, from `exit` or from any client: its pane goes, and the drawer with the last one. */
  terminalExited(threadId: ThreadId, pane: string): void {
    const layout = this.layouts[threadId];
    if (layout === undefined) return;
    const next = removePane(layout, pane);
    if (next !== null) {
      this.setLayout(threadId, next);
      return;
    }
    const layouts = { ...this.layouts };
    delete layouts[threadId];
    this.layouts = layouts;
    this.terminalThreads = this.terminalThreads.filter((id) => id !== threadId);
    this.writeStored(threadId, null);
  }

  /** `terminal.exited`: the pane of that shell goes from whichever thread lays it out. */
  shellEnded(id: string): void {
    const threadId = this.threadOf(id);
    if (threadId !== undefined) this.terminalExited(threadId, id);
  }

  private threadOf(id: string): ThreadId | undefined {
    return (Object.keys(this.layouts) as ThreadId[]).find((key) => panesOf(this.layouts[key]!).includes(id));
  }

  /**
   * A terminal command pressed in the screen of shell `id`. False when it does
   * nothing there: a sign-in screen, a core with one shell per thread, a full
   * tab or thread. The key is then the shell's, Ctrl+D its end of input.
   */
  terminalCommand(id: string, command: KeybindingCommand): boolean {
    const threadId = this.threadOf(id);
    if (threadId === undefined) return false;
    switch (command) {
      case 'terminal-new': return this.newTerminal(threadId);
      case 'terminal-split': return this.splitTerminal(threadId, 'row');
      case 'terminal-split-vertical': return this.splitTerminal(threadId, 'column');
      case 'terminal-close': void this.closeTerminal(id); return true;
      case 'terminal-find': return this.withSession(id, (session) => { session.openSearch(); return true; });
      case 'terminal-history': return this.withSession(id, (session) => { session.openHistory(); return true; });
      case 'terminal-previous-command': return this.withSession(id, (session) => session.jump(-1));
      case 'terminal-next-command': return this.withSession(id, (session) => session.jump(1));
      default: return false;
    }
  }

  /** The account's sign-in shell with its login command typed in, attached or started. */
  async loginTerminal(accountId: string, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      return await client.call('accounts.loginTerminal', { accountId, cols, rows });
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  showLoginTerminal(accountId: string): void {
    if (!this.loginTerminals.includes(accountId)) this.loginTerminals = [...this.loginTerminals, accountId];
  }

  hideLoginTerminal(accountId: string): void {
    this.loginTerminals = this.loginTerminals.filter((id) => id !== accountId);
  }

  /** Keystrokes. A shell that ended in between has nothing to take them, which is not an error to show. */
  writeTerminal(id: string, data: string): void {
    void this.ctx.client?.call('terminals.write', { id, data }).catch(error => {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.NotFound) return;
      this.ctx.fail(error);
    });
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    void this.ctx.client?.call('terminals.resize', { id, cols, rows }).catch(() => undefined);
  }

  /** Kills the shell; `terminal.exited` follows. */
  async closeTerminal(id: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    const closed = this.closed.get(client) ?? new Set<string>();
    closed.add(id);
    this.closed.set(client, closed);
    try {
      await client.call('terminals.close', { id });
      // An older core may not say `terminal.exited` for a shell it already lost.
      if (this.ctx.client === client) this.shellEnded(id);
    } catch (error) {
      this.closed.get(client)?.delete(id);
      this.ctx.fail(error);
    }
  }

  /** A pane opened on purpose takes its shell even when an earlier one under its id was closed. */
  private reopen(pane: string): void {
    const client = this.ctx.client;
    if (client) this.closed.get(client)?.delete(pane);
  }

  private setLayout(threadId: ThreadId, layout: TerminalLayout): void {
    this.layouts = { ...this.layouts, [threadId]: layout };
    this.writeStored(threadId, { layout, open: this.terminalShown(threadId) });
  }

  private storageKey(threadId: ThreadId): string {
    // Two machines can share a data directory path and a thread id.
    return `${LAYOUT_KEY}:${this.ctx.store.core?.dataDir ?? ''}:${this.ctx.store.threadKey(threadId)}`;
  }

  private readStored(threadId: ThreadId): StoredLayout | null {
    try {
      const raw = localStorage.getItem(this.storageKey(threadId));
      if (raw === null) return null;
      const value = JSON.parse(raw) as { layout?: unknown; open?: unknown };
      const layout = parseLayout(threadId, value.layout);
      return layout === null ? null : { layout, open: value.open === true };
    } catch {
      return null;
    }
  }

  private writeStored(threadId: ThreadId, value: StoredLayout | null): void {
    try {
      if (value === null) localStorage.removeItem(this.storageKey(threadId));
      else localStorage.setItem(this.storageKey(threadId), JSON.stringify(value));
    } catch { /* private mode keeps the layout for this session */ }
  }
}
