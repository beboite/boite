/*
 * Windows Defender Firewall, read and fixed for this core.
 *
 * A phone on the same network reaches the core only when the firewall lets
 * the core's executable accept connections on that network's profile. The
 * platform gives the two commands (`platform/windows/firewall.ts`); this
 * module runs them, turns what Windows answered into a `FirewallStatus`, and
 * registers the owner's two methods. Elsewhere the status is `unsupported`.
 */

import type { FirewallStatus, NetworkCategory } from '@boite/contracts';
import type { Core } from './core.ts';
import { processPlatform } from './platform/index.ts';
import { FIREWALL_PROMPT_REFUSED } from './platform/types.ts';

const QUERY_TIMEOUT_MS = 15_000;
/** The administrator prompt waits for a person. */
const ALLOW_TIMEOUT_MS = 5 * 60_000;

/** What the query command prints. */
export interface FirewallReading {
  /** Inbound rules naming the core's executable: action 0 blocks, 1 allows; profiles as a bit mask. */
  rules: { action: number; profiles: number }[];
  networks: { adapter: string; category: string }[];
  /** Profiles where the firewall is off. */
  off: number;
}

const BITS: Record<NetworkCategory, number> = { domain: 1, private: 2, public: 4 };
const ORDER: NetworkCategory[] = ['public', 'private', 'domain'];

function category(name: string): NetworkCategory | null {
  const lower = name.toLowerCase();
  if (lower === 'public') return 'public';
  if (lower === 'private') return 'private';
  if (lower.startsWith('domain')) return 'domain';
  return null;
}

/**
 * The status a reading means. A block wins over an allow on the same profile,
 * as it does in Windows. Tailscale's adapter is left out: Tailscale allows
 * inbound connections on it with a rule of its own.
 */
export function judge(reading: FirewallReading): FirewallStatus {
  const networks = ORDER.filter((name) => reading.networks.some((network) => !/^tailscale/i.test(network.adapter) && category(network.category) === name));
  const covers = (action: number, name: NetworkCategory) => reading.rules.some((rule) => rule.action === action && (rule.profiles & BITS[name]) !== 0);
  const off = (name: NetworkCategory) => (reading.off & BITS[name]) !== 0;
  const blocked = networks.filter((name) => !off(name) && covers(0, name));
  const allowed = networks.filter((name) => off(name) || (!blocked.includes(name) && covers(1, name)));
  const state = blocked.length > 0 ? 'blocked' : allowed.length < networks.length ? 'unset' : 'ready';
  return { state, networks, allowed, blocked };
}

/** A reading from the query command's output, or null when it is not one. */
export function parseReading(output: string): FirewallReading | null {
  let raw: unknown;
  try {
    raw = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as { rules?: unknown; networks?: unknown; off?: unknown };
  // ConvertTo-Json writes a one-element array as the element itself.
  const list = (item: unknown): unknown[] => (Array.isArray(item) ? item : item === undefined || item === null ? [] : [item]);
  const rules = list(value.rules).flatMap((rule) => {
    const { action, profiles } = (rule ?? {}) as { action?: unknown; profiles?: unknown };
    return typeof action === 'number' && typeof profiles === 'number' ? [{ action, profiles }] : [];
  });
  const networks = list(value.networks).flatMap((network) => {
    const { adapter, category: name } = (network ?? {}) as { adapter?: unknown; category?: unknown };
    return typeof adapter === 'string' && typeof name === 'string' ? [{ adapter, category: name }] : [];
  });
  return { rules, networks, off: typeof value.off === 'number' ? value.off : 0 };
}

const UNSUPPORTED: FirewallStatus = { state: 'unsupported', networks: [], allowed: [], blocked: [] };

export interface FirewallOptions {
  /** The executable the rules name. Defaults to this process's own. */
  program?: string;
  commands?: { query(program: string): string[]; allow(program: string): string[] } | null;
}

export class FirewallAccess {
  constructor(private readonly core: Core, private readonly options: FirewallOptions = {}) {}

  private commands() {
    return this.options.commands === undefined ? processPlatform.firewall ?? null : this.options.commands;
  }

  private program(): string {
    return this.options.program ?? process.execPath;
  }

  async status(): Promise<FirewallStatus> {
    const commands = this.commands();
    if (commands === null) return UNSUPPORTED;
    const run = await this.run(commands.query(this.program()), QUERY_TIMEOUT_MS);
    if (run.timedOut) return { ...UNSUPPORTED, state: 'error', detail: 'timeout' };
    const reading = run.code === 0 ? parseReading(run.stdout) : null;
    return reading === null ? { ...UNSUPPORTED, state: 'error', detail: 'unknown' } : judge(reading);
  }

  /** Allow the core on every profile, unless it already is; Windows asks an administrator first. */
  async allow(): Promise<FirewallStatus> {
    const before = await this.status();
    if (before.state === 'unsupported' || before.state === 'ready') return before;
    const commands = this.commands()!;
    const run = await this.run(commands.allow(this.program()), ALLOW_TIMEOUT_MS);
    const after = await this.status();
    if (after.state === 'ready') {
      this.core.log('info', 'Windows Defender Firewall now allows Boite on every network');
      return after;
    }
    const detail = run.timedOut ? 'timeout' : run.code === FIREWALL_PROMPT_REFUSED ? 'cancelled' : 'unknown';
    if (detail === 'unknown') this.core.log('warn', `allowing Boite in Windows Defender Firewall failed with exit code ${run.code}`);
    return { ...after, detail };
  }

  private async run(command: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
    const [cmd, ...args] = command;
    let child: ReturnType<Core['procs']['spawn']>;
    try {
      child = this.core.procs.spawn('system:firewall', cmd!, args, { agentRoot: false });
    } catch {
      return { code: null, stdout: '', timedOut: false };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.proc.kill();
    }, timeoutMs);
    try {
      const [stdout, , code] = await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
      return { code, stdout, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Owner only: absent from `DEVICE_METHODS`, so a paired phone is refused them.
 * Allowing changes what the machine accepts from its networks.
 */
export function registerFirewallMethods(core: Core, access = new FirewallAccess(core)): void {
  core.router.register('firewall.status', () => access.status());
  core.router.register('firewall.allow', () => access.allow());
}
