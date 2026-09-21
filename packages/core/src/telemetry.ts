import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryState, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams as invalid } from './errors.ts';
import { enhancedDetails, type EnhancedDetails } from '../../contracts/src/telemetry.ts';

const EVENTS = ['ping', 'first_run', 'app_launched', 'session_ended', 'project_added', 'thread_spawned', 'turn_finished'] as const;
type EventName = typeof EVENTS[number];
const PROVIDERS = ['claude', 'codex', 'opencode', 'pi', 'grok', 'antigravity', 'antigravity-cli', 'muse'];
const MODES = ['off', 'basic', 'enhanced'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERVAL = 300_000;
interface Consent {
  mode: TelemetryState['mode'];
  anonymousId: string;
  installId: string | null;
  forget: string[];
  firstRun: boolean;
  pingDay: string;
}
export interface TelemetryEvent extends EnhancedDetails {
  name: EventName;
  uuid: string;
  app_version: string;
  os: string;
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
    arch: ['x64', 'arm64', 'ia32'].includes(process.arch) ? process.arch : 'other',
    client_ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (name === 'thread_spawned' || name === 'turn_finished') {
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
  private consent: Consent;
  private readonly file: string;
  private queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private revision = 0;
  private failures = 0;
  private closed = false;
  private closing = false;
  private unsubscribe: () => void;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private core: Core, private endpoint = process.env.BOITE_TELEMETRY_URL ?? 'https://boite-v2-telemetry.nefreex.workers.dev', private send: typeof fetch = fetch) {
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
        throw invalid('BOITE_TELEMETRY_URL: expected HTTPS or loopback HTTP');
      }
      if (url.username || url.password || url.search || url.hash) throw invalid('BOITE_TELEMETRY_URL: expected an origin without credentials, query or fragment');
      this.endpoint = endpoint.replace(/\/$/, '');
    }
    this.file = join(core.dataDir, 'telemetry.json');
    this.consent = { mode: 'basic', anonymousId: crypto.randomUUID(), installId: null, forget: [], firstRun: false, pingDay: '' };
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Consent;
        if (!MODES.includes(saved.mode) || !UUID.test(saved.anonymousId) ||
            (saved.installId !== null && !UUID.test(saved.installId)) ||
            !Array.isArray(saved.forget) || saved.forget.some(id => !UUID.test(id)) ||
            typeof saved.firstRun !== 'boolean' || typeof saved.pingDay !== 'string' ||
            (saved.mode === 'enhanced' && !saved.installId)) throw invalid('telemetry.json: expected valid consent and UUID identifiers');
        this.consent = saved;
      } catch {
        // Never overwrite an unreadable deletion ledger with fresh consent.
        throw invalid('telemetry.json: cannot load consent; expected readable JSON with valid consent and UUID identifiers. Preserve this file and restore a valid backup or repair it while retaining forget and installId; see docs/analytics.md#repairing-consent-state.');
      }
    }
    this.unsubscribe = core.bus.onAny((name, payload) => {
      if (name === 'project.added') this.track('project_added');
      if (name === 'thread.created') this.track('thread_spawned', { provider: (payload as { providerId: string }).providerId });
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
    this.launch();
    this.schedule(20_000);
  }

  state(): TelemetryState {
    return { mode: this.consent.mode, configured: !!this.endpoint, pendingDeletion: this.consent.forget.length > 0 };
  }

  configure(mode: TelemetryState['mode']): Promise<TelemetryState> {
    if (!MODES.includes(mode)) return Promise.reject(invalid('mode: expected off, basic or enhanced'));
    const next = this.mutation.then(async () => {
      if (mode === this.consent.mode) return this.state();
      if (mode === 'enhanced' && this.consent.forget.length) throw invalid('telemetry: retry pending deletion before enabling enhanced mode');
      this.revision++;
      this.queue = [];
      this.controller?.abort();
      await this.inFlight;
      const old = this.consent;
      this.consent = { ...old, mode, forget: [...old.forget] };
      // Events accepted while the aborted upload settled belong to the old consent.
      this.queue = [];
      if (old.mode === 'enhanced' && old.installId) {
        this.consent.forget.push(old.installId);
        this.consent.installId = null;
      }
      if (mode === 'enhanced') this.consent.installId = crypto.randomUUID();
      try { this.save(); } catch (error) { this.consent = old; throw error; }
      this.failures = 0;
      this.launch();
      this.schedule(20_000);
      return this.state();
    });
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.consent), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private launch(): void {
    if (!this.endpoint || this.consent.mode === 'off') return;
    if (!this.consent.firstRun) { this.track('first_run'); this.consent.firstRun = true; }
    this.track('app_launched', { duration_ms: Date.now() - this.core.startedAt });
    this.ping();
    this.save();
  }

  private ping(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.consent.mode === 'off' || this.consent.pingDay === day) return;
    this.track('ping');
    this.consent.pingDay = day;
    this.save();
  }

  track(name: EventName, fields: Record<string, unknown> = {}): void {
    if (this.closed || !this.endpoint || this.consent.mode === 'off' || !EVENTS.includes(name)) return;
    const event = telemetryEvent(name, this.core.version, fields);
    if (this.consent.mode === 'enhanced' && name === 'turn_finished') Object.assign(event, enhancedDetails(fields));
    this.queue.push(event);
    if (this.queue.length > 200) this.queue.shift();
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (this.closed || !this.endpoint) return;
    this.timer = setTimeout(() => { void this.flush(); }, delay);
    this.timer.unref();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    if (!this.endpoint) throw new Error('telemetry: no relay configured');
    const response = await this.send(`${this.endpoint}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `Boite/${this.core.version} (telemetry)` },
      body: JSON.stringify(body), redirect: 'error',
      signal: this.controller ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.closing ? 1000 : 10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`telemetry ${path}: HTTP ${response.status}`);
    return response.json();
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.endpoint || this.closed) return Promise.resolve();
    const revision = this.revision;
    this.controller = new AbortController();
    this.inFlight = (async () => {
      try {
        await this.forgetPending();
        if (this.consent.mode === 'off' || revision !== this.revision) {
          this.queue = [];
          return;
        }
        this.ping();
        const events = this.queue.splice(0);
        if (events.length) {
          try {
            await this.post('track', this.consent.mode === 'enhanced'
              ? { mode: 'B', install_id: this.consent.installId, events }
              : { mode: 'A', anonymous_id: this.consent.anonymousId, events });
          } catch (error) {
            if (revision === this.revision) this.queue = [...events, ...this.queue].slice(-200);
            throw error;
          }
        }
        this.failures = 0;
      } catch {
        this.failures++;
      } finally {
        this.controller = null;
        this.inFlight = null;
        this.schedule(Math.min(3_600_000, INTERVAL * 2 ** Math.min(this.failures, 4)));
      }
    })();
    return this.inFlight;
  }

  private async forgetPending(): Promise<void> {
    for (const id of [...this.consent.forget]) {
      await this.post('forget', { install_id: id });
      this.consent.forget = this.consent.forget.filter(value => value !== id);
      this.save();
    }
  }

  async retryForget(): Promise<TelemetryState> {
    await this.mutation;
    await this.flush();
    if (this.consent.forget.length) throw new Error('telemetry: deletion is still pending; retry when the relay is available');
    return this.state();
  }

  async export(): Promise<Record<string, unknown>> {
    await this.mutation;
    if (this.consent.mode !== 'enhanced' || !this.consent.installId) throw invalid('telemetry export: expected enhanced mode');
    await this.flush();
    const value = await this.post('export', { install_id: this.consent.installId });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('telemetry export: invalid relay response');
    return value as Record<string, unknown>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.controller?.abort();
    await this.mutation;
    await this.inFlight;
    this.track('session_ended', { duration_ms: Date.now() - this.core.startedAt });
    await this.flush();
    this.closed = true;
    clearTimeout(this.timer);
    this.unsubscribe();
    this.queue = [];
  }
}

export function registerTelemetry(core: Core): void {
  // Owner-only by absence from DEVICE_METHODS and AGENT_METHODS.
  core.router.register('telemetry.state', () => core.telemetry.state());
  core.router.register('telemetry.configure', params => core.telemetry.configure(params.mode));
  core.router.register('telemetry.export', () => core.telemetry.export());
  core.router.register('telemetry.retryForget', () => core.telemetry.retryForget());
}
