import { browserActionError, remoteBrowserInputError, remoteFrameOptionsError, REMOTE_URL_MAX, type RemoteBrowserFrame, type BrowserReply, type RpcParams } from '@boite/contracts';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'browser.host' | 'browser.command' | 'browser.complete' | 'browser.remoteFrame' | 'browser.remoteInput' | 'browser.remoteStatus';

/** Mirrors packages/core/src/browser.ts for one client that is both the desktop and the viewer. */
export function browserMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  const hosts = new Map<string, { expires: number; agent: boolean; live: boolean }>();
  const shared = new Set<string>(), frames = new Map<string, RemoteBrowserFrame[]>();
  const requestedAt = new Map<string, number>(), announced = new Set<string>();
  const pending = new Map<string, { threadId: string; capture: boolean; resolve(value: BrowserReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (threadId: string | undefined, all: boolean, reason: string) => {
    for (const [id, item] of pending) if ((!threadId || item.threadId === threadId) && (all || !item.capture)) {
      clearTimeout(item.timer); pending.delete(id); item.reject(refusal(reason));
    }
  };
  const release = (threadId?: string) => {
    if (threadId) { hosts.delete(threadId); shared.delete(threadId); frames.delete(threadId); requestedAt.delete(threadId); } else { hosts.clear(); shared.clear(); frames.clear(); requestedAt.clear(); }
    for (const id of threadId ? [threadId] : [...announced]) changed(id);
    settle(threadId, true, 'the browser host left this conversation');
  };
  ctx.bus.onState(state => { if (state !== 'ready') release(); });
  ctx.bus.on('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.on('thread.removed', ({ threadId }) => release(threadId));
  const live = (threadId: string) => (hosts.get(threadId)?.expires ?? 0) >= Date.now();
  const showing = (threadId: string) => live(threadId) && shared.has(threadId) && !!hosts.get(threadId)?.live;
  function changed(threadId: string) {
    const now = showing(threadId);
    if (now === announced.has(threadId)) return;
    if (now) announced.add(threadId); else announced.delete(threadId);
    ctx.emitToThread(threadId, 'browser.remoteChanged', { threadId, live: now });
  }
  const allowed = (threadId: string) => {
    if (ctx.thread(threadId).archived || !ctx.bus.subscribed.has(threadId)) throw refusal('subscribe to the active conversation before watching its browser');
    if (!live(threadId)) throw refusal('Open this conversation in the Boite desktop app to share its browser.');
    if (!shared.has(threadId)) throw refusal('Enable the remote-browser experiment on the hosting desktop first.');
  };
  const dispatch = (params: RpcParams<'browser.command'>): Promise<BrowserReply> => {
    if (ctx.thread(params.threadId).archived) throw refusal('browser.command needs an active conversation');
    const problem = browserActionError(params.action);
    if (problem) throw refusal(problem);
    if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(params.tabId))) throw refusal('browser tabId must come from browser status or open');
    if (!live(params.threadId)) {
      release(params.threadId);
      throw refusal('Open this conversation in the Boite desktop app and enable Agent browser control in Settings > Experiments.');
    }
    const capture = params.action.kind === 'remote-frame';
    if (pending.size >= 16 || [...pending.values()].some(p => p.threadId === params.threadId && p.capture === capture)) throw refusal('the browser is busy; wait for the previous command');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(refusal('the desktop browser did not answer within 20 seconds')); }, 20000);
      pending.set(requestId, { threadId: params.threadId, capture, resolve, reject, timer });
      ctx.bus.deliver('browser.requested', { ...params, requestId });
    });
  };
  const methods: ReturnType<typeof browserMethods> = {
    'browser.remoteFrame': async ({ threadId, maxWidth, quality }) => {
      allowed(threadId);
      const options = { ...(maxWidth === undefined ? {} : { maxWidth }), ...(quality === undefined ? {} : { quality }) };
      const problem = remoteFrameOptionsError(options);
      if (problem) throw refusal(problem);
      if (Date.now() - (requestedAt.get(threadId) ?? 0) < 220) throw refusal('wait before requesting another browser frame');
      requestedAt.set(threadId, Date.now());
      const state = frames.get(threadId) ?? [];
      frames.set(threadId, state);
      const reply = await dispatch({ threadId, action: { kind: 'remote-frame', ...options } }); allowed(threadId);
      if (frames.get(threadId) !== state) throw refusal('the shared browser changed');
      const frame = reply.frame;
      if (!frame || typeof frame.id !== 'string' || frame.id.length > 80 || !/^browser:[a-zA-Z0-9:-]{1,100}$/.test(frame.tabId) ||
        typeof frame.base64 !== 'string' || frame.base64.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64) ||
        ![frame.width, frame.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw refusal('the desktop returned an invalid browser frame');
      frame.title = String(frame.title ?? '').slice(0, 200); frame.at = Date.now();
      if (frame.url !== undefined) frame.url = String(frame.url).slice(0, REMOTE_URL_MAX);
      state.push({ ...frame, base64: '' });
      frames.set(threadId, state.filter(f => Date.now() - f.at < 5000).slice(-8)); return frame;
    },
    'browser.remoteInput': async ({ threadId, frameId, input }) => {
      allowed(threadId); const problem = remoteBrowserInputError(input); if (problem) throw refusal(problem);
      const frame = frames.get(threadId)?.find(f => f.id === frameId && Date.now() - f.at < 5000);
      if (!frame) throw refusal('refresh the live browser before interacting');
      if (input.kind === 'tap' && (input.width !== frame.width || input.height !== frame.height)) throw refusal('the browser viewport changed; refresh before tapping');
      await dispatch({ threadId, tabId: frame.tabId, action: { kind: 'remote-input', frameId, input } }); return { ok: true };
    },
    'browser.remoteStatus': async ({ threadId }) => {
      if (ctx.thread(threadId).archived || !ctx.bus.subscribed.has(threadId)) throw refusal('subscribe to the active conversation before watching its browser');
      return { live: showing(threadId) };
    },
    'browser.host': async ({ threadId, enabled, allowAgentControl, remote = false, live: tab = false }) => {
      if (typeof enabled !== 'boolean' || typeof remote !== 'boolean' || typeof tab !== 'boolean') throw refusal('browser.host enabled, remote and live must be booleans');
      const thread = ctx.thread(threadId);
      if (enabled && thread.archived) throw refusal('browser.host needs an active conversation');
      if (enabled && allowAgentControl !== true && !remote) {
        release(threadId);
        throw refusal('browser.host requires explicit consent: enable Agent browser control or Live browser on other devices in Settings > Experiments on the hosting desktop');
      }
      if (!enabled) { release(threadId); return { ok: true }; }
      const agent = allowAgentControl === true;
      if (hosts.get(threadId)?.agent && !agent) settle(threadId, false, 'agent browser control was turned off on the desktop');
      hosts.set(threadId, { expires: Date.now() + 35000, agent, live: tab });
      if (remote) shared.add(threadId); else { shared.delete(threadId); frames.delete(threadId); requestedAt.delete(threadId); }
      changed(threadId);
      return { ok: true };
    },
    'browser.command': async params => {
      const host = hosts.get(params.threadId);
      if (host && host.expires >= Date.now() && !host.agent) {
        ctx.thread(params.threadId);
        throw refusal('Open this conversation in the Boite desktop app and enable Agent browser control in Settings > Experiments.');
      }
      return dispatch(params);
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
