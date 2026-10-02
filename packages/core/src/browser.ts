import { browserActionError, type BrowserReply, type RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';

interface Host { connection: Connection; expires: number }
interface Pending {
  threadId: string; connectionId: string; timer: ReturnType<typeof setTimeout>;
  resolve(result: BrowserReply): void; reject(error: Error): void;
}

/** One owner desktop answers a request, never a broadcast or an agent socket. */
export class BrowserControl {
  private hosts = new Map<string, Host>();
  private pending = new Map<string, Pending>();
  constructor(private core: Core, private timeout = 20000) {}

  host({ threadId, enabled, allowAgentControl }: RpcParams<'browser.host'>, connection: Connection): { ok: true } {
    const thread = this.core.threads.require(threadId);
    if (enabled && (thread.archived || !connection.subscriptions.has(threadId))) throw refused('browser.host needs a subscribed, active conversation');
    const previous = this.hosts.get(threadId);
    if (enabled && allowAgentControl !== true) {
      if (previous?.connection.id === connection.id) this.release(threadId);
      throw refused('browser.host requires explicit consent: enable Agent browser control in Settings > Experiments on the hosting desktop');
    }
    if (!enabled) {
      if (previous?.connection.id === connection.id) this.release(threadId);
    } else {
      if (previous && previous.expires > Date.now() && previous.connection.id !== connection.id) throw refused('this conversation already has a browser host on another desktop');
      this.hosts.set(threadId, { connection, expires: Date.now() + 35000 });
    }
    return { ok: true };
  }

  command(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
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
    if (this.pending.size >= 16 || [...this.pending.values()].some(p => p.threadId === threadId)) throw refused('the browser is busy; wait for the previous command');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(refused('the desktop browser did not answer within 20 seconds'));
      }, this.timeout);
      this.pending.set(requestId, { threadId, connectionId: host.connection.id, timer, resolve, reject });
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

  release(threadId: string): void {
    this.hosts.delete(threadId);
    for (const [id, pending] of this.pending) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer); this.pending.delete(id);
      pending.reject(refused('the browser host left this conversation'));
    }
  }
  disconnect(connectionId: string): void {
    for (const [id, host] of this.hosts) if (host.connection.id === connectionId) this.release(id);
  }
  close(): void { for (const id of this.hosts.keys()) this.release(id); }
}
