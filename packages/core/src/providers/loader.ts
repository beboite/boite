import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { forgetWhich } from './which.ts';
import {
  threadActive,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderInstall,
  type ProviderLogin,
  type ProviderRejected,
  type ProviderSummary,
  type RpcResult,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { writesTitles } from '../drivers/index.ts';
import { InstallManager } from './install.ts';
import { detectResolves, HOST_CANDIDATES, hostAgentsEnabled, launcherScriptOnly, profileFor, resolveCommand } from './resolve.ts';
import { Rejection, validateDescriptor } from './validate.ts';
import { attachVersions, loadVersions, versionsSettled } from './versions.ts';
import { invalidParams, notFound, refused } from '../errors.ts';
import antigravityShipped from './shipped/antigravity.json';
import antigravityCliShipped from './shipped/antigravity-cli.json';
import claudeShipped from './shipped/claude.json';
import codexShipped from './shipped/codex.json';
import grokShipped from './shipped/grok.json';
import museShipped from './shipped/muse.json';
import opencodeShipped from './shipped/opencode.json';
import opencodeV2Shipped from './shipped/opencode-v2.json';
import piShipped from './shipped/pi.json';
import echoShipped from './shipped/echo.json';

/**
 * Echo is the fake agent the tests and the bench drive: no CLI, it repeats the
 * prompt and obeys `[permission]`, `[tool]` and `[spawn:...]` directives. A
 * user never picks it, so it ships only when `BOITE_ECHO=1` is in the
 * environment, which the test harness, the e2e suite and the bench set.
 */
export function echoEnabled(): boolean {
  return process.env['BOITE_ECHO'] === '1';
}

const SHIPPED_SOURCES: { file: string; raw: unknown; when?: () => boolean }[] = [
  { file: 'shipped/antigravity.json', raw: antigravityShipped },
  { file: 'shipped/antigravity-cli.json', raw: antigravityCliShipped },
  { file: 'shipped/claude.json', raw: claudeShipped },
  { file: 'shipped/codex.json', raw: codexShipped },
  { file: 'shipped/grok.json', raw: grokShipped },
  { file: 'shipped/muse.json', raw: museShipped },
  { file: 'shipped/opencode.json', raw: opencodeShipped },
  { file: 'shipped/opencode-v2.json', raw: opencodeV2Shipped },
  { file: 'shipped/pi.json', raw: piShipped },
  { file: 'shipped/echo.json', raw: echoShipped, when: echoEnabled },
];

export interface LoadedProvider {
  descriptor: ProviderDescriptor;
  source: 'shipped' | 'user';
  file: string;
}

export interface ProviderLoadResult {
  loaded: ProviderSummary[];
  rejected: ProviderRejected[];
}

/** How a client starts this provider's login, if it can. */
function loginSummary(login: ProviderLogin | undefined, protocol?: ProviderDescriptor['protocol']): ProviderSummary['login'] {
  if (login === undefined) return false;
  if (protocol === 'codex-appserver') return { kind: 'device' };
  if (login.acp !== undefined) return { kind: 'acp' };
  return { kind: login.terminal === true ? 'terminal' : 'command' };
}

/**
 * A provider whose files Boite has to download is unavailable until they are
 * there, and its summary says so through `install` rather than through a bare
 * `available: false`: that is what lets the picker offer the download instead
 * of a dead row.
 */
export function summarize(entry: LoadedProvider, installs: InstallManager, dataDir: string, enabled = true): ProviderSummary {
  const profile = profileFor(entry.descriptor);
  const executable = profile === undefined ? null : (resolveCommand(profile)?.shown ?? null);
  const available =
    profile !== undefined &&
    detectResolves(profile, installs.currentDir(entry.descriptor.id), dataDir) &&
    (profile.executable.length === 0 || executable !== null);
  return {
    id: entry.descriptor.id,
    name: entry.descriptor.name,
    shortName: entry.descriptor.shortName,
    protocol: entry.descriptor.protocol,
    source: entry.source,
    available,
    executable,
    login: loginSummary(entry.descriptor.login, entry.descriptor.protocol),
    alwaysIsolated: entry.descriptor.isolation?.alwaysIsolated === true,
    models: entry.descriptor.models,
    capabilities: entry.descriptor.capabilities,
    install: installs.stateOf(entry.descriptor.id, profile?.install),
    titles: writesTitles(entry.descriptor.protocol),
    enabled,
    ...(entry.descriptor.experimental === true ? { experimental: true } : {}),
  };
}

/** The versions read from the programs a candidate names with a `major`, kept across restarts. */
const VERSIONS_FILE = 'executable-versions.json';
/** A program that has not printed its version by then is not one of ours. */
const VERSION_TIMEOUT_MS = 20_000;
let versionRuns = 0;

/** One short run of a program to read its version, traced like every agent process. */
async function programOutput(core: Core, program: string, args: string[]): Promise<string> {
  // An id of its own: the timeout ends this run's tree and no other read's.
  const threadId = `version:${(versionRuns += 1)}`;
  const spawned = core.procs.spawnPiped(threadId, program, args, { cwd: core.dataDir });
  spawned.proc.stdin.end();
  const timer = setTimeout(() => core.procs.killTree(threadId), VERSION_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.proc.stdout).text(),
      new Response(spawned.proc.stderr).text(),
      spawned.exited,
    ]);
    return `${stdout}\n${stderr}`;
  } finally {
    clearTimeout(timer);
  }
}

/** The journal setting that holds the user's own choices, `{ "<provider id>": true | false }`. */
export const PROVIDER_SWITCHES = 'provider-switches';

export class ProviderRegistry {
  private entries = new Map<ProviderId, LoadedProvider>();
  private rejected: ProviderRejected[] = [];
  /**
   * The providers the user turned on or off themselves. One they never touched
   * is absent and follows its descriptor: on, or off for an experimental one.
   */
  private switches = new Map<ProviderId, boolean>();
  /** Managed installs: the state of each, the leases held on them, and the download itself. */
  readonly installs: InstallManager;

  /** Leaves the version readings this core joined, set once it can run a program. */
  private leaveVersions: () => void = () => undefined;

  constructor(private readonly dataDir: string) {
    this.installs = new InstallManager(dataDir);
    // Before the first resolution: a candidate that names a major resolves at once from what the last run read.
    loadVersions(join(dataDir, VERSIONS_FILE));
    this.load();
    // Nothing of an agent runs yet at start: releases an update left behind, and
    // downloads of a version no longer pinned, go now.
    for (const id of this.entries.keys()) {
      const install = this.installBlock(id);
      if (install !== undefined) this.installs.prune(id, install.version);
    }
  }

  /** The install block of this provider's profile for the OS the core runs on. */
  installBlock(id: ProviderId): ProviderInstall | undefined {
    const descriptor = this.get(id);
    if (descriptor === undefined) return undefined;
    return profileFor(descriptor)?.install;
  }

  load(): ProviderLoadResult {
    // A reload is also how a program installed or moved outside Boite is found at once.
    forgetWhich();
    const entries = new Map<ProviderId, LoadedProvider>();
    const rejected: ProviderRejected[] = [];

    for (const shipped of SHIPPED_SOURCES) {
      if (shipped.when !== undefined && !shipped.when()) continue;
      try {
        const descriptor = validateDescriptor(shipped.raw, shipped.file, new Set(), this.dataDir);
        if (!hostAgentsEnabled() && descriptor.id !== 'echo') {
          for (const profile of Object.values(descriptor.profiles)) if (profile !== undefined) HOST_CANDIDATES.add(profile.executable);
        }
        entries.set(descriptor.id, { descriptor, source: 'shipped', file: shipped.file });
      } catch (error) {
        if (error instanceof Rejection) rejected.push(error.rejected);
        else throw error;
      }
    }

    const shippedIds = new Set(entries.keys());
    for (const file of this.userFiles()) {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const descriptor = validateDescriptor(raw, file, shippedIds, this.dataDir);
        if (entries.has(descriptor.id)) {
          rejected.push({
            file,
            field: 'id',
            expected: 'an id no other descriptor uses',
            message: `the id ${descriptor.id} is already loaded`,
          });
          continue;
        }
        entries.set(descriptor.id, { descriptor, source: 'user', file });
      } catch (error) {
        if (error instanceof Rejection) rejected.push(error.rejected);
        else
          rejected.push({
            file,
            field: 'file',
            expected: 'valid JSON',
            message: error instanceof Error ? error.message : String(error),
          });
      }
    }

    this.entries = entries;
    this.rejected = rejected;
    return this.list();
  }

  list(): ProviderLoadResult {
    return {
      loaded: [...this.entries.values()].map((entry) => summarize(entry, this.installs, this.dataDir, this.enabledEntry(entry))),
      rejected: [...this.rejected],
    };
  }

  /** The core can run programs now: candidates waiting on a version get theirs, and `changed` hears each one. */
  attachVersions(run: (program: string, args: string[]) => Promise<string>, changed: () => void): void {
    this.leaveVersions();
    this.leaveVersions = attachVersions({ file: join(this.dataDir, VERSIONS_FILE), run, changed });
  }

  close(): void {
    this.leaveVersions();
    this.leaveVersions = () => undefined;
  }

  /** What the journal kept of the user's choices. Anything that is not a boolean is dropped. */
  loadSwitches(stored: unknown): void {
    this.switches.clear();
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return;
    for (const [id, value] of Object.entries(stored)) if (typeof value === 'boolean') this.switches.set(id, value);
  }

  /** Records the user's choice and returns every choice, as the journal stores them. */
  setSwitch(id: ProviderId, enabled: boolean): Record<string, boolean> {
    this.switches.set(id, enabled);
    return Object.fromEntries(this.switches);
  }

  /** Turned on: the user's choice when they made one, else on unless the descriptor is experimental. False for an unknown id. */
  enabled(id: ProviderId): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && this.enabledEntry(entry);
  }

  private enabledEntry(entry: LoadedProvider): boolean {
    return this.switches.get(entry.descriptor.id) ?? entry.descriptor.experimental !== true;
  }

  get(id: ProviderId): ProviderDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  require(id: ProviderId): ProviderDescriptor {
    const descriptor = this.get(id);
    if (descriptor === undefined) throw notFound(`unknown provider ${id}`, { providerId: id });
    return descriptor;
  }

  summary(id: ProviderId): ProviderSummary | undefined {
    const entry = this.entries.get(id);
    return entry === undefined ? undefined : summarize(entry, this.installs, this.dataDir, this.enabledEntry(entry));
  }

  /** The launcher script on PATH that stands where this provider's program should be, if that is why it is missing. */
  launcherScriptOnly(id: ProviderId): string | null {
    const descriptor = this.entries.get(id)?.descriptor;
    const profile = descriptor === undefined ? undefined : profileFor(descriptor);
    return profile === undefined ? null : launcherScriptOnly(profile);
  }

  /** The providers Boite may start something of: installed here and turned on. */
  available(): ProviderSummary[] {
    return this.list().loaded.filter((provider) => provider.available && provider.enabled !== false);
  }

  /**
   * Validate a user descriptor without loading it. The file has to be one of
   * ours: the answer says whether a path exists and hands back the first thing
   * a parser choked on, which on any path the caller names is a way to read the
   * machine one error message at a time.
   */
  dryRun(file: string): RpcResult<'providers.dryRun'> {
    const root = resolve(this.dataDir, 'providers');
    const resolved = resolve(file);
    const inside = relative(root, resolved);
    if (inside.startsWith('..') || resolve(inside) === inside || !resolved.endsWith('.json')) {
      return {
        ok: false,
        rejected: {
          file,
          field: 'file',
          expected: `a .json file under ${root}`,
          message: 'a descriptor is read from the providers directory of the data directory, nowhere else',
        },
      };
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
      const shippedIds = new Set(
        [...this.entries.values()].filter((entry) => entry.source === 'shipped').map((entry) => entry.descriptor.id),
      );
      const descriptor = validateDescriptor(raw, file, shippedIds, this.dataDir);
      const entry: LoadedProvider = { descriptor, source: 'user', file };
      const profile = profileFor(descriptor);
      return {
        ok: true,
        summary: summarize(entry, this.installs, this.dataDir),
        plan: {
          roots: descriptor.roots,
          env: profile === undefined ? [] : Object.keys(profile.isolation),
          closes: profile?.close?.processes ?? [],
        },
      };
    } catch (error) {
      if (error instanceof Rejection) return { ok: false, rejected: error.rejected };
      return {
        ok: false,
        rejected: {
          file,
          field: 'file',
          expected: 'a readable JSON descriptor',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private userFiles(): string[] {
    const dir = join(this.dataDir, 'providers');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(dir, name));
  }
}

export function registerProviderMethods(core: Core): void {
  core.providers.installs.attach({
    emit: (payload) => {
      core.bus.emit('providers.installProgress', payload);
    },
    updated: () => {
      // A provider that just landed may already be logged in through the user's
      // own CLI: its default account has to exist before the clients hear of it,
      // or they start a sign-in nobody needs. A failure here must not reach the
      // installer, which would take it for a failed install and delete the release.
      try { core.accounts.ensureDefaults(); }
      catch (error) { core.log('error', `default accounts after an install: ${error instanceof Error ? error.message : String(error)}`); }
      core.bus.emit('providers.updated', core.providers.list());
    },
    log: (level, message) => {
      core.log(level, message);
    },
  });

  // A client is answered once every program a candidate asks its version has
  // answered: listing starts those reads, and without the wait the first list
  // after an install would miss a provider for the second its program takes.
  const settledList = async (): Promise<ProviderLoadResult> => {
    core.providers.list();
    await versionsSettled();
    return core.providers.list();
  };
  core.router.register('providers.list', settledList);
  // The loaded descriptors in full, what each resolves to and the rejections:
  // a reload that changes none of it leaves every client and cached model list alone.
  const fingerprint = (result: ProviderLoadResult): string =>
    JSON.stringify([result, result.loaded.map((summary) => core.providers.get(summary.id))]);
  // A program that just reported its version may be what a provider was
  // waiting for: it is listed as installed from now on, and a login it already
  // has is adopted before the clients hear of it.
  let listed = fingerprint(core.providers.list());
  core.providers.attachVersions(
    (program, args) => programOutput(core, program, args),
    () => {
      if (core.stopping || core.journal.isClosed()) return;
      const result = core.providers.list();
      const now = fingerprint(result);
      if (now === listed) return;
      listed = now;
      try { core.accounts.ensureDefaults(); }
      catch (error) { core.log('error', `default accounts after a version read: ${error instanceof Error ? error.message : String(error)}`); }
      core.bus.emit('providers.updated', core.providers.list());
    },
  );
  core.router.register('providers.reload', async () => {
    const before = fingerprint(core.providers.list());
    core.providers.load();
    const result = await settledList();
    core.accounts.ensureDefaults();
    if (fingerprint(result) !== before) core.bus.emit('providers.updated', result);
    return result;
  });
  core.router.register('providers.install', (params) => {
    const install = core.providers.installBlock(core.providers.require(params.providerId).id);
    if (install === undefined) {
      throw refused(`${params.providerId} has nothing for Boite to install on this platform`, {
        providerId: params.providerId,
      });
    }
    return core.providers.installs.start(params.providerId, install);
  });
  core.router.register('providers.installCancel', (params) =>
    core.providers.installs.cancel(params.providerId, params.operationId),
  );
  core.router.register('providers.uninstall', (params) => {
    const provider = core.providers.require(params.providerId);
    return core.providers.installs.uninstall(provider.id, core.providers.installBlock(provider.id));
  });
  core.router.register('providers.dryRun', (params) => core.providers.dryRun(params.file));
  core.router.register('providers.setEnabled', (params) => {
    const provider = core.providers.require(params.providerId);
    if (typeof params.enabled !== 'boolean') {
      throw invalidParams('enabled must be true or false', { field: 'enabled', expected: 'a boolean' });
    }
    if (core.providers.enabled(provider.id) === params.enabled) return core.providers.list();
    core.journal.setSetting(PROVIDER_SWITCHES, core.providers.setSwitch(provider.id, params.enabled));
    if (params.enabled) {
      // A login the user already has is adopted now, as it is when a provider is installed.
      core.accounts.ensureDefaults();
    } else {
      // A warm process is something of this provider still running. A turn in
      // flight is left to end by itself: the switch refuses the next one.
      for (const thread of core.journal.listThreads()) {
        if (thread.providerId === provider.id && !threadActive(thread.status)) core.threads.releaseAgent(thread.id);
      }
    }
    const result = core.providers.list();
    core.bus.emit('providers.updated', result);
    return result;
  });
}
