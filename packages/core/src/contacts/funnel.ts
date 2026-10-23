/*
 * Boite's contact routes on the internet, through Tailscale Funnel.
 *
 * A machine share reaches another tailscale.com tailnet and nothing else: a
 * Headscale tailnet, or a machine with no Tailscale, never meets this one's
 * coordination server, so its core can neither resolve nor reach this
 * machine's tailnet name. Funnel gives that name a public HTTPS address. This
 * module mounts on it the routes a contact dials (the join, the link and the
 * signed letters) and no other route of the core. Everything on them is signed
 * and sealed already (`group/seal.ts`): TLS takes the place WireGuard had.
 *
 * Funnel opens a whole port to the internet, so the mounts take 8443 or 10000,
 * the first one that serves nothing else, never 443, which the phone's
 * `tailscale serve` uses. The owner's invitation for another network is the
 * consent; the mounts leave once no contact or invitation needs them
 * (`release`, from `ContactStore.relisten`). The CLI's own output never
 * reaches a client.
 */
import type { Core } from '../core.ts';
import { messageOf, unavailable } from '../errors.ts';
import { defaultCli, normalizeDnsName, runCli, tailscaleUrl, TAILSCALE_DNS_ADMIN, type Run } from '../tailscale.ts';

/**
 * The loopback targets the mounts may proxy to, kept while they may be up: a
 * core stopped meanwhile takes them down at its next start, and one that came
 * back on another port still knows the old ones for its.
 */
const FUNNEL = 'contacts:funnel';
const STATUS_TIMEOUT_MS = 5_000;
/** `funnel --bg` on a node never allowed Funnel prints a consent link, then waits for it. */
const FUNNEL_TIMEOUT_MS = 15_000;
/** The ports Funnel accepts besides 443. */
export const FUNNEL_PORTS = [8443, 10000] as const;

type ServeConfig = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

export type Cli = () => string[] | null;

/** Where the routes are mounted, or why they cannot be. */
type Mounts = { port: number; missing: string[] } | null;

/**
 * The first Funnel port this module may use: one carrying only these mounts,
 * to one of `targets`, else one serving nothing at all. `missing` is what to
 * mount again: a route absent, not on the internet or proxied to an old target.
 */
export function funnelPort(config: ServeConfig, dnsName: string, paths: readonly string[], targets: readonly string[]): Mounts {
  const [current] = targets;
  let free: number | null = null;
  for (const port of FUNNEL_PORTS) {
    const handlers = config.Web?.[`${dnsName}:${port}`]?.Handlers ?? {};
    const mounts = Object.entries(handlers);
    if (mounts.length === 0) {
      // A TCP forward with no web mount is someone else's port.
      if (config.TCP?.[String(port)] === undefined) free ??= port;
      continue;
    }
    if (!mounts.every(([path, handler]) => paths.includes(path) && targets.some(target => handler.Proxy === `${target}${path}`))) continue;
    const funneled = config.AllowFunnel?.[`${dnsName}:${port}`] === true;
    return { port, missing: paths.filter(path => !funneled || handlers[path]?.Proxy !== `${current}${path}`) };
  }
  return free === null ? null : { port: free, missing: [...paths] };
}

export class ContactFunnel {
  /** Invitations putting the mounts up right now: no teardown until each saved its token or gave up. */
  private holding = 0;
  private closing: Promise<void> | null = null;

  constructor(private readonly core: Core, private readonly paths: readonly string[], private readonly cli: Cli = defaultCli) {}

  /** The targets the mounts may proxy to, from the journal. */
  private recorded(): string[] {
    const saved = this.core.journal.getSetting(FUNNEL) as { targets?: unknown } | null | undefined;
    return Array.isArray(saved?.targets) ? saved.targets.filter((target): target is string => typeof target === 'string') : [];
  }

  /** Keeps the mounts up until the returned call: an invitation holds them until its token is saved. */
  hold(): () => void {
    this.holding += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holding -= 1;
    };
  }

  /** The routes' origin from `open`, the target recorded before the mounts go up. Call under `hold`. */
  async mount(open: () => Promise<string>): Promise<string> {
    // A teardown in flight ends before the mounts go up again.
    await this.closing;
    this.core.journal.setSetting(FUNNEL, { targets: [...new Set([this.target(), ...this.recorded()])] });
    const url = await open();
    this.core.journal.setSetting(FUNNEL, { targets: [this.target()] });
    return url;
  }

  /**
   * Nothing needs the mounts: they come down, unless an invitation holds
   * them. The record stays until the removal is confirmed, so a failure is
   * tried again at the next release or start.
   */
  release(): void {
    if (this.closing !== null || this.holding > 0 || this.recorded().length === 0) return;
    this.closing = this.close().then(() => {
      if (this.holding === 0) this.core.journal.setSetting(FUNNEL, null);
    }, error => {
      this.core.log('warn', `contacts: the Tailscale Funnel mounts could not be removed: ${messageOf(error)}`, { source: 'contacts' });
    }).finally(() => { this.closing = null; });
  }

  /**
   * At start: mounts nothing needs come down, and mounts a contact still
   * dials follow this core to the port it listens on now.
   */
  start(wanted: boolean): void {
    if (!wanted) { this.release(); return; }
    const recorded = this.recorded();
    if (recorded.length === 0 || (recorded.length === 1 && recorded[0] === this.target())) return;
    const unhold = this.hold();
    // `mount` reads `closing` before this assignment: it waits for nothing older.
    this.closing = this.mount(() => this.open()).then(() => undefined, error => {
      this.core.log('warn', `contacts: the Tailscale Funnel mounts could not follow this core to ${this.target()}: ${messageOf(error)}`, { source: 'contacts' });
    }).finally(() => { unhold(); this.closing = null; });
  }

  /** Resolves once a teardown in flight ended. */
  settled(): Promise<void> { return this.closing ?? Promise.resolve(); }

  /** This core on loopback, where tailscaled sends what Funnel receives. */
  private target(): string {
    return `http://127.0.0.1:${new URL(this.core.baseUrl()).port}`;
  }

  private async read(cli: string[]): Promise<{ dnsName: string; config: ServeConfig }> {
    const status = await runCli(this.core, cli, ['status', '--json'], STATUS_TIMEOUT_MS);
    let parsed: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
    try { parsed = JSON.parse(status.stdout) as typeof parsed; } catch {
      throw unavailable('contacts.invite: Tailscale is not running on this machine; start it, then invite again');
    }
    if (parsed.BackendState !== 'Running') throw unavailable('contacts.invite: Tailscale is not connected on this machine; sign in, then invite again');
    const dnsName = normalizeDnsName(parsed.Self?.DNSName);
    if (dnsName === null || !dnsName.endsWith('.ts.net')) {
      throw unavailable('contacts.invite: Tailscale Funnel needs a tailscale.com tailnet, and this machine is on another one (Headscale has no Funnel); ask the other owner to invite you, or invite them onto your tailnet');
    }
    if (!(parsed.CertDomains ?? []).some(domain => normalizeDnsName(domain) === dnsName)) {
      throw unavailable(`contacts.invite: Tailscale Funnel needs HTTPS certificates; turn on MagicDNS and HTTPS at ${TAILSCALE_DNS_ADMIN}, then invite again`, { actionUrl: TAILSCALE_DNS_ADMIN });
    }
    const serve = await runCli(this.core, cli, ['serve', 'status', '--json'], STATUS_TIMEOUT_MS);
    let config: ServeConfig = {};
    if (serve.stdout.trim() !== '') {
      try { config = JSON.parse(serve.stdout) as ServeConfig; } catch { throw this.failure(serve); }
    } else if (serve.code !== 0) throw this.failure(serve);
    return { dnsName, config };
  }

  /** What the owner must do after a refused command, never the command's own words. */
  private failure(run: Run): Error {
    const output = `${run.stdout}\n${run.stderr}`;
    const consent = tailscaleUrl(output);
    if (consent !== undefined) {
      return unavailable(`contacts.invite: Tailscale Funnel is not allowed for this machine yet; allow it at ${consent}, then invite again`, { actionUrl: consent });
    }
    const text = output.toLowerCase();
    if (/https must be enabled|https is not enabled/.test(text)) return unavailable(`contacts.invite: Tailscale Funnel needs HTTPS certificates; turn them on at ${TAILSCALE_DNS_ADMIN}, then invite again`, { actionUrl: TAILSCALE_DNS_ADMIN });
    if (/funnel.*node attribute|no-funnel/.test(text)) return unavailable('contacts.invite: the tailnet policy does not give this machine the "funnel" node attribute; add it in the Tailscale admin console, then invite again');
    if (/access denied|permission denied|operator|sudo|requires root|not allowed/.test(text)) return unavailable('contacts.invite: Tailscale refused to change what this machine serves; run "tailscale set --operator=$USER" as an administrator, then invite again');
    return unavailable(`contacts.invite: Tailscale Funnel could not be turned on${run.timedOut ? ' (no answer)' : ''}`);
  }

  /** The routes' public origin, `https://<name>:<port>`, mounting them first. Refused with what the owner must do. */
  async open(): Promise<string> {
    const cli = this.cli();
    if (cli === null) throw unavailable('contacts.invite: the tailscale command was not found on this machine; install Tailscale to invite someone from another network');
    const target = this.target();
    const { dnsName, config } = await this.read(cli);
    const mounts = funnelPort(config, dnsName, this.paths, [target, ...this.recorded().filter(old => old !== target)]);
    if (mounts === null) throw unavailable(`contacts.invite: Tailscale already serves something else on ports ${FUNNEL_PORTS.join(' and ')} of this machine, the ones Funnel offers besides 443`);
    for (const path of mounts.missing) {
      const run = await runCli(this.core, cli, ['funnel', '--bg', `--https=${mounts.port}`, `--set-path=${path}`, `${target}${path}`], FUNNEL_TIMEOUT_MS);
      if (run.code !== 0 || run.timedOut) throw this.failure(run);
    }
    return `https://${dnsName}:${mounts.port}`;
  }

  /** Takes down the mounts this module made, to this core or an older target; anything else Tailscale serves stays. Throws when a removal is not confirmed. */
  async close(): Promise<void> {
    const cli = this.cli();
    if (cli === null) throw new Error('the tailscale command was not found');
    const targets = [this.target(), ...this.recorded()];
    const serve = await runCli(this.core, cli, ['serve', 'status', '--json'], STATUS_TIMEOUT_MS);
    if (serve.code !== 0 || serve.timedOut) throw new Error(`tailscale serve status failed${serve.timedOut ? ' (no answer)' : ''}`);
    let config: ServeConfig;
    try { config = JSON.parse(serve.stdout || '{}') as ServeConfig; } catch { throw new Error('tailscale serve status answered something other than JSON'); }
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
      if (!(FUNNEL_PORTS as readonly number[]).includes(port)) continue;
      for (const [path, handler] of Object.entries(web.Handlers ?? {})) {
        if (!this.paths.includes(path) || !targets.some(target => handler.Proxy === `${target}${path}`)) continue;
        const off = await runCli(this.core, cli, ['serve', `--https=${port}`, `--set-path=${path}`, 'off'], STATUS_TIMEOUT_MS);
        if (off.code !== 0 || off.timedOut) throw new Error(`tailscale serve could not remove ${path} on ${port}`);
      }
    }
  }
}
