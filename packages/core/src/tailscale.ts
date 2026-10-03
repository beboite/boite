/*
 * HTTPS for the phone through `tailscale serve`.
 *
 * An installed iPhone app needs HTTPS, and a tailnet already gives every
 * machine a MagicDNS name with a certificate. This module reads the tailscale
 * CLI's state, then on the owner's word runs
 * `tailscale serve --bg --https=443 http://127.0.0.1:<port>` and makes
 * `https://<name>` the public URL, which pairing links name and the server
 * already admits as an origin. Turning it off runs `serve --https=443 off`
 * and clears the public URL it set.
 *
 * 443 belongs to the machine, not to Boite: whatever else it already serves
 * is a `conflict`, left alone unless the owner asks to replace it. The CLI's
 * own output never reaches a client, since a failing tailscale command can echo
 * an auth key; failures are reduced to a few safe labels. The CLI is found by
 * the platform layer; `BOITE_TAILSCALE_CLI` points at another one, a fake in
 * the tests.
 */

import type { TailscaleStatus } from '@boite/contracts';
import type { Core } from './core.ts';
import { processPlatform } from './platform/index.ts';

const STATUS_TIMEOUT_MS = 5_000;
const SERVE_TIMEOUT_MS = 15_000;
const HTTPS_PORT = '443';
/** Where the owner turns on MagicDNS and HTTPS certificates. */
export const TAILSCALE_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type Detail = NonNullable<TailscaleStatus['detail']>;

/** A failing command's output reduced to a label safe to show. */
export function classifyFailure(output: string): Detail {
  const text = output.toLowerCase();
  if (/login\.tailscale\.com\/f\/serve|serve is not enabled|https is not enabled|enable https/.test(text)) return 'serve-consent';
  if (/not logged in|needslogin|logged out|log in/.test(text)) return 'not-logged-in';
  if (/access denied|permission denied|operator|sudo|requires root|not allowed/.test(text)) return 'permission-denied';
  return 'unknown';
}

/** The Tailscale page a command printed for the owner to open, kept only when it is one of Tailscale's own. */
export function tailscaleUrl(output: string): string | undefined {
  const match = /https:\/\/login\.tailscale\.com\/[\w./?=&%-]+/.exec(output);
  return match?.[0];
}

/** `skoll.tail0.ts.net.` as `skoll.tail0.ts.net`; null for anything that is not a DNS name. */
export function normalizeDnsName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trimmed) ? trimmed : null;
}

/** What 443 proxies to under `dnsName`, from `tailscale serve status --json`: null when nothing is served there. */
export function servedOn443(config: unknown, dnsName: string): string | null {
  if (config === null || typeof config !== 'object') return null;
  const { TCP, Web } = config as { TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }> };
  const handlers = Web?.[`${dnsName}:${HTTPS_PORT}`]?.Handlers ?? {};
  const mounts = Object.entries(handlers);
  if (mounts.length > 0) {
    const root = handlers['/'];
    // One mount at the root proxying somewhere is the shape this module writes; anything else is described, not parsed.
    if (mounts.length === 1 && root?.Proxy) return root.Proxy;
    return mounts.map(([path, handler]) => `${path} → ${handler.Proxy ?? handler.Path ?? 'text'}`).join(', ');
  }
  const tcp = TCP?.[HTTPS_PORT];
  if (tcp?.TCPForward) return `tcp://${tcp.TCPForward}`;
  if (tcp) return 'https';
  return null;
}

/** True when `served` is a loopback proxy to `port`. */
export function proxiesTo(served: string, port: string): boolean {
  try {
    const url = new URL(served.includes('://') ? served : `http://${served}`);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === port;
  } catch {
    return false;
  }
}

export interface TailscaleOptions {
  /** The command that is the CLI, executable first. Defaults to `BOITE_TAILSCALE_CLI`, then the platform's lookup. */
  cli?: () => string[] | null;
}

function defaultCli(): string[] | null {
  const override = process.env['BOITE_TAILSCALE_CLI'];
  if (override) return /\.[cm]?[jt]s$/.test(override) ? [process.execPath, override] : [override];
  const found = processPlatform.tailscaleCli?.() ?? null;
  return found === null ? null : [found];
}

export class TailscaleAccess {
  constructor(private readonly core: Core, private readonly options: TailscaleOptions = {}) {}

  /** The address `tailscale serve` should proxy to: this core on loopback. */
  target(): string {
    const port = new URL(this.core.baseUrl()).port;
    return `http://127.0.0.1:${port}`;
  }

  async status(): Promise<TailscaleStatus> {
    const target = this.target();
    const base = { dnsName: null, url: null, servedTarget: null, target, publicUrlMatches: false };
    const cli = (this.options.cli ?? defaultCli)();
    if (cli === null) return { ...base, state: 'missing' };
    const status = await this.run(cli, ['status', '--json'], STATUS_TIMEOUT_MS);
    let parsed: { BackendState?: string; AuthURL?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null; CurrentTailnet?: { MagicDNSEnabled?: boolean } | null };
    try {
      parsed = JSON.parse(status.stdout) as typeof parsed;
    } catch {
      // No JSON: the daemon is not running, or the CLI could not reach it.
      if (status.timedOut) return { ...base, state: 'error', detail: 'timeout' };
      const detail = classifyFailure(status.stderr);
      return detail === 'permission-denied' ? { ...base, state: 'error', detail } : { ...base, state: 'stopped' };
    }
    const backend = parsed.BackendState ?? '';
    if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth') {
      const actionUrl = tailscaleUrl(parsed.AuthURL ?? '');
      return { ...base, state: 'needs-login', ...(actionUrl ? { actionUrl } : {}) };
    }
    if (backend !== 'Running') return { ...base, state: 'stopped' };
    const dnsName = normalizeDnsName(parsed.Self?.DNSName);
    if (dnsName === null || parsed.CurrentTailnet?.MagicDNSEnabled === false || !(parsed.CertDomains ?? []).some((domain) => normalizeDnsName(domain) === dnsName)) {
      return { ...base, dnsName, state: 'https-disabled', actionUrl: TAILSCALE_DNS_ADMIN };
    }
    const url = `https://${dnsName}`;
    const publicUrlMatches = this.core.settings.get().publicUrl === url;
    const serve = await this.run(cli, ['serve', 'status', '--json'], STATUS_TIMEOUT_MS);
    let config: unknown = {};
    if (serve.stdout.trim() !== '') {
      try {
        config = JSON.parse(serve.stdout);
      } catch {
        return { ...base, dnsName, url, publicUrlMatches, state: 'error', detail: serve.timedOut ? 'timeout' : classifyFailure(serve.stderr) };
      }
    } else if (serve.code !== 0) {
      return { ...base, dnsName, url, publicUrlMatches, state: 'error', detail: serve.timedOut ? 'timeout' : classifyFailure(serve.stderr) };
    }
    const servedTarget = servedOn443(config, dnsName);
    const port = new URL(target).port;
    const state = servedTarget === null ? 'off' : proxiesTo(servedTarget, port) ? 'on' : 'conflict';
    return { ...base, dnsName, url, servedTarget, publicUrlMatches, state };
  }

  /**
   * Serve this core on 443 and make its URL the public one. A state that is
   * not ready comes back as it is, for the client to explain; a conflict too,
   * unless `replace` says the owner confirmed taking 443 over.
   */
  async enable(replace = false): Promise<TailscaleStatus> {
    if (typeof replace !== 'boolean') replace = false;
    const before = await this.status();
    if (before.state === 'on') return this.adopt(before);
    if (before.state === 'conflict' && !replace) return before;
    if (before.state !== 'off' && before.state !== 'conflict') return before;
    const cli = (this.options.cli ?? defaultCli)();
    if (cli === null) return { ...before, state: 'missing' };
    if (before.state === 'conflict') {
      const off = await this.run(cli, ['serve', `--https=${HTTPS_PORT}`, 'off'], SERVE_TIMEOUT_MS);
      if (off.code !== 0) return this.failed(before, off);
    }
    const on = await this.run(cli, ['serve', '--bg', `--https=${HTTPS_PORT}`, before.target], SERVE_TIMEOUT_MS);
    const after = await this.status();
    if (after.state === 'on') return this.adopt(after);
    return this.failed(after, on);
  }

  /** Stop serving this core and clear the public URL this module set. Something else on 443 is left alone. */
  async disable(): Promise<TailscaleStatus> {
    const before = await this.status();
    if (before.state === 'on') {
      const cli = (this.options.cli ?? defaultCli)();
      if (cli !== null) {
        const off = await this.run(cli, ['serve', `--https=${HTTPS_PORT}`, 'off'], SERVE_TIMEOUT_MS);
        if (off.code !== 0) return this.failed(before, off);
      }
    }
    const after = before.state === 'on' ? await this.status() : before;
    if (after.url !== null && this.core.settings.get().publicUrl === after.url && after.state !== 'on') {
      this.core.settings.set({ publicUrl: null });
      return { ...after, publicUrlMatches: false };
    }
    return after;
  }

  private adopt(status: TailscaleStatus): TailscaleStatus {
    if (status.url !== null && !status.publicUrlMatches) this.core.settings.set({ publicUrl: status.url });
    return { ...status, publicUrlMatches: status.url !== null };
  }

  private failed(status: TailscaleStatus, run: Run): TailscaleStatus {
    const output = `${run.stdout}\n${run.stderr}`;
    const consent = tailscaleUrl(output);
    // `serve --bg` on a tailnet that never allowed Serve prints a consent link and waits for it.
    if (consent !== undefined) return { ...status, detail: 'serve-consent', actionUrl: consent };
    return { ...status, detail: run.timedOut ? 'timeout' : classifyFailure(output) };
  }

  private async run(cli: string[], args: string[], timeoutMs: number): Promise<Run> {
    const [command, ...prefix] = cli;
    let child: ReturnType<Core['procs']['spawn']>;
    try {
      child = this.core.procs.spawn('system:tailscale', command!, [...prefix, ...args], { agentRoot: false });
    } catch (error) {
      return { code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Owner only: absent from `DEVICE_METHODS`, so a paired phone is refused them.
 * They change what the machine serves on its tailnet.
 */
export function registerTailscaleMethods(core: Core, access = new TailscaleAccess(core)): void {
  core.router.register('tailscale.status', () => access.status());
  core.router.register('tailscale.enable', (params) => access.enable(params?.replace === true));
  core.router.register('tailscale.disable', () => access.disable());
}
