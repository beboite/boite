import { browserActionError, remoteBrowserInputError, remoteFrameOptionsError, REMOTE_URL_MAX, type RemoteBrowserFrame, type BrowserReply, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';

/** `agent` and `remote` are the desktop's two separate consents: agent control, and sharing with paired devices. */
interface Host { connection: Connection; expires: number; agent: boolean; remote: boolean }
interface Pending {
  threadId: string; connectionId: string; capture: boolean; timer: ReturnType<typeof setTimeout>;
  resolve(result: BrowserReply): void; reject(error: Error): void;
}

/** A sharing desktop renews this every 20 seconds while its remote-browser switch is on. */
const READY_MS = 35000;
const OPEN_INTERVAL_MS = 2000;

/** One owner desktop answers a request, never a broadcast or an agent socket. */
export class BrowserControl {
  private hosts = new Map<string, Host>();
  private pending = new Map<string, Pending>();
  private remoteFrames = new Map<string, { threadId: string; hostId: string; frames: RemoteBrowserFrame[]; requestedAt: number }>();
  /** Owner desktops that share their browser and can open a conversation's tab when a viewer asks. */
  private ready = new Map<string, { connection: Connection; expires: number }>();
  private opened = new Map<string, number>();
  constructor(private core: Core, private timeout = 20000) {}

  host({ threadId, enabled, allowAgentControl, remote = false }: RpcParams<'browser.host'>, connection: Connection): { ok: true } {
    if (typeof enabled !== 'boolean' || typeof remote !== 'boolean') throw refused('browser.host enabled and remote must be booleans');
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
      this.hosts.set(threadId, { connection, expires: Date.now() + 35000, agent, remote });
      if (!remote) for (const [id, value] of this.remoteFrames) if (value.threadId === threadId) this.remoteFrames.delete(id);
    }
    return { ok: true };
  }

  remoteReady({ enabled }: RpcParams<'browser.remoteReady'>, connection: Connection): { ok: true } {
    if (typeof enabled !== 'boolean') throw refused('browser.remoteReady enabled must be a boolean');
    if (enabled) this.ready.set(connection.id, { connection, expires: Date.now() + READY_MS });
    else this.ready.delete(connection.id);
    return { ok: true };
  }

  /**
   * The phone cannot reach the PC's screen, so it asks the desktop that shares
   * its browser to show this conversation and a browser tab. The desktop that
   * hosts the conversation now wins; otherwise the one that renewed last.
   */
  remoteOpen({ threadId }: RpcParams<'browser.remoteOpen'>, connection: Connection): { ok: true } {
    if (this.core.threads.require(threadId).archived || !connection.subscriptions.has(threadId)) throw refused('subscribe to the active conversation before watching its browser');
    const key = `${connection.id}:${threadId}`, now = Date.now();
    if (now - (this.opened.get(key) ?? 0) < OPEN_INTERVAL_MS) throw refused('wait before asking the desktop again');
    for (const [id, value] of this.ready) if (value.expires < now) this.ready.delete(id);
    const host = this.hosts.get(threadId);
    const target = host && host.expires > now && host.remote && this.ready.has(host.connection.id)
      ? host.connection
      : [...this.ready.values()].sort((a, b) => b.expires - a.expires)[0]?.connection;
    if (!target) throw refused('No desktop is sharing its browser. Open Boite on the PC with Live browser on other devices enabled.');
    if (this.opened.size > 256) this.opened.clear();
    this.opened.set(key, now);
    target.sendEvent('browser.remoteOpenRequested', { threadId });
    return { ok: true };
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
    for (const [id, value] of this.remoteFrames) if (value.threadId === threadId) this.remoteFrames.delete(id);
    this.settle(threadId, true, 'the browser host left this conversation');
  }
  disconnect(connectionId: string): void {
    this.ready.delete(connectionId);
    for (const id of this.remoteFrames.keys()) if (id.startsWith(`${connectionId}:`)) this.remoteFrames.delete(id);
    for (const id of this.opened.keys()) if (id.startsWith(`${connectionId}:`)) this.opened.delete(id);
    for (const [id, host] of this.hosts) if (host.connection.id === connectionId) this.release(id);
  }
  close(): void { this.ready.clear(); for (const id of this.hosts.keys()) this.release(id); }
}
