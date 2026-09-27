import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Account,
  AccountId,
  HookOutcome,
  HookRun,
  HookShareState,
  HookSourceState,
  HooksStatus,
  Protocol,
  ProviderDescriptor,
  ProviderHooks,
  ProviderHookSource,
  ProviderId,
  ThreadId,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { homePath, tildePath } from './paths.ts';
import { statEntry, variableHome } from './profile-share.ts';
import { hostAgentsEnabled, profileFor } from './providers/resolve.ts';

/** How many runs that did not pass the core keeps, newest first. */
const RECENT_MAX = 50;
const MESSAGE_MAX = 500;
/** The drivers that see each hook run. The others only have the configuration to show. */
const REPORTING: ReadonlySet<Protocol> = new Set(['claude-sdk', 'codex-appserver']);
/** What a `modules` source counts: a script, or a directory holding a package. */
const MODULE_FILE = /\.(?:[cm]?js|[cm]?ts)$/i;

/** One hook run as a driver saw it. */
export interface HookReport {
  event: string;
  name: string;
  outcome: HookOutcome;
  message: string | null;
}

interface Counts {
  runs: number;
  blocked: number;
  failed: number;
  skipped: number;
}

/**
 * What the user's hooks did since the core started, per provider. Runs that
 * passed are only counted; the others are kept, the newest fifty, and each one
 * tells the owner's clients through `hooks.changed`. Nothing is journalled: a
 * hook that blocks every prompt shows in its thread, and this is the overview.
 */
export class HookLedger {
  readonly since = Date.now();
  private readonly counts = new Map<ProviderId, Counts>();
  private readonly recent: HookRun[] = [];
  /** A hook Codex skips is reported at every session start; once is enough. */
  private readonly skippedSeen = new Set<string>();

  constructor(private readonly core: Core) {}

  record(where: { providerId: ProviderId; accountId: AccountId | null; threadId: ThreadId | null }, report: HookReport): void {
    const counts = this.countsOf(where.providerId);
    if (report.outcome === 'skipped') {
      const key = `${where.providerId}\n${where.accountId ?? ''}\n${report.event}\n${report.name}\n${report.message ?? ''}`;
      if (this.skippedSeen.has(key)) return;
      this.skippedSeen.add(key);
      counts.skipped += 1;
    } else {
      counts.runs += 1;
      if (report.outcome === 'ok') return;
      if (report.outcome === 'failed') counts.failed += 1;
      else counts.blocked += 1;
    }
    const message = report.message?.trim() ?? '';
    this.recent.unshift({
      at: Date.now(),
      providerId: where.providerId,
      accountId: where.accountId,
      threadId: where.threadId,
      event: report.event,
      name: report.name,
      outcome: report.outcome,
      message: message.length === 0 ? null : message.slice(0, MESSAGE_MAX),
    });
    this.recent.length = Math.min(this.recent.length, RECENT_MAX);
    this.core.bus.emit('hooks.changed', { at: Date.now() });
  }

  /**
   * Every available provider: whether it runs hooks, how many the user has
   * where it reads them, and for each account of its own what it does not get
   * of the user's profile. Reading that shares the profile again, the way a
   * spawn would, so an account made before sharing existed is brought up to date.
   */
  status(): HooksStatus {
    const accounts = this.core.accounts.list();
    const providers = this.core.providers.available().flatMap((summary): ProviderHooks[] => {
      const provider = this.core.providers.get(summary.id);
      if (provider === undefined) return [];
      const runsHooks = provider.capabilities.hooks;
      const counts = this.countsOf(provider.id);
      return [{
        providerId: provider.id,
        name: provider.name,
        runsHooks,
        reports: runsHooks && REPORTING.has(provider.protocol),
        sources: runsHooks ? (provider.hookSources ?? []).map(readSource) : [],
        accounts: runsHooks
          ? accounts.filter((account) => account.providerId === provider.id && account.isolationDir !== null)
            .map((account): HookShareState => ({ accountId: account.id, label: account.label, problems: this.problemsOf(account, provider) }))
          : [],
        ...counts,
      }];
    });
    return { since: this.since, providers, recent: [...this.recent] };
  }

  private problemsOf(account: Account, provider: ProviderDescriptor): HookShareState['problems'] {
    if (profileFor(provider) === undefined) return [];
    if ((provider.shared ?? []).length === 0) {
      return [{ path: '', message: `${provider.name} does not say what a separate account shares, so it runs none of your hooks` }];
    }
    try {
      return this.core.accounts.prepare(account, provider);
    } catch (error) {
      return [{ path: '', message: messageOf(error) }];
    }
  }

  private countsOf(providerId: ProviderId): Counts {
    let counts = this.counts.get(providerId);
    if (counts === undefined) {
      counts = { runs: 0, blocked: 0, failed: 0, skipped: 0 };
      this.counts.set(providerId, counts);
    }
    return counts;
  }
}

/** The path a source names, on this machine. Null when its variable has no known default. */
export function sourcePath(source: ProviderHookSource): string | null {
  if (source.variable === undefined) return join(homePath(), ...source.path.slice(2).split('/'));
  const base = variableHome(source.variable);
  return base === null ? null : join(base, ...source.path.split('/'));
}

export function readSource(source: ProviderHookSource): HookSourceState {
  const path = sourcePath(source);
  if (path === null) {
    return { path: source.path, format: source.format, count: null, error: `Boite does not know where ${source.variable ?? ''} points` };
  }
  const shown = tildePath(path);
  // A test core never reads the developer's own profile: the path is all it says.
  if (!hostAgentsEnabled()) return { path: shown, format: source.format, count: null, error: null };
  const found = statEntry(path, true);
  if (found === undefined) return { path: shown, format: source.format, count: null, error: null };
  try {
    if (source.format === 'modules') {
      if (!found.isDirectory()) return { path: shown, format: source.format, count: null, error: 'not a directory' };
      const count = readdirSync(path, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || MODULE_FILE.test(entry.name)))
        .length;
      return { path: shown, format: source.format, count, error: null };
    }
    const files = found.isDirectory()
      ? readdirSync(path).filter((name) => name.toLowerCase().endsWith('.json')).map((name) => join(path, name))
      : [path];
    let count = 0;
    for (const file of files) {
      try {
        count += countEvents(JSON.parse(readFileSync(file, 'utf8')));
      } catch (error) {
        return { path: tildePath(file), format: source.format, count: null, error: `not valid JSON: ${messageOf(error)}` };
      }
    }
    return { path: shown, format: source.format, count, error: null };
  } catch (error) {
    return { path: shown, format: source.format, count: null, error: messageOf(error) };
  }
}

/** `{ "hooks": { "<Event>": [{ "matcher": ..., "hooks": [ ... ] }] } }`: each inner entry is one hook. */
export function countEvents(value: unknown): number {
  const hooks = typeof value === 'object' && value !== null ? (value as { hooks?: unknown }).hooks : undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 0;
  let count = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = typeof group === 'object' && group !== null ? (group as { hooks?: unknown }).hooks : undefined;
      count += Array.isArray(inner) ? inner.length : 1;
    }
  }
  return count;
}

export function registerHookMethods(core: Core): void {
  core.router.register('hooks.status', () => core.hooks.status());
}
