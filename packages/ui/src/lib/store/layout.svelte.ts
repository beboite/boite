import { parseGroupRelayUrl, type QuotaAlert, type ThreadId } from '@boite/contracts';
import { appPage } from '../app-origin';
import { servesThisPage } from '../endpoint';
import {
  notificationCore,
  pushCovers,
  pushHomeClient,
  pushKinds,
  readPushHome,
  readNotificationKinds,
  readNotifications,
  requestNotificationPermission,
  sameKinds,
  sendNotification,
  shouldNotify,
  toastFor,
  limitToast,
  limitsKey,
  writeNotificationKinds,
  writeNotifications,
  type NotifyKind
} from '../notify';
import { PUSH_ENABLED_KEY } from '../pwa';
import type { Client } from '../client';
import { experimentOn } from '../experiments.svelte';
import type { DropKind } from '../native-drop';
import { clampSidebar, SIDEBAR_DEFAULT, writeLayout } from '../prefs';
import { rightPanel, type BoundPanel } from '../right-panel.svelte';
import { strings } from '../strings';
import type { Page, SettingsTab } from '../store.svelte';
import type { StoreContext } from './context';
import { contactsShown } from '../contacts-rail.svelte';

/** The kinds are this device's whichever machine is shown: one state every Store's Layout reads. */
const deviceKinds = $state({ list: readNotificationKinds() });

/** What the window shows around the chat: the page, the sidebar, the palette, the panel, the toasts. */
/** What opens over an agent's conversation: its settings, or its brain (instructions and memory). */
export type AgentPane = 'settings' | 'brain';

export class Layout {
  projectPickerOpen = $state(false);
  /** Toasts for threads the user is not looking at, per machine. */
  notifications = $state(readNotifications());
  /** The kinds of toast and push this device keeps, under that switch. */
  get notificationKinds(): NotifyKind[] { return deviceKinds.list; }
  /** The command palette, `Ctrl+K`. */
  paletteOpen = $state(false);
  /** Set by the palette's Rename: the chat header opens its title field and clears it. */
  renameRequested = $state(false);
  /** The find bar over the open thread, and a count each ask bumps so a second Ctrl+F refocuses it. */
  findOpen = $state(false);
  findRequest = $state(0);
  /** Bumped to open the draft's project dropdown from the keyboard. */
  projectChoiceRequest = $state(0);
  page = $state<Page>('chat');
  settingsTab = $state<SettingsTab>('home');
  /** A settings card requested before its lazy page exists, with a fresh key for repeated asks. */
  /** The card Settings scrolls to; `flash` lights it up once, for a settings card that pointed at it. */
  settingsSection = $state<{ id: string; request: number; flash?: boolean } | null>(null);
  /** The phone drawer. */
  sidebarOpen = $state(false);
  /** The desktop sidebar's remembered folded state. */
  sidebarCollapsed = $state(false);
  sidebarWidth = $state(SIDEBAR_DEFAULT);
  /** What a drag from the system over the window would do: add a project or attach files. */
  dropping = $state<DropKind | false>(false);
  search = $state('');
  /** The agent an outside link asked the Agents page to open, with a fresh key for repeated asks; the page takes it once. */
  agentsTarget = $state<{ agentId: string; request: number; pane?: AgentPane } | null>(null);
  /** The contact the Contacts page shows, by core id; null shows the page that adds one. */
  contact = $state<string | null>(null);

  constructor(private readonly ctx: StoreContext) {}

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  setSidebarWidth(width: number): void {
    this.sidebarWidth = clampSidebar(width);
    writeLayout({ sidebarWidth: this.sidebarWidth, sidebarCollapsed: this.sidebarCollapsed });
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    writeLayout({ sidebarWidth: this.sidebarWidth, sidebarCollapsed: this.sidebarCollapsed });
  }

  async copy(text: string): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const navigation = this.ctx.threads.openGeneration;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (this.ctx.client === client && this.ctx.clientGeneration === clientGeneration && this.ctx.threads.openGeneration === navigation)
        this.ctx.store.reportError(strings.errors.clipboard, 'minor');
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  showSettings(tab: SettingsTab = 'home', section: string | null = null, options: { flash?: boolean } = {}): void {
    this.ctx.threads.invalidateNavigation();
    this.settingsTab = tab;
    this.settingsSection = section === null
      ? null
      : { id: section, request: (this.settingsSection?.request ?? 0) + 1, ...(options.flash ? { flash: true } : {}) };
    this.page = 'settings';
    if (tab === 'resources') void this.ctx.store.refreshResources();
  }

  /**
   * The thread list and its chat. Coming from an agent's thread, the chat goes
   * back to the ordinary thread it showed last, else where the user left off:
   * an agent's conversation belongs beside the agents list.
   */
  showChat(): void {
    this.ctx.threads.invalidateNavigation();
    this.page = 'chat';
    const open = this.ctx.threads.openThread;
    if (!open?.agentSessionId) return;
    const back = this.ctx.threads.lastChatThreadId;
    const row = back ? this.ctx.threads.threads.find(t => t.id === back && !t.archived) : undefined;
    if (row) void this.ctx.store.open(row.id);
    else void this.ctx.projects.openWhereLeft();
  }

  /**
   * The Agents page is an experiment: with it off, nothing leads there.
   * `agentId` opens that agent's thread there; `pane` opens its settings or
   * its brain over the conversation.
   */
  showAgents(agentId: string | null = null, pane?: AgentPane): void {
    if (!experimentOn('resident-agents')) return;
    this.ctx.threads.invalidateNavigation();
    if (agentId) this.agentsTarget = { agentId, request: (this.agentsTarget?.request ?? 0) + 1, ...(pane ? { pane } : {}) };
    this.page = 'agents';
    this.sidebarOpen = false;
  }

  /** The Contacts page: one contact, or with none the way to add one. An experiment too: with it off, nothing leads there. */
  showHome(contact: string | null = null): void {
    if (!contactsShown(this.ctx.store)) return;
    this.ctx.threads.invalidateNavigation();
    this.contact = contact;
    this.page = 'home';
    this.sidebarOpen = false;
  }

  /** The right panel of the thread that is open, surfaces and all. */
  get panel(): BoundPanel {
    const s = this.ctx.store;
    return rightPanel.for(s.openThread ? s.threadKey(s.openThread.id) : null);
  }

  /** Whether that panel is showing. The chat header's button reads it. */
  get panelOpen(): boolean {
    return this.ctx.store.panel.isOpen;
  }

  /**
   * The header's Panel button: the panel itself, open or shut. An empty panel
   * opens on the surface this device starts with, else on its launcher.
   */
  togglePanel(): void {
    const s = this.ctx.store;
    s.panel.toggle(s.openProject?.repository !== false);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * A toast for what happened where the user was not looking; the decision is
   * `shouldNotify`. `detail` is the body, read only once a toast goes out.
   */
  notify(kind: NotifyKind, threadId: ThreadId, detail: string | null | (() => Promise<string | null>)): void {
    const s = this.ctx.store;
    const go = shouldNotify({
      kind,
      threadId,
      openThreadId: s.visible ? s.openThread?.id ?? null : null,
      focused: typeof document !== 'undefined' && document.hasFocus() && document.visibilityState === 'visible',
      enabled: readNotifications(),
      kinds: readNotificationKinds()
    });
    if (!go) return;
    const title = s.threads.find((t) => t.id === threadId)?.title ?? strings.app.name;
    const origin = s.endpointUrl ? new URL(s.endpointUrl).origin : undefined;
    const key = s.threadKey(threadId);
    void (async () => {
      // A machine this page does not serve: its id in the group, which its pushes and a tap name.
      const core = origin !== undefined && origin !== location.origin ? notificationCore(s) : undefined;
      // A push already brings this one to the device: this page's core, or a member forwarding to the device's push home.
      if (await pushCovers(origin, core !== undefined && s.group !== null)) return;
      const body = typeof detail === 'function' ? await detail().catch(() => null) : detail;
      await sendNotification({ ...toastFor(kind, key, title, body), coreThreadId: threadId, origin, ...(core === undefined ? {} : { core }) });
    })();
  }

  /**
   * A limit alert, whatever is on screen: it belongs to no thread. A click
   * opens Settings, Limits, on the machine that sent it.
   */
  notifyLimit(alert: QuotaAlert): void {
    if (!readNotifications() || !readNotificationKinds().includes('limits')) return;
    const s = this.ctx.store;
    const origin = s.endpointUrl ? new URL(s.endpointUrl).origin : undefined;
    void (async () => {
      const core = origin !== undefined && origin !== location.origin ? notificationCore(s) : undefined;
      if (await pushCovers(origin, core !== undefined && s.group !== null)) return;
      await sendNotification({ ...limitToast(alert, limitsKey(s.machineId)), origin, ...(core === undefined ? {} : { core }) });
    })();
  }

  /** The switch of the Background card; the platform prompt comes with the first turn-on. */
  async setNotifications(enabled: boolean): Promise<void> {
    this.notifications = enabled;
    writeNotifications(enabled);
    this.syncPushKinds();
    if (!enabled) return;
    const granted = await requestNotificationPermission();
    if (!granted) this.ctx.store.error = strings.settings.notificationsDenied;
  }

  /** One kind's switch, under the main one. */
  setNotificationKind(kind: NotifyKind, on: boolean): void {
    const kinds = readNotificationKinds().filter((k) => k !== kind);
    writeNotificationKinds(on ? [...kinds, kind] : kinds);
    deviceKinds.list = readNotificationKinds();
    this.syncPushKinds();
  }

  /**
   * The core sends this device's pushes, so it hears the device's choice: the
   * push home, the machine holding the subscription, whichever one is shown.
   * A subscription older than that record goes by the shown machine when it
   * may hold it. The phone's settings screen checks again on `push.status`.
   */
  private syncPushKinds(): void {
    try {
      if (localStorage.getItem(PUSH_ENABLED_KEY) !== 'on') return;
    } catch {
      return;
    }
    const home = readPushHome();
    const client = home !== null ? pushHomeClient(home) : this.mayHoldPush() ? this.ctx.store.client : null;
    void client?.call('push.kinds', { kinds: pushKinds() }).catch(() => undefined);
  }

  /**
   * On a paired device, once its core answers: a subscription saved before a
   * kind existed (Limits) lacks it, so the device's choice is sent again. The
   * Phone app settings do the same when they open.
   */
  checkPushKinds(client: Pick<Client, 'call'>): void {
    try {
      if (localStorage.getItem(PUSH_ENABLED_KEY) !== 'on') return;
    } catch {
      return;
    }
    const home = readPushHome();
    if (home !== null ? home !== (this.ctx.store.endpointUrl ?? '') : !this.mayHoldPush()) return;
    void client.call('push.status', {}).then((result) => {
      if (result.subscribed && !sameKinds(result.kinds ?? [], pushKinds())) return client.call('push.kinds', { kinds: pushKinds() });
    }).catch(() => undefined);
  }

  /** The shown machine is one this page subscribes on: the one serving it, or any on the phone app's page. */
  private mayHoldPush(): boolean {
    const s = this.ctx.store;
    const relay = s.endpointUrl === null ? null : parseGroupRelayUrl(s.endpointUrl);
    if (relay !== null && servesThisPage(relay.member)) return false;
    return appPage() || !s.endpointUrl || servesThisPage(s.endpointUrl);
  }
}
