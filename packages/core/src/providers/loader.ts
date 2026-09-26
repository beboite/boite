import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { forgetWhich } from './which.ts';
import type {
  ProviderDescriptor,
  ProviderId,
  ProviderInstall,
  ProviderLogin,
  ProviderRejected,
  ProviderSummary,
  RpcResult,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { InstallManager } from './install.ts';
import { detectResolves, HOST_CANDIDATES, hostAgentsEnabled, launcherScriptOnly, profileFor, resolveCommand } from './resolve.ts';
import { Rejection, validateDescriptor } from './validate.ts';
import { notFound, refused } from '../errors.ts';
import antigravityShipped from './shipped/antigravity.json';
import antigravityCliShipped from './shipped/antigravity-cli.json';
import claudeShipped from './shipped/claude.json';
import codexShipped from './shipped/codex.json';
import grokShipped from './shipped/grok.json';
import museShipped from './shipped/muse.json';
import opencodeShipped from './shipped/opencode.json';
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
function loginSummary(login: ProviderLogin | undefined): ProviderSummary['login'] {
  if (login === undefined) return false;
  if (login.acp !== undefined) return { kind: 'acp' };
  return { kind: login.terminal === true ? 'terminal' : 'command' };
}

/**
 * A provider whose files Boite has to download is unavailable until they are
 * there, and its summary says so through `install` rather than through a bare
 * `available: false`: that is what lets the picker offer the download instead
 * of a dead row.
 */
export function summarize(entry: LoadedProvider, installs: InstallManager, dataDir: string): ProviderSummary {
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
    login: loginSummary(entry.descriptor.login),
    alwaysIsolated: entry.descriptor.isolation?.alwaysIsolated === true,
    models: entry.descriptor.models,
    capabilities: entry.descriptor.capabilities,
    install: installs.stateOf(entry.descriptor.id, profile?.install),
  };
}

export class ProviderRegistry {
  private entries = new Map<ProviderId, LoadedProvider>();
  private rejected: ProviderRejected[] = [];
  /** Managed installs: the state of each, the leases held on them, and the download itself. */
  readonly installs: InstallManager;

  constructor(private readonly dataDir: string) {
    this.installs = new InstallManager(dataDir);
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
      loaded: [...this.entries.values()].map((entry) => summarize(entry, this.installs, this.dataDir)),
      rejected: [...this.rejected],
    };
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
    return entry === undefined ? undefined : summarize(entry, this.installs, this.dataDir);
  }

  /** The launcher script on PATH that stands where this provider's program should be, if that is why it is missing. */
  launcherScriptOnly(id: ProviderId): string | null {
    const descriptor = this.entries.get(id)?.descriptor;
    const profile = descriptor === undefined ? undefined : profileFor(descriptor);
    return profile === undefined ? null : launcherScriptOnly(profile);
  }

  available(): ProviderSummary[] {
    return this.list().loaded.filter((provider) => provider.available);
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

  core.router.register('providers.list', () => core.providers.list());
  // The loaded descriptors in full, what each resolves to and the rejections:
  // a reload that changes none of it leaves every client and cached model list alone.
  const fingerprint = (result: ProviderLoadResult): string =>
    JSON.stringify([result, result.loaded.map((summary) => core.providers.get(summary.id))]);
  core.router.register('providers.reload', () => {
    const before = fingerprint(core.providers.list());
    const result = core.providers.load();
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
}
