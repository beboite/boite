/*
 * The desktop app's own browser, lent to the agents of the conversations whose
 * panels hold its tabs. The owner's desktop on this machine lists the tabs it
 * lends (`browser.desktopTabs`); an agent's command on one of them becomes a
 * `browser.desktopRequest` to that desktop, which runs it on the page the
 * person sees and answers with `browser.desktopReply`. Only the DevTools
 * methods the shell itself accepts are relayed. See docs/browser.md.
 */
import { randomUUID } from 'node:crypto';
import {
  DESKTOP_BROWSER_METHODS,
  desktopBrowserTabsError,
  type DesktopBrowserMethod,
  type DesktopBrowserRequest,
  type DesktopBrowserTab,
  type RpcParams,
  type ThreadId,
} from '@boite/contracts';
import type { Connection } from '../router.ts';
import { refused } from '../errors.ts';
import type { AgentPage } from './automation.ts';

/** The shell gives one DevTools call this long; the desktop answers a little after. */
export const DESKTOP_CALL_MS = 15_000;
const REPLY_GRACE_MS = 5_000;
/** Requests waiting for a desktop at once, beyond which an agent is asked to try again. */
const PENDING_MAX = 64;
const ERROR_MAX = 2000;

export interface DesktopHost { connection: Connection; order: number; tabs: Map<string, DesktopBrowserTab> }
interface Pending { connectionId: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface LentTab { host: DesktopHost; tab: DesktopBrowserTab }

const METHODS: readonly string[] = DESKTOP_BROWSER_METHODS;

export class DesktopBrowsers {
  readonly #hosts = new Map<string, DesktopHost>();
  readonly #pending = new Map<string, Pending>();
  #order = 0;
  #closed = false;

  /**
   * The owner's shell on this machine's loopback: its browser views are on the
   * machine whose agents drive them. A phone or another computer has none here.
   */
  #assertDesktop(connection: Connection): void {
    if (connection.identity.principal !== 'owner' || connection.sentFrom?.client !== 'shell' || connection.remote === true) {
      throw refused('browser.desktopTabs comes from the desktop app on this machine: the owner\'s shell, connected on loopback');
    }
  }

  /** A desktop's whole list of lent tabs, which replaces the last one. */
  lend(connection: Connection, params: RpcParams<'browser.desktopTabs'>): { ok: true } {
    if (this.#closed) throw refused('the core is shutting down');
    this.#assertDesktop(connection);
    if (!params || typeof params !== 'object' || typeof params.host !== 'boolean') throw refused('browser.desktopTabs host must be a boolean');
    const problem = desktopBrowserTabsError(params.tabs);
    if (problem) throw refused(problem);
    if (!params.host) {
      if (params.tabs.length > 0) throw refused('browser.desktopTabs with host false lists no tabs');
      this.drop(connection.id, 'the desktop app stopped lending its browser');
      return { ok: true };
    }
    const tabs = new Map(params.tabs.map(({ threadId, tabId, url, title, profile, active }) => [tabId, { threadId, tabId, url, title, profile, ...(active ? { active: true } : {}) }]));
    const known = this.#hosts.get(connection.id);
    if (known) known.tabs = tabs;
    else this.#hosts.set(connection.id, { connection, order: ++this.#order, tabs });
    return { ok: true };
  }

  /** The answer to one request, from the connection it went to. */
  reply(connection: Connection, params: RpcParams<'browser.desktopReply'>): { ok: true } {
    if (!params || typeof params !== 'object' || typeof params.requestId !== 'string') throw refused('browser.desktopReply needs the requestId of a browser.desktopRequest');
    if (params.error !== undefined && typeof params.error !== 'string') throw refused('browser.desktopReply error must be a string');
    const pending = this.#pending.get(params.requestId);
    if (!pending || pending.connectionId !== connection.id) throw refused('no browser.desktopRequest with that requestId waits for this connection');
    this.#pending.delete(params.requestId);
    clearTimeout(pending.timer);
    if (params.error !== undefined) pending.reject(refused(params.error.slice(0, ERROR_MAX) || 'the desktop app refused'));
    else pending.resolve(params.result);
    return { ok: true };
  }

  /** The connection left or stopped lending: its tabs go, and what waited on it fails at once. */
  drop(connectionId: string, reason = 'the desktop app closed its connection'): void {
    this.#hosts.delete(connectionId);
    for (const [id, pending] of this.#pending) {
      if (pending.connectionId !== connectionId) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(refused(reason));
    }
  }

  /** The newest desktop first: a desktop that reconnects lends the same views again. */
  #lending(): DesktopHost[] {
    return [...this.#hosts.values()].sort((a, b) => b.order - a.order);
  }

  /** The tabs lent to one conversation, each once. */
  tabs(threadId: ThreadId): DesktopBrowserTab[] {
    const seen = new Map<string, DesktopBrowserTab>();
    for (const host of this.#lending()) for (const tab of host.tabs.values()) if (tab.threadId === threadId && !seen.has(tab.tabId)) seen.set(tab.tabId, tab);
    return [...seen.values()];
  }

  find(threadId: ThreadId, tabId: string): LentTab | null {
    for (const host of this.#lending()) {
      const tab = host.tabs.get(tabId);
      if (tab && tab.threadId === threadId) return { host, tab };
    }
    return null;
  }

  /** The desktop that opens a new tab for a conversation: one showing it, else the newest. */
  hostFor(threadId: ThreadId): DesktopHost | null {
    const hosts = this.#lending();
    return hosts.find(host => host.connection.subscriptions.has(threadId)) ?? hosts[0] ?? null;
  }

  /** The tab a desktop opened for this core: listed now, before its next list arrives. */
  adopt(host: DesktopHost, tab: DesktopBrowserTab): void {
    if (this.#hosts.get(host.connection.id) === host) host.tabs.set(tab.tabId, tab);
  }

  forget(tabId: string): void {
    for (const host of this.#hosts.values()) host.tabs.delete(tabId);
  }

  request<T = unknown>(host: DesktopHost, threadId: ThreadId, request: DesktopBrowserRequest, timeoutMs: number): Promise<T> {
    if (this.#closed) return Promise.reject(refused('the core is shutting down'));
    if (this.#hosts.get(host.connection.id) !== host) return Promise.reject(refused('the desktop app stopped lending its browser'));
    if (this.#pending.size >= PENDING_MAX) return Promise.reject(refused('the desktop app has too many browser commands waiting; try again in a moment'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(refused(`the desktop app did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(requestId, { connectionId: host.connection.id, resolve: resolve as (value: unknown) => void, reject, timer });
      host.connection.sendEvent('browser.desktopRequest', { requestId, threadId, request });
    });
  }

  /**
   * One lent tab as the agent's commands see it. Each call finds the desktop
   * that lends the tab now, so a desktop that reconnected keeps serving it.
   * The person at the desktop answers the page's dialogs: none is recorded here.
   */
  page(threadId: ThreadId, tabId: string): AgentPage {
    return {
      dialogs: [],
      dialogPolicy: { accept: true, text: null },
      send: <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
        if (!METHODS.includes(method)) return Promise.reject(refused(`${method} is not available in the desktop app's browser`));
        const lent = this.find(threadId, tabId);
        if (!lent) return Promise.reject(refused(`desktop browser tab ${tabId} is closed`));
        const wait = Math.max(timeoutMs ?? 0, DESKTOP_CALL_MS) + REPLY_GRACE_MS;
        return this.request<T>(lent.host, threadId, { kind: 'protocol', tabId, method: method as DesktopBrowserMethod, params }, wait);
      },
    };
  }

  close(): void {
    this.#closed = true;
    for (const id of [...this.#hosts.keys()]) this.drop(id, 'the core is shutting down');
  }
}
