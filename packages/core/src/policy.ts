/**
 * The admin policy (`docs/enterprise.md`): one machine-wide JSON file, written
 * by an administrator, that locks behaviours of Boite. Every key is optional;
 * an absent key leaves the user's choice, and a machine with no file sees no
 * change at all.
 *
 * The file is looked for at the platform's machine location. Only when none
 * exists there does `BOITE_POLICY_FILE` name one, for servers and tests; a
 * core built with `CoreOptions.policyFile` reads that path alone.
 *
 * A bad file never stops the core. A file that does not parse puts every key
 * at its strictest value (fail closed). In a file that parses, a key with a bad
 * value takes that key's strictest value, an unknown key is ignored, and every
 * valid key applies. Each problem names the file, the field and the value
 * expected, in the log and in `PolicyState.problems`.
 *
 * Enforcement lives in the core: the router refuses what a key forbids
 * (`policy-gate.ts`), and the flows that run by themselves ask here before
 * they reach the network.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY_KEYS, type AdminPolicy, type PolicyKey, type PolicyProblem, type PolicyRefusalData, type PolicyState, type Settings, type UpdatePolicy } from '@boite/contracts';
import { refused, unavailable, type RpcFailure } from './errors.ts';

/** How often the file is looked at for a change: a stat, nothing read unless it moved. */
export const POLICY_POLL_MS = 3000;
/** A policy is a few hundred bytes; anything past this is not one. */
const MAX_POLICY_BYTES = 256 * 1024;
const UPDATE_VALUES: readonly UpdatePolicy[] = ['off', 'check', 'auto'];

/** Where an administrator puts the file on this platform. */
export function machinePolicyFile(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  if (platform === 'win32') return join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'Boite', 'policy.json');
  if (platform === 'darwin') return '/Library/Application Support/Boite/policy.json';
  return '/etc/boite/policy.json';
}

/** The file this core reads: the one it was given, else the machine's, else `BOITE_POLICY_FILE` when the machine has none. */
export function policyFileFor(given: string | undefined, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (given !== undefined) return given;
  const machine = machinePolicyFile(platform, env);
  // `ProgramData` is the user's environment too: the default location, when it holds a file, wins over it.
  const candidates = platform === 'win32' ? [...new Set([machinePolicyFile(platform, {}), machine])] : [machine];
  for (const file of candidates) if (present(file)) return file;
  const named = env.BOITE_POLICY_FILE;
  return named !== undefined && named.length > 0 ? named : machine;
}

/** Whether a file is there. A path that cannot be checked counts as there, so reading it fails closed. */
function present(file: string): boolean {
  try { statSync(file); return true; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code !== 'ENOENT' && code !== 'ENOTDIR'; }
}

/** Every key at its strictest: what a file that does not parse means. */
export const STRICTEST_POLICY: AdminPolicy = Object.freeze({
  analytics: 'off',
  updates: { app: 'off', server: 'off', agents: 'off' },
  providers: { allow: [] },
  gateway: false,
  quotaReads: false,
  plugins: { install: false, recommended: false },
  issueReports: false,
  dictation: 'off',
  previews: { remoteResources: false },
  agentBrowser: false,
  network: { lan: false, tailscaleServe: false, groups: false, contacts: false, push: false },
  pullRequests: false,
}) as AdminPolicy;

interface Parsed { values: AdminPolicy; problems: PolicyProblem[]; failedClosed: boolean }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The policy a file's text says, checked key by key. `null` text is no file.
 * Pure, so the in-memory client and the tests read a policy the same way.
 */
export function parsePolicy(text: string | null, file: string): Parsed {
  if (text === null) return { values: {}, problems: [], failedClosed: false };
  const problems: PolicyProblem[] = [];
  const problem = (field: string, expected: string, got: string): void => {
    problems.push({ file, field, expected, message: `${file}: ${field} is ${got}; expected ${expected}` });
  };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) {
    problems.push({ file, field: '(file)', expected: 'a JSON object', message: `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}); every policy key takes its strictest value until it is fixed` });
    return { values: structuredClone(STRICTEST_POLICY), problems, failedClosed: true };
  }
  if (!isObject(raw)) {
    problems.push({ file, field: '(file)', expected: 'a JSON object', message: `${file}: the file holds ${shape(raw)}, not a JSON object; every policy key takes its strictest value until it is fixed` });
    return { values: structuredClone(STRICTEST_POLICY), problems, failedClosed: true };
  }
  const values: AdminPolicy = {};
  const strict = STRICTEST_POLICY;
  const oneOf = <T extends string>(field: string, value: unknown, allowed: readonly T[], strictest: T): T => {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    problem(field, allowed.map(item => `"${item}"`).join(' or '), shape(value));
    return strictest;
  };
  const flag = (field: string, value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    problem(field, 'true or false', shape(value));
    return false;
  };
  const section = (field: string, value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (!isObject(value)) { problem(field, `an object with ${keys.join(', ')}`, shape(value)); return null; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) problem(`${field}.${key}`, `one of ${keys.map(item => `${field}.${item}`).join(', ')}`, 'an unknown key');
    return value;
  };
  const ids = (field: string, value: unknown): string[] => {
    if (Array.isArray(value) && value.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item))) return [...new Set((value as string[]).map(id => id.toLowerCase()))];
    problem(field, 'an array of provider ids', shape(value));
    return [];
  };
  const urls = (field: string, value: unknown): string[] | null => {
    if (!Array.isArray(value)) { problem(field, 'an array of http(s) URLs', shape(value)); return null; }
    const kept: string[] = [];
    for (const [index, item] of value.entries()) {
      const url = typeof item === 'string' ? safeUrl(item) : null;
      if (url === null) { problem(`${field}[${index}]`, 'an http(s) URL', shape(item)); return null; }
      kept.push(url);
    }
    return kept;
  };

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'analytics': values.analytics = oneOf('analytics', value, ['off', 'basic'] as const, 'off'); break;
      case 'updates': {
        const updates = section('updates', value, ['app', 'server', 'agents']);
        if (updates === null) { values.updates = { ...strict.updates }; break; }
        values.updates = {};
        for (const kind of ['app', 'server', 'agents'] as const) {
          if (updates[kind] !== undefined) values.updates[kind] = oneOf(`updates.${kind}`, updates[kind], UPDATE_VALUES, 'off');
        }
        break;
      }
      case 'providers': {
        const providers = section('providers', value, ['allow', 'deny']);
        if (providers === null) { values.providers = { allow: [] }; break; }
        values.providers = {};
        if (providers.allow !== undefined) values.providers.allow = ids('providers.allow', providers.allow);
        if (providers.deny !== undefined) {
          const before = problems.length;
          const denied = ids('providers.deny', providers.deny);
          // A deny list that cannot be read, one bad id included, denies everything it might have named.
          if (problems.length > before) values.providers.allow = [];
          else values.providers.deny = denied;
        }
        break;
      }
      case 'gateway': {
        if (typeof value === 'boolean') { values.gateway = value; break; }
        const gateway = section('gateway', value, ['allowedBaseUrls']);
        const allowed = gateway === null ? null : urls('gateway.allowedBaseUrls', gateway.allowedBaseUrls);
        values.gateway = allowed === null ? false : { allowedBaseUrls: allowed };
        break;
      }
      case 'quotaReads': values.quotaReads = flag('quotaReads', value); break;
      case 'plugins': {
        const plugins = section('plugins', value, ['install', 'recommended']);
        if (plugins === null) { values.plugins = { ...strict.plugins }; break; }
        values.plugins = {};
        if (plugins.install !== undefined) values.plugins.install = flag('plugins.install', plugins.install);
        if (plugins.recommended !== undefined) values.plugins.recommended = flag('plugins.recommended', plugins.recommended);
        break;
      }
      case 'issueReports': values.issueReports = flag('issueReports', value); break;
      case 'dictation': values.dictation = oneOf('dictation', value, ['local', 'off'] as const, 'off'); break;
      case 'previews': {
        const previews = section('previews', value, ['remoteResources']);
        values.previews = previews === null ? { ...strict.previews } : previews.remoteResources === undefined ? {} : { remoteResources: flag('previews.remoteResources', previews.remoteResources) };
        break;
      }
      case 'agentBrowser': {
        if (typeof value === 'boolean') { values.agentBrowser = value; break; }
        const browser = section('agentBrowser', value, ['searchUrl']);
        const search = browser === null ? null : searchTemplate(browser.searchUrl);
        if (browser !== null && search === null) problem('agentBrowser.searchUrl', 'an https URL with {query} where the search text goes', shape(browser.searchUrl));
        values.agentBrowser = search === null ? false : { searchUrl: search };
        break;
      }
      case 'network': {
        const network = section('network', value, ['lan', 'tailscaleServe', 'groups', 'contacts', 'push']);
        if (network === null) { values.network = { ...strict.network }; break; }
        values.network = {};
        for (const item of ['lan', 'tailscaleServe', 'groups', 'contacts', 'push'] as const) {
          if (network[item] !== undefined) values.network[item] = flag(`network.${item}`, network[item]);
        }
        break;
      }
      case 'pullRequests': values.pullRequests = flag('pullRequests', value); break;
      default: problem(key, 'one of analytics, updates, providers, gateway, quotaReads, plugins, issueReports, dictation, previews, agentBrowser, network, pullRequests', 'an unknown key');
    }
  }
  return { values, problems, failedClosed: false };
}

/** The keys a policy's values lock, in `POLICY_KEYS` order. A `true` that restricts nothing locks nothing. */
export function lockedKeys(values: AdminPolicy): PolicyKey[] {
  return POLICY_KEYS.filter(key => {
    const value = key.split('.').reduce<unknown>((node, part) => isObject(node) ? node[part] : undefined, values);
    return value === false || typeof value === 'string' || Array.isArray(value);
  });
}

/** The policy at `file` now. A missing file is no policy; an unreadable one fails closed. */
export function readPolicy(file: string): PolicyState {
  let text: string | null = null;
  let unreadable: string | null = null;
  try {
    const size = statSync(file).size;
    if (size > MAX_POLICY_BYTES) unreadable = `the file is ${size} bytes, more than ${MAX_POLICY_BYTES}`;
    else text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable = `the file cannot be read (${code ?? String(error)})`;
  }
  const parsed: Parsed = unreadable === null
    ? parsePolicy(text, file)
    : { values: structuredClone(STRICTEST_POLICY), failedClosed: true, problems: [{ file, field: '(file)', expected: 'a readable JSON file', message: `${file}: ${unreadable}; every policy key takes its strictest value until it is fixed` }] };
  return { file, present: text !== null || unreadable !== null, values: parsed.values, locked: lockedKeys(parsed.values), problems: parsed.problems, failedClosed: parsed.failedClosed, readAt: Date.now() };
}

/** What each key forbids, in the words a refusal starts with. */
const FORBIDS: Record<PolicyKey, string> = {
  analytics: 'Usage analytics',
  'updates.app': 'Desktop app updates',
  'updates.server': 'Server updates',
  'updates.agents': 'Agent updates',
  'providers.allow': 'This provider',
  'providers.deny': 'This provider',
  gateway: 'The subscription gateway',
  'gateway.allowedBaseUrls': 'This gateway address',
  quotaReads: 'Quota reads',
  'plugins.install': 'Plugin installs',
  'plugins.recommended': 'Recommended plugin checks',
  issueReports: 'Issue reports',
  dictation: 'Dictation',
  'previews.remoteResources': 'Remote resources in previews',
  agentBrowser: 'The agent browser',
  'agentBrowser.searchUrl': 'This search address',
  'network.lan': 'Listening on the local network',
  'network.tailscaleServe': 'Tailscale HTTPS serving',
  'network.groups': 'Groups',
  'network.contacts': 'Contacts',
  'network.push': 'Push notifications',
  pullRequests: 'Pull request reads',
};

/** A provider that is off refuses to start: by the user's switch, or by the admin policy, which no switch overrides. */
export function providerOffFailure(name: string, block: PolicyRefusalData | null | undefined, data: Record<string, unknown>): RpcFailure {
  if (block) return unavailable(`${name} is blocked by your organization's policy, key ${block.policy} in ${block.file}`, { ...data, disabled: true, ...block });
  return unavailable(`${name} is turned off on this machine. Turn it on in Settings > Providers to use it`, { ...data, disabled: true });
}

export interface PolicyHost {
  log(level: 'info' | 'warn', message: string, data: Record<string, string | number | boolean | null>): void;
  changed(state: PolicyState): void;
}

export class PolicyStore {
  readonly file: string;
  #state: PolicyState;
  #stamp: string;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #listeners = new Set<(state: PolicyState, before: PolicyState) => void>();

  constructor(file: string, private readonly host: PolicyHost) {
    this.file = file;
    this.#stamp = stampOf(file);
    this.#state = readPolicy(file);
    this.report(this.#state);
  }

  state(): PolicyState { return structuredClone(this.#state); }
  get values(): AdminPolicy { return this.#state.values; }
  /** Some key is in force. */
  get active(): boolean { return this.#state.locked.length > 0; }

  /** Reads the file again when it moved since the last look. True when what it says changed. */
  reload(): boolean {
    const stamp = stampOf(this.file);
    if (stamp === this.#stamp) return false;
    this.#stamp = stamp;
    const before = this.#state;
    const next = readPolicy(this.file);
    if (sameState(before, next)) return false;
    this.#state = next;
    this.report(next);
    for (const listener of this.#listeners) {
      try { listener(next, before); } catch (error) { this.host.log('warn', `policy listener failed: ${error instanceof Error ? error.message : String(error)}`, {}); }
    }
    this.host.changed(this.state());
    return true;
  }

  /** Something that follows a key, told after every change of the file. */
  onChange(listener: (state: PolicyState, before: PolicyState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Looks at the file every few seconds; an administrator's edit applies without a restart. */
  start(pollMs = POLICY_POLL_MS): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => { this.reload(); }, pollMs);
    this.#timer.unref?.();
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  /** The refusal for something a key forbids: the key, the file, and a sentence a person reads. */
  refusal(key: PolicyKey, detail?: string): RpcFailure {
    const data: PolicyRefusalData = { policy: key, file: this.#state.file };
    return refused(`${FORBIDS[key]}${detail ? ` (${detail})` : ''}: blocked by your organization's policy, key ${key} in ${this.#state.file}`, data);
  }

  /** Throws the refusal when `blocked`. */
  assert(blocked: boolean, key: PolicyKey, detail?: string): void {
    if (blocked) throw this.refusal(key, detail);
  }

  /** A fetch that throws the refusal instead of sending while `blocked()`: for a client that holds a key, a contact's tailnet key say. */
  fetchUnless(blocked: () => boolean, key: PolicyKey, detail?: string): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return (input, init) => {
      this.assert(blocked(), key, detail);
      return fetch(input, init);
    };
  }

  // What each key says, asked by the code that runs the flow.

  /** The most analytics may send: null when the policy leaves it to the user. */
  analyticsCeiling(): 'off' | 'basic' | null { return this.values.analytics ?? null; }

  update(kind: 'app' | 'server' | 'agents'): UpdatePolicy | null { return this.values.updates?.[kind] ?? null; }

  /** The key that keeps a provider from running, or null. */
  providerBlock(id: string): 'providers.allow' | 'providers.deny' | null {
    const providers = this.values.providers;
    if (providers?.allow !== undefined && !providers.allow.includes(id)) return 'providers.allow';
    if (providers?.deny?.includes(id)) return 'providers.deny';
    return null;
  }

  /** The key that forbids a gateway at `baseUrl` (or any gateway, without one), or null. */
  gatewayBlock(baseUrl?: string | null): 'gateway' | 'gateway.allowedBaseUrls' | null {
    return gatewayBlockOf(this.values, baseUrl);
  }

  quotaReadsOff(): boolean { return this.values.quotaReads === false; }
  pluginInstallsOff(): boolean { return this.values.plugins?.install === false; }
  recommendedPluginsOff(): boolean { return this.values.plugins?.recommended === false; }
  issueReportsOff(): boolean { return this.values.issueReports === false; }
  dictation(): 'local' | 'off' | null { return this.values.dictation ?? null; }
  remotePreviewResourcesOff(): boolean { return this.values.previews?.remoteResources === false; }
  agentBrowserOff(): boolean { return this.values.agentBrowser === false; }
  searchUrl(): string | null { return typeof this.values.agentBrowser === 'object' ? this.values.agentBrowser.searchUrl : null; }
  networkOff(item: 'lan' | 'tailscaleServe' | 'groups' | 'contacts' | 'push'): boolean { return this.values.network?.[item] === false; }
  pullRequestsOff(): boolean { return this.values.pullRequests === false; }

  /** The settings the policy decides, whatever the user saved: the store reads these over its own. `values` reads an earlier policy. */
  lockedSettings(settings: Settings, values: AdminPolicy = this.values): Partial<Settings> {
    const locked: Partial<Settings> = {};
    if (values.network?.lan === false) locked.listenOnLan = false;
    const app = values.updates?.app;
    if (app !== undefined) locked.autoInstallUpdates = app === 'auto';
    const agents = values.updates?.agents;
    if (agents !== undefined) locked.autoUpdateHarnesses = agents === 'auto';
    if (values.network?.groups === false) { locked.groupThreads = false; locked.groupBots = false; }
    const proxy = settings.subscriptionProxy;
    if (proxy?.enabled && gatewayBlockOf(values, proxy.baseUrl) !== null) locked.subscriptionProxy = { ...proxy, enabled: false };
    return locked;
  }

  /** The key a settings patch would break, checked before it is stored. */
  settingsRefusal(patch: Partial<Settings>, current: Settings): RpcFailure | null {
    const locked = this.lockedSettings({ ...current, ...patch });
    const keyOf: Partial<Record<keyof Settings, PolicyKey>> = {
      listenOnLan: 'network.lan', autoInstallUpdates: 'updates.app', autoUpdateHarnesses: 'updates.agents', groupThreads: 'network.groups', groupBots: 'network.groups',
    };
    for (const [setting, key] of Object.entries(keyOf) as [keyof Settings, PolicyKey][]) {
      if (!(setting in patch) || !(setting in locked)) continue;
      if ((patch[setting] === true) !== (locked[setting] === true)) return this.refusal(key, `${setting} stays ${String(locked[setting])}`);
    }
    const proxy = patch.subscriptionProxy;
    if (proxy?.enabled) {
      const key = this.gatewayBlock(proxy.baseUrl);
      if (key !== null) return this.refusal(key, key === 'gateway' ? undefined : proxy.baseUrl);
    }
    return null;
  }

  private report(state: PolicyState): void {
    if (!state.present) return;
    this.host.log(state.problems.length > 0 ? 'warn' : 'info', `Admin policy read from ${state.file}: ${state.locked.length} keys in force${state.failedClosed ? ', failed closed' : ''}`, {
      locked: state.locked.join(',').slice(0, 300), problems: state.problems.length, failedClosed: state.failedClosed,
    });
    for (const problem of state.problems.slice(0, 20)) {
      this.host.log('warn', `Admin policy problem: ${problem.message}`, { field: problem.field.slice(0, 80), expected: problem.expected.slice(0, 200) });
    }
  }
}

function gatewayBlockOf(values: AdminPolicy, baseUrl?: string | null): 'gateway' | 'gateway.allowedBaseUrls' | null {
  const gateway = values.gateway;
  if (gateway === false) return 'gateway';
  if (typeof gateway === 'object' && typeof baseUrl === 'string') {
    const url = safeUrl(baseUrl);
    if (url === null || !gateway.allowedBaseUrls.some(allowed => url === allowed || url.startsWith(`${allowed}/`))) return 'gateway.allowedBaseUrls';
  }
  return null;
}

function stampOf(file: string): string {
  try {
    const stats = statSync(file);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    return `missing:${(error as NodeJS.ErrnoException).code ?? ''}`;
  }
}

function sameState(a: PolicyState, b: PolicyState): boolean {
  return a.present === b.present && a.failedClosed === b.failedClosed && JSON.stringify(a.values) === JSON.stringify(b.values) && JSON.stringify(a.problems) === JSON.stringify(b.problems);
}

/** An http(s) URL without credentials, as a prefix compares: no query, no fragment, no trailing slash. */
function safeUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** An https search address with `{query}` where the typed text goes. */
function searchTemplate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('{query}') || value.length > 2000) return null;
  let url: URL;
  try { url = new URL(value.replace('{query}', 'q')); } catch { return null; }
  return url.protocol === 'https:' && !url.username && !url.password ? value : null;
}

function shape(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value);
  if (typeof value === 'object') return 'an object';
  return String(value);
}
