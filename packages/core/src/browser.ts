import { browserActionError, remoteBrowserInputError, remoteFrameOptionsError, REMOTE_URL_MAX, type RemoteBrowserFrame, type BrowserReply, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';

/**
 * `agent` and `remote` are the desktop's two separate consents: agent control,
 * and sharing with paired devices. `live`: its panel has a browser tab to share.
 */
interface Host { connection: Connection; expires: number; agent: boolean; remote: boolean; live: boolean }
interface Pending {
  threadId: string; connectionId: string; capture: boolean; timer: ReturnType<typeof setTimeout>;
  resolve(result: BrowserReply): void; reject(error: Error): void;
}

/** One owner desktop answers a request, never a broadcast or an agent socket. */
export class BrowserControl {
  private hosts = new Map<string, Host>();
  private pending = new Map<string, Pending>();
  private remoteFrames = new Map<string, { threadId: string; hostId: string; frames: RemoteBrowserFrame[]; requestedAt: number }>();
  /** The conversations whose viewers were last told that a shared tab exists. */
  private announced = new Set<string>();
  private closed = false;
  constructor(private core: Core, private timeout = 20000) {}

  host({ threadId, enabled, allowAgentControl, remote = false, live = false }: RpcParams<'browser.host'>, connection: Connection): { ok: true } {
    if (typeof enabled !== 'boolean' || typeof remote !== 'boolean' || typeof live !== 'boolean') throw refused('browser.host enabled, remote and live must be booleans');
    const thread = this.core.threads.require(threadId);
    if (enabled && (thread.archived || !connection.subscriptions.has(threadId))) throw refused('browser.host needs a subscribed, active conversation');
    const previous = this.hosts.get(threadId);
    if (enabled && allowAgentControl !== true && !remote) {
      if (previous?.connection.id === connection.id) this.release(threadId);
      throw refused('browser.host requires explicit consent: enable Agent browser control or Live browser on other devices in Settings > Experiments on the hosting desktop');
    }
    if (!enabled) {
      if (previous?.connection.id === connection.id) this.release(threadId);
    } else {
      if (previous && previous.expires > Date.now() && previous.connection.id !== connection.id) throw refused('this conversation already has a browser host on another desktop');
      const agent = allowAgentControl === true;
      // Withdrawing one consent settles what was waiting on it.
      if (previous?.connection.id === connection.id && previous.agent && !agent) this.settle(threadId, false, 'agent browser control was turned off on the desktop');
      this.hosts.set(threadId, { connection, expires: Date.now() + 35000, agent, remote, live });
      this.changed(threadId);
      if (!remote) for (const [id, value] of this.remoteFrames) if (value.threadId === threadId) this.remoteFrames.delete(id);
    }
    return { ok: true };
  }

  /** A browser tab of this conversation that paired devices may watch now. */
  private live(threadId: string): boolean {
    const host = this.hosts.get(threadId);
    return !!host && host.expires >= Date.now() && host.remote && host.live && host.connection.subscriptions.has(threadId);
  }

  /** Tells the conversation's viewers when its shared tab appears or goes away. */
  private changed(threadId: string): void {
    const live = this.live(threadId);
    if (live === this.announced.has(threadId) || this.closed) return;
    if (live) this.announced.add(threadId); else this.announced.delete(threadId);
    this.core.bus.emit('browser.remoteChanged', { threadId, live });
  }

  remoteStatus({ threadId }: RpcParams<'browser.remoteStatus'>, connection: Connection): { live: boolean } {
    if (this.core.threads.require(threadId).archived || !connection.subscriptions.has(threadId)) throw refused('subscribe to the active conversation before watching its browser');
    return { live: this.live(threadId) };
  }

  private shared(threadId: string, connection: Connection): Host {
    if (this.core.threads.require(threadId).archived || !connection.subscriptions.has(threadId)) throw refused('subscribe to the active conversation before watching its browser');
    const host = this.hosts.get(threadId);
    if (!host || host.expires < Date.now() || !host.connection.subscriptions.has(threadId)) throw refused('Open this conversation in the Boite desktop app to share its browser.');
    if (!host.remote) throw refused('Enable the remote-browser experiment on the hosting desktop first.');
    return host;
  }

  async remoteFrame({ threadId, maxWidth, quality }: RpcParams<'browser.remoteFrame'>, connection: Connection): Promise<RemoteBrowserFrame> {
    const host = this.shared(threadId, connection), key = `${connection.id}:${threadId}`;
    const options = { ...(maxWidth === undefined ? {} : { maxWidth }), ...(quality === undefined ? {} : { quality }) };
    const problem = remoteFrameOptionsError(options);
    if (problem) throw refused(problem);
    const previous = this.remoteFrames.get(key);
    if (previous && Date.now() - previous.requestedAt < 220) throw refused('wait before requesting another browser frame');
    for (const [id, value] of this.remoteFrames) if (Date.now() - value.requestedAt > 10000) this.remoteFrames.delete(id);
    if (this.remoteFrames.size >= 32 && !previous) throw refused('too many remote browser viewers');
    const state = { threadId, hostId: host.connection.id, requestedAt: Date.now(), frames: previous?.frames ?? [] };
    this.remoteFrames.set(key, state);
    const reply = await this.dispatch({ threadId, action: { kind: 'remote-frame', ...options } });
    if (this.shared(threadId, connection).connection.id !== state.hostId || this.remoteFrames.get(key) !== state) throw refused('the shared browser changed');
    const frame = reply.frame;
    if (!frame || typeof frame.id !== 'string' || frame.id.length > 80 || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(frame.tabId) ||
      typeof frame.base64 !== 'string' || frame.base64.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64) ||
      ![frame.width, frame.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw refused('the desktop returned an invalid browser frame');
    frame.title = String(frame.title ?? '').slice(0, 200); frame.at = Date.now();
    if (frame.url !== undefined) frame.url = String(frame.url).slice(0, REMOTE_URL_MAX);
    state.frames.push({ ...frame, base64: '' }); state.frames = state.frames.filter(f => Date.now() - f.at < 5000).slice(-8);
    return frame;
  }

  async remoteInput({ threadId, frameId, input }: RpcParams<'browser.remoteInput'>, connection: Connection): Promise<{ ok: true }> {
    const host = this.shared(threadId, connection), problem = remoteBrowserInputError(input);
    if (problem) throw refused(problem);
    const state = this.remoteFrames.get(`${connection.id}:${threadId}`);
    const frame = state?.frames.find(f => f.id === frameId && Date.now() - f.at < 5000);
    if (!frame || state?.hostId !== host.connection.id) throw refused('refresh the live browser before interacting');
    if (input.kind === 'tap' && (input.width !== frame.width || input.height !== frame.height)) throw refused('the browser viewport changed; refresh before tapping');
    await this.dispatch({ threadId, tabId: frame.tabId, action: { kind: 'remote-input', frameId, input } });
    return { ok: true };
  }

  /** The agent's entry: only a host that consented to agent control answers it. */
  command(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
    const host = this.hosts.get(params.threadId);
    if (host && host.expires >= Date.now() && !host.agent) {
      this.core.threads.require(params.threadId);
      throw refused('Open this conversation in the Boite desktop app and enable Agent browser control in Settings > Experiments.');
    }
    return this.dispatch(params);
  }

  private dispatch(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
    const { threadId, tabId, action } = params;
    const thread = this.core.threads.require(threadId);
    if (thread.archived) throw refused('browser.command needs an active conversation');
    const problem = browserActionError(action);
    if (problem) throw refused(problem);
    if (tabId !== undefined && (typeof tabId !== 'string' || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(tabId))) throw refused('browser tabId must come from browser status or open');
    const host = this.hosts.get(threadId);
    if (!host || host.expires < Date.now() || !host.connection.subscriptions.has(threadId)) {
      this.release(threadId);
      throw refused('Open this conversation in the Boite desktop app and enable Agent browser control in Settings > Experiments.');
    }
    const capture = action.kind === 'remote-frame';
    if (this.pending.size >= 16 || [...this.pending.values()].some(p => p.threadId === threadId && p.capture === capture)) throw refused('the browser is busy; wait for the previous command');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(refused('the desktop browser did not answer within 20 seconds'));
      }, this.timeout);
      this.pending.set(requestId, { threadId, connectionId: host.connection.id, capture, timer, resolve, reject });
      try { host.connection.sendEvent('browser.requested', { ...params, requestId }); }
      catch { this.release(threadId); }
    });
  }

  complete({ requestId, result, error }: RpcParams<'browser.complete'>, connection: Connection): { ok: true } {
    const pending = this.pending.get(requestId);
    if (!pending || pending.connectionId !== connection.id) throw refused('browser.complete request does not belong to this desktop');
    this.pending.delete(requestId); clearTimeout(pending.timer);
    if (error !== undefined) pending.reject(refused(String(error).slice(0, 4000)));
    else if (!result || typeof result !== 'object' || JSON.stringify(result).length > 8 * 1024 * 1024) pending.reject(refused('browser result must be an object smaller than 8 MB'));
    else pending.resolve(result);
    return { ok: true };
  }

  /** Rejects the thread's waiting requests: all of them, or all but the remote frame captures. */
  private settle(threadId: string, all: boolean, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.threadId !== threadId || (!all && pending.capture)) continue;
      clearTimeout(pending.timer); this.pending.delete(id);
      pending.reject(refused(reason));
    }
  }

  release(threadId: string): void {
    this.hosts.delete(threadId);
    this.changed(threadId);
    for (const [id, value] of this.remoteFrames) if (value.threadId === threadId) this.remoteFrames.delete(id);
    this.settle(threadId, true, 'the browser host left this conversation');
  }
  disconnect(connectionId: string): void {
    for (const id of this.remoteFrames.keys()) if (id.startsWith(`${connectionId}:`)) this.remoteFrames.delete(id);
    for (const [id, host] of this.hosts) if (host.connection.id === connectionId) this.release(id);
  }
  close(): void { this.closed = true; for (const id of this.hosts.keys()) this.release(id); }
}
