/** Pairing grants, paired sessions, the Tailscale switch and the Web Push the fake refuses. */
import { PAIRING_CODE_TTL_MS, RpcErrorCode, type FirewallStatus, type TailscaleStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** A tailnet ready to serve the fake core: nothing on 443 yet. */
function fakeTailscale(): TailscaleStatus {
  const dnsName = 'boite-pc.tail0d6070.ts.net';
  return { state: 'off', dnsName, url: `https://${dnsName}`, servedTarget: null, target: 'http://127.0.0.1:8777', publicUrlMatches: false };
}

/**
 * Windows Defender Firewall as `?firewall=` sets it: `blocked` is a dismissed
 * prompt on a public network, `unset` a rule for public only on a private one,
 * `refused` a block whose administrator prompt nobody accepts. Anything else is
 * a machine that is not Windows.
 */
function fakeFirewall(): FirewallStatus {
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const state = query.get('firewall');
  if (state === 'blocked' || state === 'refused') return { state: 'blocked', networks: ['public'], allowed: [], blocked: ['public'] };
  if (state === 'unset') return { state, networks: ['private'], allowed: [], blocked: [] };
  return { state: 'unsupported', networks: [], allowed: [], blocked: [] };
}

export function pairingMethods(ctx: FakeContext) {
  let tailscale = fakeTailscale();
  let firewall = fakeFirewall();
  const refuses = typeof location !== 'undefined' && new URLSearchParams(location.search).get('firewall') === 'refused';
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
      return {
        url: `${origin}/?grant=${grant}`,
        grant,
        role,
        expiresAt,
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
    'firewall.status': async () => structuredClone(firewall),
    'firewall.allow': async () => {
      if (refuses) return { ...structuredClone(firewall), detail: 'cancelled' as const };
      if (firewall.state === 'blocked' || firewall.state === 'unset') firewall = { ...firewall, state: 'ready', allowed: [...firewall.networks], blocked: [] };
      return structuredClone(firewall);
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
