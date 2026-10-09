/**
 * The desktop app hosting its own core's agent browser (`browser.hostAttach`):
 * each agent tab is a webview of this app, so the page shows natively in the
 * panel rather than as frames.
 *
 * The core keeps driving the tabs over the DevTools protocol exactly as it
 * drives a browser it started; it sends its messages here, one connection per
 * profile, and this module answers as a browser would. A page-level command
 * (one with a `sessionId`) goes to that webview's own DevTools channel; a
 * browser-level one (`Target.*`, `Browser.*`) is answered here by creating,
 * listing and closing webviews. A webview's own events, its address and title
 * changes and the windows it opens come back the same way.
 *
 * No port is opened: WebView2 hands each webview's protocol to the app itself.
 */
import { BROWSER_HOST_BATCH_MAX, DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE } from '@boite/contracts';
import type { BrowserEvent } from './browser-bridge';

/** What the relay needs of the shell's webviews: `lib/browser-bridge-tauri.ts` on Windows. */
export interface HostBridge {
  create(id: string, url: string, profile?: string): void;
  destroy(id: string): void;
  /** One DevTools call to the webview, answered without waiting for the calls before it: the core sends them concurrently. */
  relay(id: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  events(id: string, names: readonly string[], listener: (method: string, params: Record<string, unknown>) => void): Promise<() => void>;
  on(handler: (event: BrowserEvent) => void): () => void;
}

/** What the relay needs of the client of the core it hosts for. */
export interface HostClient {
  call(method: 'browser.hostAttach' | 'browser.hostDetach', params: Record<string, never>): Promise<unknown>;
  call(method: 'browser.hostReply', params: { profile: string; messages: string[] }): Promise<unknown>;
  on(event: 'browser.hostMessage', handler: (payload: { profile: string; message: string }) => void): () => void;
}

/** The events the core listens to on a page: `packages/core/src/browser/page-events.ts`, the recorder and the waits. */
export const HOST_PAGE_EVENTS = [
  'Page.frameNavigated', 'Page.javascriptDialogOpening', 'Page.loadEventFired', 'Page.domContentEventFired', 'Page.screencastFrame',
  'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Runtime.executionContextCreated', 'Runtime.executionContextsCleared',
  'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Log.entryAdded',
] as const;

/** Every agent webview's id starts so; the shell gives those the agent's DevTools methods (`browser_control.rs`). */
export const AGENT_VIEW_PREFIX = 'agent-';

/** `relay` is the core's connection the webview answers on; `profile` the one its pages run in. */
interface Target { id: string; relay: string; profile: string; context: string | null; url: string; title: string; off: (() => void) | null }
interface Message { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export class BrowserHostRelay {
  #targets = new Map<string, Target>();
  #contexts = new Set<string>();
  #outbox = new Map<string, string[]>();
  #sending = new Map<string, Promise<void>>();
  #offs: Array<() => void> = [];
  #stopped = false;

  constructor(private readonly client: HostClient, private readonly bridge: HostBridge) {}

  /** Attaches to the core and starts answering it; resolves once the core has accepted. */
  async start(): Promise<void> {
    this.#offs.push(this.client.on('browser.hostMessage', ({ profile, message: text }) => this.#receive(profile, text)));
    this.#offs.push(this.bridge.on(event => this.#bridgeEvent(event)));
    await this.client.call('browser.hostAttach', {});
  }

  /** Detaches and closes every webview this relay made: the core drops their tabs with the connection. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const off of this.#offs) off();
    void this.client.call('browser.hostDetach', {}).catch(() => {});
    for (const target of [...this.#targets.values()]) this.#close(target, false);
  }

  /** The webviews this relay holds, by id: the panel shows one by its tab's `view`. */
  get views(): string[] { return [...this.#targets.keys()]; }

  #receive(profile: string, text: string): void {
    if (this.#stopped) return;
    let parsed: Message;
    try { parsed = JSON.parse(text) as Message; } catch { return; }
    const { id, method = '', params = {}, sessionId } = parsed;
    if (typeof id !== 'number') return;
    const answer = (result: unknown) => this.#send(profile, { id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
    const fail = (cause: unknown) => this.#send(profile, { id, error: { message: message(cause) }, ...(sessionId ? { sessionId } : {}) });
    if (sessionId !== undefined) {
      if (!this.#targets.has(sessionId)) { fail(`no webview ${sessionId}: it was closed`); return; }
      this.bridge.relay(sessionId, method, params).then(answer, fail);
      return;
    }
    this.#browser(profile, method, params).then(answer, fail);
  }

  /** What a browser answers itself, without a page. */
  async #browser(profile: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: 'WebView2', userAgent: navigator.userAgent, jsVersion: '' };
      case 'Browser.setDownloadBehavior': case 'Browser.close': case 'Target.setDiscoverTargets': return {};
      case 'Target.createBrowserContext': {
        const context = `context-${crypto.randomUUID()}`;
        this.#contexts.add(context);
        return { browserContextId: context };
      }
      case 'Target.disposeBrowserContext': {
        const context = String(params.browserContextId ?? '');
        this.#contexts.delete(context);
        for (const target of [...this.#targets.values()]) if (target.context === context) this.#close(target, true);
        return {};
      }
      case 'Target.createTarget': {
        const context = typeof params.browserContextId === 'string' ? params.browserContextId : null;
        if (context !== null && !this.#contexts.has(context)) throw new Error(`no browser context ${context}`);
        // A throwaway context is what a private window is: a webview that keeps nothing.
        const target = await this.#open(profile, context ? PRIVATE_BROWSER_PROFILE : profile, String(params.url ?? 'about:blank'), context);
        return { targetId: target.id };
      }
      case 'Target.attachToTarget': {
        const target = this.#target(params.targetId);
        return { sessionId: target.id };
      }
      case 'Target.getTargetInfo': {
        const target = this.#target(params.targetId);
        return { targetInfo: this.#info(target) };
      }
      case 'Target.closeTarget': {
        this.#close(this.#target(params.targetId), true);
        return { success: true };
      }
      default: throw new Error(`${method} is not something the desktop app's webviews answer`);
    }
  }

  #target(id: unknown): Target {
    const target = typeof id === 'string' ? this.#targets.get(id) : undefined;
    if (!target) throw new Error(`no webview ${String(id)}`);
    return target;
  }

  #info(target: Target, openerId?: string) {
    return { targetId: target.id, type: 'page', url: target.url, title: target.title, attached: true, ...(openerId ? { openerId } : {}) };
  }

  async #open(relay: string, profile: string, url: string, context: string | null): Promise<Target> {
    const target: Target = { id: `${AGENT_VIEW_PREFIX}${crypto.randomUUID()}`, relay, profile, context, url, title: '', off: null };
    this.#targets.set(target.id, target);
    this.bridge.create(target.id, url, profile === DEFAULT_BROWSER_PROFILE ? undefined : profile);
    try {
      const off = await this.bridge.events(target.id, HOST_PAGE_EVENTS, (method, params) => {
        if (this.#targets.has(target.id)) this.#send(target.relay, { method, params, sessionId: target.id });
      });
      if (this.#targets.has(target.id)) target.off = off; else off();
    } catch (cause) {
      this.#close(target, false);
      throw cause;
    }
    return target;
  }

  /** `announce` tells the core the target is gone, as a browser does when a page closes. */
  #close(target: Target, announce: boolean): void {
    if (!this.#targets.delete(target.id)) return;
    target.off?.();
    this.bridge.destroy(target.id);
    if (announce) {
      this.#send(target.relay, { method: 'Target.detachedFromTarget', params: { sessionId: target.id, targetId: target.id } });
      this.#send(target.relay, { method: 'Target.targetDestroyed', params: { targetId: target.id } });
    }
  }

  #bridgeEvent(event: BrowserEvent): void {
    const target = this.#targets.get(event.id);
    if (!target || this.#stopped) return;
    if (event.type === 'url' || event.type === 'title') {
      if (event.type === 'url') target.url = event.url; else target.title = event.title;
      this.#send(target.relay, { method: 'Target.targetInfoChanged', params: { targetInfo: this.#info(target) } });
    } else if (event.type === 'destroyed') {
      // Closed by the shell itself (a deleted profile, a reload): the core hears it as a closed page.
      this.#targets.delete(target.id); target.off?.();
      this.#send(target.relay, { method: 'Target.targetDestroyed', params: { targetId: target.id } });
    } else if (event.type === 'new-window') {
      // A sign-in popup: a webview of the same profile, adopted by the core as a tab of the opener's conversation.
      void this.#open(target.relay, target.profile, event.url, target.context).then(popup => {
        this.#send(target.relay, { method: 'Target.targetCreated', params: { targetInfo: this.#info(popup, target.id) } });
      }, () => {});
    }
  }

  /** Answers and events of one profile leave in order, as few calls as a burst allows. */
  #send(profile: string, value: Record<string, unknown>): void {
    if (this.#stopped) return;
    const queue = this.#outbox.get(profile);
    const text = JSON.stringify(value);
    if (queue) { queue.push(text); return; }
    this.#outbox.set(profile, [text]);
    const previous = this.#sending.get(profile) ?? Promise.resolve();
    const next = previous.then(async () => {
      await Promise.resolve();
      const batch = this.#outbox.get(profile) ?? [];
      this.#outbox.delete(profile);
      for (let at = 0; at < batch.length; at += BROWSER_HOST_BATCH_MAX) {
        await this.client.call('browser.hostReply', { profile, messages: batch.slice(at, at + BROWSER_HOST_BATCH_MAX) }).catch(() => {});
      }
    });
    this.#sending.set(profile, next);
  }
}
