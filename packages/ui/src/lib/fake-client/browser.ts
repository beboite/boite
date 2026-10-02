import { browserActionError, remoteBrowserInputError, type RemoteBrowserFrame, type BrowserReply } from '@boite/contracts';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

export function browserMethods(ctx: FakeContext): Pick<FakeMethods, 'browser.host' | 'browser.command' | 'browser.complete' | 'browser.remoteFrame' | 'browser.remoteInput'> {
  const hosts = new Map<string, number>();
  const shared = new Set<string>(), frames = new Map<string, RemoteBrowserFrame[]>();
  const pending = new Map<string, { threadId: string; resolve(value: BrowserReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const release = (threadId?: string) => {
    if (threadId) { hosts.delete(threadId); shared.delete(threadId); frames.delete(threadId); } else { hosts.clear(); shared.clear(); frames.clear(); }
    for (const [id, item] of pending) if (!threadId || item.threadId === threadId) {
      clearTimeout(item.timer); pending.delete(id); item.reject(refusal('the browser host left this conversation'));
    }
  };
  ctx.bus.onState(state => { if (state !== 'ready') release(); });
  ctx.bus.on('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.on('thread.removed', ({ threadId }) => release(threadId));
  const allowed = (threadId: string) => {
    if (ctx.thread(threadId).archived || !ctx.bus.subscribed.has(threadId)) throw refusal('subscribe to the active conversation before watching its browser');
    if ((hosts.get(threadId) ?? 0) < Date.now()) throw refusal('Open this conversation in the Boite desktop app to share its browser.');
    if (!shared.has(threadId)) throw refusal('Enable the remote-browser experiment on the hosting desktop first.');
  };
  const methods: ReturnType<typeof browserMethods> = {
    'browser.remoteFrame': async ({ threadId }) => {
      allowed(threadId);
      const reply = await methods['browser.command']({ threadId, action: { kind: 'remote-frame' } }); allowed(threadId);
      if (!reply.frame) throw refusal('the desktop returned an invalid browser frame');
      frames.set(threadId, [...(frames.get(threadId) ?? []), reply.frame].slice(-8)); return reply.frame;
    },
    'browser.remoteInput': async ({ threadId, frameId, input }) => {
      allowed(threadId); const problem = remoteBrowserInputError(input); if (problem) throw refusal(problem);
      const frame = frames.get(threadId)?.find(f => f.id === frameId && Date.now() - f.at < 5000);
      if (!frame) throw refusal('refresh the live browser before interacting');
      if (input.kind === 'tap' && (input.width !== frame.width || input.height !== frame.height)) throw refusal('the browser viewport changed; refresh before tapping');
      await methods['browser.command']({ threadId, tabId: frame.tabId, action: { kind: 'remote-input', frameId, input } }); return { ok: true };
    },
    'browser.host': async ({ threadId, enabled, allowAgentControl, remote = false }) => {
      if (typeof enabled !== 'boolean' || typeof remote !== 'boolean') throw refusal('browser.host enabled and remote must be booleans');
      const thread = ctx.thread(threadId);
      if (enabled && (thread.archived || !ctx.bus.subscribed.has(threadId))) throw refusal('browser.host needs a subscribed, active conversation');
      if (enabled && allowAgentControl !== true) {
        release(threadId);
        throw refusal('browser.host requires explicit consent: enable Agent browser control in Settings > Experiments on the hosting desktop');
      }
      if (enabled) hosts.set(threadId, Date.now() + 35000); else release(threadId);
      if (enabled && remote) shared.add(threadId); else { shared.delete(threadId); frames.delete(threadId); }
      return { ok: true };
    },
    'browser.command': async params => {
      if (ctx.thread(params.threadId).archived) throw refusal('browser.command needs an active conversation');
      const problem = browserActionError(params.action);
      if (problem) throw refusal(problem);
      if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(params.tabId))) throw refusal('browser tabId must come from browser status or open');
      if ((hosts.get(params.threadId) ?? 0) < Date.now() || !ctx.bus.subscribed.has(params.threadId)) {
        release(params.threadId);
        throw refusal('Open this conversation in the Boite desktop app and enable Agent browser control in Settings > Experiments.');
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
  return methods;
}
