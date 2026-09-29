/** Coordination between threads, on this core and on the other fake cores it trusts. */
import { RpcErrorCode, type AgentLetter, type CoordinationConfig, type CoordinationView, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** Every fake core of this page by id, what a remote letter or directory reaches. */
const cores = new Map<string, FakeContext>();

export function registerCore(ctx: FakeContext): void {
  cores.set(ctx.identity.coreId, ctx);
}

export function unregisterCore(ctx: FakeContext): void {
  if (cores.get(ctx.identity.coreId) === ctx) cores.delete(ctx.identity.coreId);
}

function coordinationConfig(ctx: FakeContext, threadId: ThreadId): CoordinationConfig {
  return ctx.coordination.get(threadId) ?? { mode: 'off', resources: '', remote: false, paused: false };
}

function coordinationView(ctx: FakeContext, threadId: ThreadId): CoordinationView {
  const config = coordinationConfig(ctx, threadId);
  const letters = ctx.letters.get(threadId) ?? [];
  const sendLimit = config.mode === 'brief' ? 6 : config.mode === 'team' ? 40 : 0;
  const wakeLimit = config.mode === 'brief' ? 2 : config.mode === 'team' ? 12 : 0;
  return {
    self: { coreId: ctx.identity.coreId, threadId },
    config: structuredClone(config),
    messages: structuredClone(letters),
    sent: letters.filter(letter => letter.from.coreId === ctx.identity.coreId && letter.from.threadId === threadId && letter.createdAt > ctx.now() - 3_600_000).length,
    sendLimit,
    wakes: 0,
    wakeLimit
  };
}

export function coordinationMethods(ctx: FakeContext) {
  return {
    'collaboration.get': async (params) => {
      const { threadId } = params;
      ctx.thread(threadId);
      return coordinationView(ctx, threadId);
    },
    'collaboration.configure': async (params) => {
      const { threadId, config } = params;
      ctx.thread(threadId);
      if (!['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'config: expected mode, resources, remote and paused' });
      }
      ctx.coordination.set(threadId, { ...config, resources: config.resources.trim() });
      ctx.emit('collaboration.changed', { threadId });
      return coordinationView(ctx, threadId);
    },
    'collaboration.directory': async (params) => {
      const { threadId } = params;
      const source = ctx.thread(threadId);
      const sourceConfig = coordinationConfig(ctx, threadId);
      if (sourceConfig.mode === 'off') return { agents: [], unavailable: [] };
      const agents = [...ctx.threads.values()]
        .filter(thread => thread.id !== threadId && !thread.archived && (thread.projectId === source.projectId || sourceConfig.remote && coordinationConfig(ctx, thread.id).remote))
        .map(thread => {
          const config = coordinationConfig(ctx, thread.id);
          return {
            coreId: ctx.identity.coreId,
            threadId: thread.id,
            title: thread.title,
            machine: ctx.identity.name,
            resources: config.resources,
            status: thread.status,
            mode: config.mode
          };
        })
        .filter(agent => agent.mode !== 'off');
      const unavailable: string[] = [];
      if (sourceConfig.remote) for (const peer of ctx.peers.values()) {
        const target = cores.get(peer.coreId);
        if (!target || !target.peers.has(ctx.identity.coreId)) { unavailable.push(peer.name); continue; }
        for (const thread of target.threads.values()) {
          const config = coordinationConfig(target, thread.id);
          if (thread.archived || config.mode === 'off' || !config.remote) continue;
          agents.push({ coreId: peer.coreId, threadId: thread.id, title: thread.title, machine: peer.name, resources: config.resources, status: thread.status, mode: config.mode });
        }
      }
      return { agents, unavailable };
    },
    'collaboration.send': async (params) => {
      const source = ctx.thread(params.threadId);
      const config = coordinationConfig(ctx, source.id);
      if (config.mode === 'off' || config.paused) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination is off or paused for this thread' });
      }
      const existing = ctx.letters.get(source.id)?.find(letter => letter.id === params.requestId);
      if (existing) {
        if (existing.text !== params.text.trim() || existing.to.coreId !== params.to.coreId || existing.to.threadId !== params.to.threadId || existing.replyTo !== (params.replyTo ?? null)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        return structuredClone(existing);
      }
      if (!params.text.trim() || params.text.length > 4000 || coordinationView(ctx, source.id).sent >= (config.mode === 'brief' ? 6 : 40)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'message size or hourly budget exceeded' });
      const destination = params.to.coreId === ctx.identity.coreId ? ctx : cores.get(params.to.coreId);
      const target = destination ? destination.threads.get(params.to.threadId) : undefined;
      if (!target || target.archived || coordinationConfig(destination!, target.id).mode === 'off') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'recipient is unavailable for coordination' });
      }
      if (destination === ctx && target.projectId !== source.projectId && !(config.remote && coordinationConfig(ctx, target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'both threads must allow coordination across projects' });
      }
      if (destination !== ctx && (!config.remote || !ctx.peers.has(params.to.coreId) || !destination || !destination.peers.has(ctx.identity.coreId) || !coordinationConfig(destination, target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'remote core is not trusted' });
      }
      const letter: AgentLetter = {
        id: params.requestId,
        from: {
          coreId: ctx.identity.coreId,
          threadId: source.id,
          title: source.title,
          machine: ctx.identity.name,
          resources: config.resources,
          status: source.status,
          mode: config.mode
        },
        to: params.to,
        toTitle: target?.title ?? ctx.peers.get(params.to.coreId)?.name ?? params.to.threadId,
        text: params.text.trim(),
        replyTo: params.replyTo ?? null,
        createdAt: ctx.now(),
        expiresAt: ctx.now() + 15 * 60_000,
        status: 'delivered',
        error: null
      };
      ctx.letters.set(source.id, [...(ctx.letters.get(source.id) ?? []), letter]);
      ctx.emit('collaboration.changed', { threadId: source.id });
      destination!.letters.set(target.id, [...(destination!.letters.get(target.id) ?? []), letter]);
      destination!.emit('collaboration.changed', { threadId: target.id });
      return structuredClone(letter);
    },
    'collaboration.identity': async (params) => {
      return structuredClone(ctx.identity);
    },
    'collaboration.peers': async (params) => {
      return structuredClone([...ctx.peers.values()]);
    },
    'collaboration.check': async (params) => {
      const { coreId } = params;
      const peer = ctx.peers.get(coreId);
      const target = cores.get(coreId);
      if (!peer || !target || !target.peers.has(ctx.identity.coreId) || target.identity.url !== peer.url) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'machine is unreachable or mutual trust is missing' });
      }
      return { ok: true };
    },
    'collaboration.trust': async (params) => {
      const { peer } = params;
      let url: URL;
      try { url = new URL(peer.url); } catch { throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer.url: expected an HTTPS or loopback URL' }); }
      const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !loopback)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'peer.url: expected HTTPS origin, or numeric loopback HTTP' });
      if (!peer.coreId || !peer.publicKey || peer.coreId === ctx.identity.coreId) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer: expected another core public identity' });
      ctx.peers.set(peer.coreId, structuredClone(peer));
      return structuredClone(peer);
    },
    'collaboration.untrust': async (params) => {
      const { coreId } = params;
      ctx.peers.delete(coreId);
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
