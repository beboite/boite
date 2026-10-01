import { browserActionError, type BrowserReply } from '@boite/contracts';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

export function browserMethods(ctx: FakeContext): Pick<FakeMethods, 'browser.host' | 'browser.command' | 'browser.complete'> {
  const hosts = new Map<string, number>();
  const pending = new Map<string, { threadId: string; resolve(value: BrowserReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const release = (threadId?: string) => {
    if (threadId) hosts.delete(threadId); else hosts.clear();
    for (const [id, item] of pending) if (!threadId || item.threadId === threadId) {
      clearTimeout(item.timer); pending.delete(id); item.reject(refusal('the browser host left this conversation'));
    }
  };
  ctx.bus.onState(state => { if (state !== 'ready') release(); });
  ctx.bus.on('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.on('thread.removed', ({ threadId }) => release(threadId));
  return {
    'browser.host': async ({ threadId, enabled }) => {
      const thread = ctx.thread(threadId);
      if (enabled && (thread.archived || !ctx.bus.subscribed.has(threadId))) throw refusal('browser.host needs a subscribed, active conversation');
      if (enabled) hosts.set(threadId, Date.now() + 35000); else release(threadId);
      return { ok: true };
    },
    'browser.command': async params => {
      if (ctx.thread(params.threadId).archived) throw refusal('browser.command needs an active conversation');
      const problem = browserActionError(params.action);
      if (problem) throw refusal(problem);
      if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(params.tabId))) throw refusal('browser tabId must come from browser status or open');
      if ((hosts.get(params.threadId) ?? 0) < Date.now() || !ctx.bus.subscribed.has(params.threadId)) {
        release(params.threadId);
        throw refusal('Open this conversation in the Boite desktop app to use its browser.');
      }
      if (pending.size >= 16 || [...pending.values()].some(p => p.threadId === params.threadId)) throw refusal('the browser is busy; wait for the previous command');
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(refusal('the desktop browser did not answer within 20 seconds')); }, 20000);
        pending.set(requestId, { threadId: params.threadId, resolve, reject, timer });
        ctx.bus.deliver('browser.requested', { ...params, requestId });
      });
    },
    'browser.complete': async ({ requestId, result, error }) => {
      const item = pending.get(requestId);
      if (!item) throw refusal('browser.complete request does not belong to this desktop');
      pending.delete(requestId); clearTimeout(item.timer);
      if (error !== undefined) item.reject(refusal(String(error).slice(0, 4000)));
      else if (!result || typeof result !== 'object' || JSON.stringify(result).length > 8 * 1024 * 1024) item.reject(refusal('browser result must be an object smaller than 8 MB'));
      else item.resolve(result);
      return { ok: true };
    },
  };
}
