import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { release, version as osName } from 'node:os';
import { join } from 'node:path';
import type { TelemetryState, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams as invalid } from './errors.ts';
import { enhancedDetails, publicOsVersion, subagentDetails, type EnhancedDetails } from '../../contracts/src/telemetry.ts';

const EVENTS = ['ping', 'first_run', 'app_launched', 'session_ended', 'project_added', 'thread_spawned', 'turn_finished', 'subagent_started'] as const;
type EventName = typeof EVENTS[number];
const PROVIDERS = ['claude', 'codex', 'opencode', 'opencode-v2', 'pi', 'grok', 'antigravity', 'muse', 'hermes'];
const MODES = ['off', 'basic', 'enhanced'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERVAL = 300_000;
export const RELAY = 'https://boite-v2-telemetry.nefreex.workers.dev';

/**
 * Only published builds default to the relay. Their CI bundles the core with
 * `--env=BOITE_RELEASE_*` and BOITE_RELEASE_TELEMETRY=1, which inlines the flag.
 * A run from sources or a local build reads it at runtime, where it is unset,
 * so a scratch data directory never counts as a new installation.
 * BOITE_TELEMETRY_URL, read at runtime, still overrides either default.
 */
export function relayFor(release: boolean, override: string | undefined): string {
  return override ?? (release ? RELAY : '');
}
/**
 * Windows names its product in the registry and keeps "Windows 10" there on
 * Windows 11, so the build number decides: 22000 and later is Windows 11.
 */
export function windowsVersion(product: string, kernel: string): string {
  const build = Number(kernel.split('.')[2]);
  const name = /^Windows [\w .-]{1,32}$/.test(product.trim()) ? product.trim() : 'Windows';
  const fixed = build >= 22000 ? name.replace(/^Windows 10\b/, 'Windows 11') : name;
  return Number.isInteger(build) && build > 0 ? `${fixed} ${build}` : fixed;
}

/**
 * `ID` and `VERSION_ID` from os-release: lowercase identifiers by
 * specification, unlike `PRETTY_NAME`, which a distribution writes freely.
 * A rolling distribution has no `VERSION_ID` and reports its ID alone.
 */
export function linuxVersion(osRelease: string): string {
  const field = (key: string) => osRelease.match(new RegExp(`^${key}=["']?([a-z0-9._-]{1,24})["']?\\s*$`, 'm'))?.[1];
  const id = field('ID');
  if (!id) return 'linux';
  const version = field('VERSION_ID');
  return version ? `${id} ${version}` : id;
}

/** `ProductVersion` from SystemVersion.plist, whose layout has not moved in twenty years. */
export function macosVersion(plist: string): string {
  const version = plist.match(/<key>ProductVersion<\/key>\s*<string>(\d+(?:\.\d+){0,2})<\/string>/)?.[1];
  return version ? `macOS ${version}` : 'macOS';
}

let detectedOsVersion: string | undefined;

/** Read once per process: the release cannot change under a running host. */
export function osVersion(): string {
  if (detectedOsVersion) return detectedOsVersion;
  const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  const value = process.platform === 'win32' ? windowsVersion(osName(), release())
    : process.platform === 'darwin' ? macosVersion(read('/System/Library/CoreServices/SystemVersion.plist'))
    : linuxVersion(read('/etc/os-release') || read('/usr/lib/os-release'));
  detectedOsVersion = publicOsVersion(value) ?? 'other';
  return detectedOsVersion;
}

interface ChoiceReceipt {
  mode: TelemetryState['mode'];
  uuid: string;
  pending: boolean;
}

interface Consent {
  mode: TelemetryState['mode'];
  anonymousId: string;
  installId: string | null;
  forget: string[];
  firstRun: boolean;
  pingDay: string;
  choice?: ChoiceReceipt;
}
export interface TelemetryEvent extends EnhancedDetails {
  name: EventName;
  uuid: string;
  app_version: string;
  os: string;
  os_version: string;
  arch: string;
  client_ts: string;
  provider?: string;
  outcome?: string;
  duration_ms?: number;
}

/** Rebuild from known fields. Never spread a thread, turn or error into telemetry. */
export function telemetryEvent(name: EventName, version: string, fields: Record<string, unknown> = {}): TelemetryEvent {
  const event: TelemetryEvent = {
    name, uuid: crypto.randomUUID(), app_version: /^[\w.+-]{1,32}$/.test(version) ? version : 'other',
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    os_version: osVersion(),
    arch: ['x64', 'arm64', 'ia32'].includes(process.arch) ? process.arch : 'other',
    client_ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (name === 'thread_spawned' || name === 'turn_finished' || name === 'subagent_started') {
    event.provider = PROVIDERS.includes(String(fields.provider)) ? String(fields.provider) : 'other';
  }
  if (name === 'turn_finished') {
    event.outcome = ['done', 'error', 'stopped'].includes(String(fields.outcome)) ? String(fields.outcome) : 'other';
  }
  if (['app_launched', 'session_ended', 'turn_finished'].includes(name) && typeof fields.duration_ms === 'number' && Number.isFinite(fields.duration_ms)) {
    event.duration_ms = Math.min(604_800_000, Math.max(0, Math.round(fields.duration_ms)));
  }
  return event;
}

/** One queue per host, RAM only. Consent and deletion receipts are the only disk state. */
export class Telemetry {
  #core: Core;
  #endpoint: string | null;
  #send: typeof fetch;

  #consent: Consent;
  readonly #file: string;
  #queue: TelemetryEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #revision = 0;
  /** The analytics ceiling the queue was gathered under; undefined until the first launch reads it. */
  #lastCeiling: 'off' | 'basic' | null | undefined;
  #uploadRevision = 0;
  #launchPending = false;
  #failures = 0;
  #closed = false;
  #closing = false;
  #unsubscribe: () => void;
  #mutation: Promise<unknown> = Promise.resolve();

  // Literal `process.env` reads, so that Bun can inline the release flag.
  constructor(core: Core, endpoint = relayFor(process.env.BOITE_RELEASE_TELEMETRY === '1', process.env.BOITE_TELEMETRY_URL), send: typeof fetch = fetch) {
    this.#core = core;
    this.#endpoint = endpoint;
    this.#send = send;
    if (endpoint) {
      let url: URL;
      try { url = new URL(endpoint); }
      catch { throw invalid('BOITE_TELEMETRY_URL: expected a valid URL'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
        throw invalid('BOITE_TELEMETRY_URL: expected HTTPS or loopback HTTP');
      }
      if (url.username || url.password || url.search || url.hash) throw invalid('BOITE_TELEMETRY_URL: expected an origin without credentials, query or fragment');
      this.#endpoint = endpoint.replace(/\/$/, '');
    }
    this.#file = join(core.dataDir, 'telemetry.json');
    this.#consent = { mode: 'basic', anonymousId: crypto.randomUUID(), installId: null, forget: [], firstRun: false, pingDay: '' };
    if (existsSync(this.#file)) {
      try {
        const saved = JSON.parse(readFileSync(this.#file, 'utf8')) as Consent;
        if (!MODES.includes(saved.mode) || !UUID.test(saved.anonymousId) ||
            (saved.installId !== null && !UUID.test(saved.installId)) ||
            !Array.isArray(saved.forget) || saved.forget.some(id => !UUID.test(id)) ||
            typeof saved.firstRun !== 'boolean' || typeof saved.pingDay !== 'string' ||
            (saved.mode === 'enhanced' && !saved.installId) ||
            (saved.choice !== undefined && (!saved.choice || !MODES.includes(saved.choice.mode) ||
              !UUID.test(saved.choice.uuid) || typeof saved.choice.pending !== 'boolean'))) throw invalid('telemetry.json: expected valid consent and UUID identifiers');
        this.#consent = saved;
      } catch {
        // Never overwrite an unreadable deletion ledger with fresh consent.
        throw invalid('telemetry.json: cannot load consent; expected readable JSON with valid consent and UUID identifiers. Preserve this file and restore a valid backup or repair it while retaining forget and installId; see docs/analytics.md#repairing-consent-state.');
      }
    }
    this.#unsubscribe = core.bus.onAny((name, payload) => {
      if (name === 'project.added') this.track('project_added');
      if (name === 'thread.created') this.track('thread_spawned', { provider: (payload as { providerId: string }).providerId });
      if (name === 'turn.started' && this.#mode === 'enhanced') {
        const turn = payload as Turn;
        const execution = turn.execution;
        if (execution && execution.operation !== 'compact' && execution.operation !== 'keepalive' && core.journal.getThread(turn.threadId)?.parentThreadId) {
          this.track('subagent_started', { provider: execution.providerId, model: execution.model, effort: execution.effort, speed: execution.speed });
        }
      }
      if (name === 'turn.finished') {
        const turn = payload as Turn;
        this.track('turn_finished', {
          provider: turn.execution?.providerId, outcome: turn.status,
          duration_ms: (turn.finishedAt ?? Date.now()) - (turn.startedAt ?? turn.queuedAt),
          model: turn.execution?.model, effort: turn.execution?.effort, speed: turn.execution?.speed,
          permission_mode: turn.execution?.permissionMode, operation: turn.execution?.operation ?? 'prompt',
          queue_ms: turn.startedAt === null ? undefined : turn.startedAt - turn.queuedAt,
          input_tokens: turn.usage?.inputTokens, output_tokens: turn.usage?.outputTokens,
          cache_read_tokens: turn.usage?.cacheReadTokens, cache_write_tokens: turn.usage?.cacheWriteTokens,
        });
      }
    });
    this.#lastCeiling = this.#ceiling();
    this.launch();
    this.#schedule(20_000);
  }

  /** The user's choice under the admin policy's ceiling (`analytics`): what is actually sent. */
  get #mode(): TelemetryState['mode'] {
    const ceiling = this.#ceiling();
    if (ceiling === 'off') return 'off';
    if (ceiling === 'basic' && this.#consent.mode === 'enhanced') return 'basic';
    return this.#consent.mode;
  }

  /** A host without a policy store (the unit tests' stand-in core) has no ceiling. */
  #ceiling(): 'off' | 'basic' | null { return this.#core.policy?.analyticsCeiling() ?? null; }

  /** The policy changed: when its ceiling moved, what was queued under the old one is dropped and the launch counts again. */
  policyChanged(): void {
    const ceiling = this.#ceiling();
    if (ceiling === this.#lastCeiling) return;
    this.#lastCeiling = ceiling;
    this.#revision++;
    this.#queue = [];
    this.#controller?.abort();
    this.launch();
    this.#schedule(20_000);
  }

  state(): TelemetryState {
    return { mode: this.#mode, configured: !!this.#endpoint, pendingDeletion: this.#consent.forget.length > 0 };
  }

  configure(mode: TelemetryState['mode'], countChoice = false): Promise<TelemetryState> {
    if (!MODES.includes(mode)) return Promise.reject(invalid('mode: expected off, basic or enhanced'));
    if (typeof countChoice !== 'boolean') return Promise.reject(invalid('countChoice: expected a boolean'));
    const next = this.#mutation.then(() => {
      const old = this.#consent;
      const changed = mode !== old.mode;
      // No relay means no consent notice and no choice to report later.
      const reporting = countChoice && !!this.#endpoint;
      const report = reporting && old.choice?.mode !== mode;
      if (!changed && !report) return this.state();
      const updated: Consent = { ...old, mode, forget: [...old.forget] };
      if (changed) {
        if (old.mode === 'enhanced' && old.installId) updated.forget.push(old.installId);
        // An opt-in never revives an identity queued for deletion.
        updated.installId = mode === 'enhanced' ? crypto.randomUUID() : null;
        // A selection without reporting supersedes any still-unsent choice.
        if (!reporting && old.choice?.pending) delete updated.choice;
      }
      if (report) updated.choice = { mode, uuid: crypto.randomUUID(), pending: true };
      // Consent, choice and deletion ledger share one durable atomic write.
      // Never wait for the network: stale responses check the receipt UUID.
      this.#save(updated);
      this.#consent = updated;
      if (changed) {
        this.#revision++;
        this.#queue = [];
        this.#controller?.abort();
        this.launch();
      }
      this.#failures = 0;
      this.#schedule(20_000);
      return this.state();
    });
    this.#mutation = next.catch(() => undefined);
    return next;
  }

  #save(consent = this.#consent): void {
    writeFileSync(`${this.#file}.tmp`, JSON.stringify(consent), { mode: 0o600 });
    renameSync(`${this.#file}.tmp`, this.#file);
  }

  private launch(): void {
    this.#launchPending = false;
    if (!this.#endpoint || this.#mode === 'off') return;
    if (this.#inFlight && this.#uploadRevision !== this.#revision) {
      this.#launchPending = true;
      return;
    }
    if (!this.#consent.firstRun) { this.track('first_run'); this.#consent.firstRun = true; }
    this.track('app_launched', { duration_ms: Date.now() - this.#core.startedAt });
    this.#ping();
    this.#save();
  }

  #ping(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.#mode === 'off' || this.#consent.pingDay === day) return;
    this.track('ping');
    this.#consent.pingDay = day;
    this.#save();
  }

  track(name: EventName, fields: Record<string, unknown> = {}): void {
    if (this.#closed || !this.#endpoint || this.#mode === 'off' || !EVENTS.includes(name)) return;
    // An aborted upload may ignore its signal; discard events until it settles.
    if (this.#inFlight && this.#uploadRevision !== this.#revision) return;
    if (name === 'subagent_started' && this.#mode !== 'enhanced') return;
    const event = telemetryEvent(name, this.#core.version, fields);
    if (this.#mode === 'enhanced' && name === 'turn_finished') Object.assign(event, enhancedDetails(fields));
    if (name === 'subagent_started') Object.assign(event, subagentDetails(fields));
    this.#queue.push(event);
    if (this.#queue.length > 200) this.#queue.shift();
  }

  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    if (this.#closed || !this.#endpoint) return;
    this.#timer = setTimeout(() => { void this.flush(); }, delay);
    this.#timer.unref();
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    if (!this.#endpoint) throw new Error('telemetry: no relay configured');
    // Consent receipts and deletions included: with analytics off by policy, the relay is never contacted.
    if (this.#ceiling() === 'off') throw this.#core.policy.refusal('analytics', path);
    const response = await this.#send(`${this.#endpoint}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `Boite/${this.#core.version} (telemetry)` },
      body: JSON.stringify(body), redirect: 'error',
      signal: this.#controller ? AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.#closing ? 1000 : 10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`telemetry ${path}: HTTP ${response.status}`);
    return response.json();
  }

  flush(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    if (!this.#endpoint || this.#closed) return Promise.resolve();
    const revision = this.#revision;
    this.#uploadRevision = revision;
    this.#controller = new AbortController();
    this.#inFlight = (async () => {
      try {
        // A deletion backlog must never suppress this independent anonymous receipt.
        let choiceFailed = false;
        try { await this.#reportChoice(); } catch { choiceFailed = true; }
        await this.#forgetPending();
        if (this.#mode === 'off' || revision !== this.#revision) {
          if (choiceFailed) throw new Error('telemetry: choice is still pending');
          this.#failures = 0;
          return;
        }
        this.#ping();
        const events = this.#queue.splice(0);
        if (events.length) {
          try {
            await this.#post('track', this.#mode === 'enhanced'
              ? { mode: 'B', install_id: this.#consent.installId, events }
              : { mode: 'A', anonymous_id: this.#consent.anonymousId, events });
          } catch (error) {
            if (revision === this.#revision) this.#queue = [...events, ...this.#queue].slice(-200);
            throw error;
          }
        }
        if (choiceFailed) throw new Error('telemetry: choice is still pending');
        this.#failures = 0;
      } catch {
        this.#failures++;
      } finally {
        this.#controller = null;
        this.#inFlight = null;
        if (this.#launchPending) {
          try { this.launch(); } catch { this.#failures++; }
        }
        this.#schedule(Math.min(3_600_000, INTERVAL * 2 ** Math.min(this.#failures, 4)));
      }
    })();
    return this.#inFlight;
  }

  async #reportChoice(): Promise<void> {
    const choice = this.#consent.choice;
    if (!choice?.pending) return;
    await this.#post('consent', { mode: choice.mode, receipt_id: choice.uuid });
    if (this.#consent.choice?.uuid !== choice.uuid) return;
    const updated = { ...this.#consent, choice: { ...choice, pending: false } };
    this.#save(updated);
    this.#consent = updated;
  }

  async #forgetPending(): Promise<void> {
    for (const id of [...this.#consent.forget]) {
      await this.#post('forget', { install_id: id });
      const updated = { ...this.#consent, forget: this.#consent.forget.filter(value => value !== id) };
      this.#save(updated);
      this.#consent = updated;
    }
  }

  async retryForget(): Promise<TelemetryState> {
    await this.#mutation;
    await this.flush();
    if (this.#consent.forget.length) throw new Error('telemetry: deletion is still pending; retry when the relay is available');
    return this.state();
  }

  async export(): Promise<Record<string, unknown>> {
    await this.#mutation;
    if (this.#mode !== 'enhanced' || !this.#consent.installId) throw invalid('telemetry export: expected enhanced mode');
    await this.flush();
    const value = await this.#post('export', { install_id: this.#consent.installId });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('telemetry export: invalid relay response');
    return value as Record<string, unknown>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#controller?.abort();
    await this.#mutation;
    await this.#inFlight;
    this.track('session_ended', { duration_ms: Date.now() - this.#core.startedAt });
    await this.flush();
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#unsubscribe();
    this.#queue = [];
  }
}

export function registerTelemetry(core: Core): void {
  // Owner-only by absence from DEVICE_METHODS and AGENT_METHODS.
  core.router.register('telemetry.state', () => core.telemetry.state());
  core.router.register('telemetry.configure', params => core.telemetry.configure(params.mode, params.countChoice));
  core.router.register('telemetry.export', () => core.telemetry.export());
  core.router.register('telemetry.retryForget', () => core.telemetry.retryForget());
}
