/**
 * The owner's Tailscale API, for contacts only: find this machine, share it
 * with one invitee, accept a share, and read (never write) the tailnet policy
 * to tell whether a shared user reaches more than Boite's port.
 *
 * The API key sits in one data-dir file, mode 600. It is sent to
 * api.tailscale.com and nowhere else, and no RPC answer, log line or error
 * message carries it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContactInvite, ContactTailscale } from '@boite/contracts';
import { invalidParams, messageOf } from '../errors.ts';
import { magicName } from '../group/addresses.ts';

const API = 'https://api.tailscale.com/api/v2';
const KEY_FILE = 'contacts-tailscale-key';
const TIMEOUT_MS = 10_000;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Device {
  id: string;
  /** The MagicDNS name, `<machine>.<tailnet>.ts.net`. */
  name: string;
  addresses: string[];
  tags: string[];
}

export type Policy = Pick<ContactTailscale, 'policy' | 'policyFix'>;

export class TailscaleFailure extends Error {}

export function checkApiKey(value: unknown): string {
  if (typeof value !== 'string' || !/^tskey-[A-Za-z0-9_-]{10,200}$/.test(value.trim())) {
    throw invalidParams('key: expected a Tailscale API key starting with tskey-, or null to clear it', { field: 'key' });
  }
  return value.trim();
}

export class TailscaleClient {
  constructor(private readonly dataDir: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}

  private file(): string { return join(this.dataDir, KEY_FILE); }

  hasKey(): boolean { return existsSync(this.file()); }

  setKey(key: string | null): void {
    if (key === null) { rmSync(this.file(), { force: true }); return; }
    const checked = checkApiKey(key);
    rmSync(this.file(), { force: true });
    writeFileSync(this.file(), checked, { mode: 0o600, flag: 'wx' });
  }

  private key(): string | null {
    try { return readFileSync(this.file(), 'utf8').trim() || null; } catch { return null; }
  }

  /** One call to the API. The failure names the path and status, never the key. */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const key = this.key();
    if (key === null) throw new TailscaleFailure('no Tailscale API key stored');
    let response: Response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TailscaleFailure(`Tailscale API ${method} ${path} did not answer`);
    }
    if (!response.ok) throw new TailscaleFailure(`Tailscale API ${method} ${path} answered ${response.status}`);
    const text = await response.text();
    try { return text ? JSON.parse(text) as unknown : null; } catch { throw new TailscaleFailure(`Tailscale API ${method} ${path} answered something other than JSON`); }
  }

  /** This machine in the tailnet, found by its tailnet address. */
  async device(ip: string): Promise<Device> {
    const answer = await this.call('GET', '/tailnet/-/devices') as { devices?: unknown } | null;
    const devices = Array.isArray(answer?.devices) ? answer.devices as Record<string, unknown>[] : [];
    for (const raw of devices) {
      const addresses = Array.isArray(raw['addresses']) ? raw['addresses'].filter((a): a is string => typeof a === 'string') : [];
      if (!addresses.includes(ip)) continue;
      const id = typeof raw['nodeId'] === 'string' ? raw['nodeId'] : typeof raw['id'] === 'string' ? raw['id'] : null;
      const name = typeof raw['name'] === 'string' ? raw['name'].replace(/\.$/, '').toLowerCase() : null;
      if (id === null || name === null || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) break;
      return { id, name, addresses, tags: Array.isArray(raw['tags']) ? raw['tags'].filter((t): t is string => typeof t === 'string') : [] };
    }
    throw new TailscaleFailure(`this machine (${ip}) is not among the tailnet's devices`);
  }

  /** A single-use share of this machine; its URL is what the invitee accepts. */
  async createShare(deviceId: string): Promise<string> {
    const answer = await this.call('POST', `/device/${encodeURIComponent(deviceId)}/device-invites`, [{ multiUse: false, allowExitNode: false }]);
    const first = (Array.isArray(answer) ? answer[0] : null) as { inviteUrl?: unknown } | null;
    if (typeof first?.inviteUrl !== 'string' || !first.inviteUrl.startsWith('https://login.tailscale.com/')) throw new TailscaleFailure('Tailscale API gave no share link');
    return first.inviteUrl;
  }

  /** The share of the machine at `ip` an invitation carries, made with the stored key, or why the owner shares it by hand. */
  async shareFor(ip: string | null): Promise<ContactInvite['share']> {
    if (!this.hasKey()) return { status: 'manual', reason: 'No Tailscale API key is stored: share this machine with the invitee from the Tailscale admin console.' };
    if (ip === null) return { status: 'manual', reason: 'This machine is not on a tailnet.' };
    try {
      return { status: 'created', url: await this.createShare((await this.device(ip)).id) };
    } catch (error) {
      return { status: 'manual', reason: `The share could not be created (${messageOf(error)}): share this machine from the Tailscale admin console.` };
    }
  }

  /**
   * This machine on Tailscale, at tailnet address `ip`: its name and, with the
   * stored key, the policy toward shared users of Boite's `port`. Without the
   * API, the name comes from MagicDNS.
   */
  async state(ip: string | null, port: number, warn: (message: string) => void): Promise<ContactTailscale> {
    const apiKey = this.hasKey();
    let value: ContactTailscale = { fqdn: null, apiKey, policy: 'unknown' };
    if (ip === null) return value;
    if (apiKey) {
      try {
        const device = await this.device(ip);
        value = { fqdn: device.name, apiKey, ...evaluatePolicy(await this.policy(), device, port) };
      } catch (error) {
        warn(`contacts: the Tailscale API could not be read: ${messageOf(error)}`);
      }
    }
    return value.fqdn === null ? { ...value, fqdn: await magicName(ip) } : value;
  }

  /** Accepts a share made by another tailnet, so that machine becomes reachable from this one. */
  async acceptShare(url: string): Promise<void> {
    await this.call('POST', '/device-invites/-/accept', [{ invite: url }]);
  }

  /** The tailnet policy as JSON, read only. */
  async policy(): Promise<unknown> {
    return this.call('GET', '/tailnet/-/acl');
  }
}

/** `host:port` of an ACL destination, the host part kept whole for IPv6 and CIDR. */
function splitDestination(value: string): { host: string; ports: string } {
  const cut = value.lastIndexOf(':');
  return cut < 0 ? { host: value, ports: '*' } : { host: value.slice(0, cut), ports: value.slice(cut + 1) };
}

/** Whether a port list (`*`, `80`, `1000-2000`, `22,443`) opens any port other than `port`. */
function opensOtherPorts(ports: string, port: number): boolean {
  return ports.split(',').some(part => {
    const piece = part.trim();
    if (piece === String(port)) return false;
    const range = /^(\d+)-(\d+)$/.exec(piece);
    if (range) return !(Number(range[1]) === port && Number(range[2]) === port);
    return true;
  });
}

/** Whether a grant's `ip` list (`*`, `tcp:443`, `udp:53`, `443`) opens anything other than TCP `port`. */
function grantOpensOther(ip: unknown, port: number): boolean {
  if (!Array.isArray(ip)) return true;
  return ip.some(entry => {
    if (typeof entry !== 'string') return true;
    const match = /^(?:(tcp|udp|\w+):)?(.+)$/.exec(entry.trim());
    if (!match) return true;
    if (match[1] !== undefined && match[1] !== 'tcp') return true;
    return opensOtherPorts(match[2]!, port);
  });
}

/** An IPv4 address as a number, or null for anything else. */
function ipv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/** Whether a CIDR range takes in `ip`. A range this check cannot read (IPv6, a typo) may hold it. */
function rangeHolds(range: string, ip: string): boolean {
  const [base = '', bits = ''] = range.split('/');
  const start = ipv4(base), address = ipv4(ip), size = Number(bits);
  if (start === null || address === null || !/^\d{1,2}$/.test(bits) || size > 32) return true;
  const block = 2 ** (32 - size);
  return Math.floor(start / block) === Math.floor(address / block);
}

/**
 * Whether the policy lets a shared user reach this machine on more than
 * `port`. A rule applies when its source takes in shared users (`*` or
 * `autogroup:shared`) and its destination may be this machine: `*`, its
 * address, its name, one of its tags or a host alias for its address. A tag,
 * group or alias the policy does not resolve reads as this machine: the
 * answer errs toward `open`.
 */
export function evaluatePolicy(raw: unknown, device: Pick<Device, 'name' | 'addresses' | 'tags'>, port: number): Policy {
  const policy = raw as { acls?: unknown; grants?: unknown; hosts?: Record<string, unknown> } | null;
  if (!policy || typeof policy !== 'object') return { policy: 'unknown' };
  const ip = device.addresses.find(address => /^100\./.test(address)) ?? device.addresses[0] ?? '';
  const fix = policyFix(ip, port, !Array.isArray(policy.acls) && !Array.isArray(policy.grants));
  // No rule list at all is Tailscale's default policy: everyone reaches everything.
  if (!Array.isArray(policy.acls) && !Array.isArray(policy.grants)) return { policy: 'open', policyFix: fix };
  const short = device.name.split('.')[0] ?? device.name;
  const hosts = policy.hosts && typeof policy.hosts === 'object' ? policy.hosts : {};
  const sharedSource = (src: unknown): boolean => Array.isArray(src) && src.some(entry => entry === '*' || entry === 'autogroup:shared');
  const mine = (host: string): boolean => {
    if (host === '*' || host === ip || host === `${ip}/32` || host === device.name || host === short) return true;
    if (host.startsWith('tag:')) return device.tags.includes(host);
    if (host.startsWith('autogroup:')) return host === 'autogroup:tagged' ? device.tags.length > 0 : false;
    const alias = hosts[host];
    if (typeof alias === 'string') return alias === ip || (alias.includes('/') && rangeHolds(alias, ip));
    // A user, a group or a CIDR this check does not resolve: assume it may be this machine.
    return true;
  };
  let open = false;
  for (const rule of Array.isArray(policy.acls) ? policy.acls as Record<string, unknown>[] : []) {
    if (!rule || rule['action'] !== 'accept' || !sharedSource(rule['src']) || !Array.isArray(rule['dst'])) continue;
    for (const dst of rule['dst']) {
      if (typeof dst !== 'string') { open = true; continue; }
      const { host, ports } = splitDestination(dst);
      if (mine(host) && opensOtherPorts(ports, port)) open = true;
    }
  }
  for (const rule of Array.isArray(policy.grants) ? policy.grants as Record<string, unknown>[] : []) {
    if (!rule || !sharedSource(rule['src']) || !Array.isArray(rule['dst'])) continue;
    if (rule['dst'].some(dst => typeof dst !== 'string' || mine(dst)) && grantOpensOther(rule['ip'], port)) open = true;
  }
  return open ? { policy: 'open', policyFix: fix } : { policy: 'restricted' };
}

/** What to paste so shared users reach Boite's port on this machine and nothing else. */
function policyFix(ip: string, port: number, defaultPolicy: boolean): string {
  const rule = JSON.stringify({ action: 'accept', src: ['autogroup:shared'], dst: [`${ip}:${port}`] });
  return [
    '// Add to "acls": shared users reach Boite on this machine only.',
    rule,
    defaultPolicy
      ? '// The tailnet runs the default allow-all policy: write "acls" with your own rules first, or this rule alone cuts every other access.'
      : '// Then remove "*" and "autogroup:shared" from the "src" of every other rule that reaches this machine.',
  ].join('\n');
}
