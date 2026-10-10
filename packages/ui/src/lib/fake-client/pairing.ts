/** Pairing grants, paired sessions, the Tailscale switch and the Web Push the fake refuses. */
import { PAIRING_CODE_TTL_MS, RpcErrorCode, type TailscaleStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** A tailnet ready to serve the fake core: nothing on 443 yet. */
function fakeTailscale(): TailscaleStatus {
  const dnsName = 'boite-pc.tail0d6070.ts.net';
  return { state: 'off', dnsName, url: `https://${dnsName}`, servedTarget: null, target: 'http://127.0.0.1:8777', publicUrlMatches: false };
}

export function pairingMethods(ctx: FakeContext) {
  let tailscale = fakeTailscale();
  const setPublicUrl = (publicUrl: string | null) => {
    ctx.settings = { ...ctx.settings, publicUrl };
    ctx.emit('settings.updated', structuredClone(ctx.settings));
  };
  return {
    'pairing.grant': async (params) => {
      const seq = ++ctx.seq;
      const grant = `fake-grant-${seq}`;
      const role = params?.role ?? 'device';
      const short = role === 'owner' && params?.short === true;
      const expiresAt = ctx.now() + (short ? PAIRING_CODE_TTL_MS : 10 * 60 * 1000);
      const origin = ctx.settings.publicUrl ?? 'http://192.168.1.20:8777';
      const url = `${origin}/?grant=${grant}`;
      return {
        url,
        grant,
        role,
        expiresAt,
        links: [
          { url, network: ctx.settings.publicUrl ? 'public' : 'lan', ...(ctx.settings.publicUrl ? {} : { interface: 'Wi-Fi' }) },
          { url: `http://100.101.102.103:8777/?grant=${grant}`, network: 'tailscale', interface: 'Tailscale' }
        ],
        ...(role === 'device' || short ? { code: `K7QM-${String(seq).padStart(4, '2')}`, codeExpiresAt: Math.min(expiresAt, ctx.now() + PAIRING_CODE_TTL_MS) } : {})
      };
    },
    'tailscale.status': async () => ({ ...tailscale, publicUrlMatches: ctx.settings.publicUrl === tailscale.url }),
    'tailscale.enable': async (params) => {
      if (tailscale.state === 'conflict' && params?.replace !== true) return tailscale;
      if (tailscale.state === 'off' || tailscale.state === 'conflict') tailscale = { ...tailscale, state: 'on', servedTarget: tailscale.target };
      if (tailscale.state === 'on') setPublicUrl(tailscale.url);
      return { ...tailscale, publicUrlMatches: tailscale.state === 'on' };
    },
    'tailscale.disable': async () => {
      if (tailscale.state === 'on') {
        tailscale = { ...tailscale, state: 'off', servedTarget: null };
        if (ctx.settings.publicUrl === tailscale.url) setPublicUrl(null);
      }
      return { ...tailscale, publicUrlMatches: false };
    },
    'sessions.list': async (params) => {
      return structuredClone(ctx.sessions);
    },
    'push.status': async (params) => {
      return { publicKey: '', subscribed: false };
    },
    'push.subscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.unsubscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.test': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'sessions.revoke': async (params) => {
      if (!ctx.sessions.some((session) => session.id === params.sessionId)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `unknown session ${params.sessionId}` });
      }
      ctx.sessions = ctx.sessions.filter((session) => session.id !== params.sessionId);
      ctx.emit('sessions.updated', { sessionId: params.sessionId, state: 'revoked' });
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
