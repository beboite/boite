import type { ThreadId } from '@boite/contracts';
import {
  pushCovers,
  readNotifications,
  requestNotificationPermission,
  sendNotification,
  shouldNotify,
  toastFor,
  writeNotifications,
  type NotifyKind
} from '../notify';
import { experimentOn } from '../experiments.svelte';
import { clampSidebar, SIDEBAR_DEFAULT, writeLayout } from '../prefs';
import { rightPanel, type BoundPanel } from '../right-panel.svelte';
import { strings } from '../strings';
import type { Page, SettingsTab } from '../store.svelte';
import type { StoreContext } from './context';

/** What the window shows around the chat: the page, the sidebar, the palette, the panel, the toasts. */
export class Layout {
  projectPickerOpen = $state(false);
  /** Toasts for threads the user is not looking at, per machine. */
  notifications = $state(readNotifications());
  /** The command palette, `Ctrl+K`. */
  paletteOpen = $state(false);
  /** Set by the palette's Rename: the chat header opens its title field and clears it. */
  renameRequested = $state(false);
  /** The find bar over the open thread, and a count each ask bumps so a second Ctrl+F refocuses it. */
  findOpen = $state(false);
  findRequest = $state(0);
  page = $state<Page>('chat');
  settingsTab = $state<SettingsTab>('home');
  /** A settings card requested before its lazy page exists, with a fresh key for repeated asks. */
  settingsSection = $state<{ id: string; request: number } | null>(null);
  /** The phone drawer. */
  sidebarOpen = $state(false);
  /** The desktop sidebar's remembered folded state. */
  sidebarCollapsed = $state(false);
  sidebarWidth = $state(SIDEBAR_DEFAULT);
  /** A folder is being dragged over the window. */
  dropping = $state(false);
  search = $state('');

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
        this.ctx.store.error = strings.errors.clipboard;
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  showSettings(tab: SettingsTab = 'home', section: string | null = null): void {
    this.ctx.threads.invalidateNavigation();
    this.settingsTab = tab;
    this.settingsSection = section === null
      ? null
      : { id: section, request: (this.settingsSection?.request ?? 0) + 1 };
    this.page = 'settings';
    if (tab === 'resources') void this.ctx.store.refreshResources();
  }

  showChat(): void {
    this.ctx.threads.invalidateNavigation();
    this.page = 'chat';
  }

  /** The Agents page is an experiment: with it off, nothing leads there. */
  showAgents(): void {
    if (!experimentOn('resident-agents')) return;
    this.ctx.threads.invalidateNavigation();
    this.page = 'agents';
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
      enabled: readNotifications()
    });
    if (!go) return;
    const title = s.threads.find((t) => t.id === threadId)?.title ?? strings.app.name;
    const origin = s.endpointUrl ? new URL(s.endpointUrl).origin : undefined;
    const key = s.threadKey(threadId);
    void (async () => {
      // The core's push already brings this one to the device.
      if (await pushCovers(origin)) return;
      const body = typeof detail === 'function' ? await detail().catch(() => null) : detail;
      await sendNotification({ ...toastFor(kind, key, title, body), coreThreadId: threadId, origin });
    })();
  }

  /** The switch of the Background card; the platform prompt comes with the first turn-on. */
  async setNotifications(enabled: boolean): Promise<void> {
    this.notifications = enabled;
    writeNotifications(enabled);
    if (!enabled) return;
    const granted = await requestNotificationPermission();
    if (!granted) this.ctx.store.error = strings.settings.notificationsDenied;
  }
}
