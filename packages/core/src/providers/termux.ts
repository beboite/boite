import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ResolvedCommand } from './resolve.ts';
import { readVersion } from './versions.ts';

/**
 * An agent installed by a package manager that lives inside its own prefix and
 * runs as the user, Termux's apt and dpkg under
 * `/data/data/com.termux/files/usr` being the one Boite meets. Termux builds
 * its own `codex` package, and `codex update` refuses it with `Could not
 * detect the Codex installation method`: that copy is updated by `apt-get`,
 * and its newest release is the one the Termux repository holds, which can
 * trail the npm `latest` tag by a few days.
 *
 * A system dpkg (`/var/lib/dpkg`) is not one: it needs root, which the core
 * does not have.
 */
export interface PrefixPackage {
  /** The prefix holding `var/lib/dpkg` and `bin/apt-get`. */
  prefix: string;
  /** The package that installed the program, as apt names it. */
  name: string;
  aptGet: string;
  aptCache: string;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The nearest directory above the program with its own dpkg database and apt this user can run. */
function prefixOf(program: string): string | null {
  for (let dir = dirname(program); ; dir = dirname(dir)) {
    const parent = dirname(dir);
    // `/` holds the system's dpkg, which only root writes.
    if (parent === dir) return null;
    const dpkg = join(dir, 'var', 'lib', 'dpkg');
    if (existsSync(join(dpkg, 'info')) && existsSync(join(dir, 'bin', 'apt-get'))) {
      try {
        accessSync(dpkg, constants.W_OK);
        return dir;
      } catch {
        return null;
      }
    }
  }
}

function lists(path: string, programs: Set<string>): boolean {
  try {
    return readFileSync(path, 'utf8').split('\n').some((line) => programs.has(line.trim()));
  } catch {
    return false;
  }
}

/** The prefix package that installed this program, or null when no such package manager owns it. */
export function prefixPackageOf(program: string): PrefixPackage | null {
  const real = realpathOr(program);
  const prefix = prefixOf(real);
  if (prefix === null) return null;
  const info = join(prefix, 'var', 'lib', 'dpkg', 'info');
  const programs = new Set([program, real]);
  const found = (file: string): PrefixPackage => ({
    prefix,
    name: file.slice(0, -'.list'.length),
    aptGet: join(prefix, 'bin', 'apt-get'),
    aptCache: join(prefix, 'bin', 'apt-cache'),
  });
  // The package usually carries the program's name: one file read instead of every list.
  const named = `${basename(real)}.list`;
  if (lists(join(info, named), programs)) return found(named);
  let files: string[];
  try {
    files = readdirSync(info);
  } catch {
    return null;
  }
  const owner = files.find((file) => file.endsWith('.list') && file !== named && lists(join(info, file), programs));
  return owner === undefined ? null : found(owner);
}

/**
 * The upstream part of a Debian version, in the form the agent prints:
 * `1:0.166.0-2` is 0.166.0, and `~`, Debian's pre-release mark, reads as `-`.
 */
export function upstreamVersion(version: string): string {
  let upstream = version.trim().replace(/^\d+:/, '');
  const revision = upstream.lastIndexOf('-');
  if (revision > 0) upstream = upstream.slice(0, revision);
  return upstream.replaceAll('~', '-');
}

/** The version `apt-cache policy` would install, null when the repository has none. */
export function policyCandidate(output: string): string | null {
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(output)?.[1];
  return candidate === undefined || candidate === '(none)' ? null : candidate;
}

/**
 * Why `apt-get update` left the index as it was. It exits with zero when a
 * repository cannot be reached and keeps the old index, so its own lines are
 * all that tell: offline, the old index would read as nothing newer.
 */
export function indexFailure(output: string): string | null {
  return /^(?:E: .*|W: Failed to fetch .*)$/m.exec(output)?.[0].slice(0, 300) ?? null;
}

/** `apt-get update` on a phone's connection. */
const INDEX_TIMEOUT_MS = 2 * 60 * 1000;
/** Keeps the configuration files the user changed, where dpkg would otherwise ask. */
const APT_KEEP_CONFIG = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

/** A program run in the agent's name, and how a failure names the command. */
export interface Via {
  command: ResolvedCommand;
  label: string;
}

/** apt run for an agent's package, with nobody to answer it and in the language its output is read in. */
export function aptVia(program: string, executable: string, args: string[]): Via {
  return {
    command: { executable, prefix: [], shown: program, updateEnv: { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' } },
    label: `${basename(executable)} ${args.join(' ')}`,
  };
}

type AptRun = (args: string[], timeoutMs: number, via: Via) => Promise<string>;

/**
 * Reads and upgrades prefix packages, each run traced as the agent's through
 * `run`. apt holds one lock per prefix and refuses a second command while it
 * is taken, so the runs of one prefix go one at a time: a check reads two
 * agents at once, and two of them can share Termux. It remembers when it
 * fetched each prefix's index, so the read right after an upgrade, or the
 * second agent of the same check, does not fetch it again.
 */
export class AptPackages {
  readonly #fetchedAt = new Map<string, number>();
  readonly #queues = new Map<string, Promise<unknown>>();

  /** The upstream version apt would install, its index fetched again unless that was within `maxAgeMs`. */
  latest(pkg: PrefixPackage, program: string, maxAgeMs: number, timeoutMs: number, run: AptRun): Promise<string> {
    const asked = Date.now();
    return this.#serial(pkg.prefix, () => this.#latest(pkg, program, asked, maxAgeMs, timeoutMs, run));
  }

  /** Upgrades that package alone, never the rest of the prefix, and returns what apt printed. */
  upgrade(pkg: PrefixPackage, program: string, timeoutMs: number, upgradeTimeoutMs: number, run: AptRun): Promise<string> {
    const asked = Date.now();
    return this.#serial(pkg.prefix, async () => {
      // The index a check read may be hours old, and a mirror drops the files an old index names.
      await this.#latest(pkg, program, asked, 0, timeoutMs, run);
      const args = ['install', '--only-upgrade', '-y', ...APT_KEEP_CONFIG, pkg.name];
      return run(args, upgradeTimeoutMs, aptVia(program, pkg.aptGet, args));
    });
  }

  async #latest(pkg: PrefixPackage, program: string, asked: number, maxAgeMs: number, timeoutMs: number, run: AptRun): Promise<string> {
    const fetchedAt = this.#fetchedAt.get(pkg.prefix);
    // An index fetched since this was asked is as fresh as one fetched now.
    if (fetchedAt === undefined || (fetchedAt < asked && Date.now() - fetchedAt > maxAgeMs)) {
      const failure = indexFailure(await run(['update'], INDEX_TIMEOUT_MS, aptVia(program, pkg.aptGet, ['update'])));
      if (failure !== null) throw new Error(`\`apt-get update\` could not read the package index: ${failure}`);
      this.#fetchedAt.set(pkg.prefix, Date.now());
    }
    const args = ['policy', pkg.name];
    const candidate = policyCandidate(await run(args, timeoutMs, aptVia(program, pkg.aptCache, args)));
    const latest = candidate === null ? null : readVersion(upstreamVersion(candidate));
    if (latest === null) throw new Error(`apt names no release of ${pkg.name} in ${pkg.prefix}`);
    return latest;
  }

  /** Runs `job` once every earlier job of that prefix has settled, failed ones included. */
  #serial<T>(prefix: string, job: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(prefix) ?? Promise.resolve()).catch(() => {}).then(job);
    this.#queues.set(prefix, next);
    void next.finally(() => {
      if (this.#queues.get(prefix) === next) this.#queues.delete(prefix);
    }).catch(() => {});
    return next;
  }
}
