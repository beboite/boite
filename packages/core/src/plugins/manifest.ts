/*
 * The plugin manifest, `boite-plugin.json`: one shape for the plugins the core
 * recommends and for the ones the owner adds from a git URL. The reader below
 * is the whole format. A field it does not know, a value it cannot use, a
 * platform it has never heard of: each is refused with the file, the field and
 * what was expected, never skipped. docs/plugins.md is the authoring guide.
 */

import { PLUGIN_MANIFEST_SCHEMA, PLUGIN_PLATFORMS } from '@boite/contracts';
import type { PluginArtifact, PluginManifest, PluginPlatform, PluginRejected, ProviderId } from '@boite/contracts';

/** The shipped providers an account pool may name. `echo` is the tests' fake agent. */
export const POOL_PROVIDERS: readonly ProviderId[] = ['antigravity', 'claude', 'codex', 'grok', 'opencode', 'pi'];
/** A manifest is a few hundred bytes; anything past this is not one. */
export const MANIFEST_MAX_BYTES = 64 * 1024;

const FIELDS = ['schema', 'id', 'name', 'version', 'description', 'homepage', 'executable', 'artifacts', 'provides'] as const;
const FEATURES = ['accountPools'] as const;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A refusal the RPC layer and the list both carry as is. */
export class ManifestRefused extends Error {
  readonly rejected: PluginRejected;
  constructor(file: string, field: string, expected: string, found: string) {
    const message = `${file}: ${field} must be ${expected}, found ${found}`;
    super(message);
    this.name = 'ManifestRefused';
    this.rejected = { file, field, expected, message };
  }
}

/** `win32-x64` and so on: the artifact key this core downloads. */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** What was found, short enough to read in one line. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value);
  return `${typeof value} ${String(value)}`;
}

/** A refusal built outside the reader, for a file that wraps a manifest or a check the format alone cannot make. */
export function refusal(file: string, field: string, expected: string, value: unknown): ManifestRefused {
  return new ManifestRefused(file, field, expected, describe(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An https URL with a host, no user or password in it: what an artifact, a
 * homepage and a source may point at. Returns the reason it is not, or null.
 */
export function httpsProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return `a ${url.protocol.replace(':', '')} URL`;
  if (url.hostname.length === 0) return 'a URL with no host';
  if (url.username !== '' || url.password !== '') return 'a URL carrying credentials';
  return null;
}

class Reader {
  constructor(
    private readonly file: string,
    private readonly prefix: string,
  ) {}

  refuse(field: string, expected: string, value: unknown): never {
    throw new ManifestRefused(this.file, `${this.prefix}${field}`, expected, describe(value));
  }

  keys(value: Record<string, unknown>, prefix: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.refuse(`${prefix}${key}`, `one of ${allowed.join(', ')}`, key);
    }
  }

  text(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || CONTROL.test(value)) {
      this.refuse(field, `a string of 1 to ${max} characters, no control characters`, value);
    }
    return value;
  }

  matching(value: unknown, field: string, pattern: RegExp, expected: string): string {
    if (typeof value !== 'string' || !pattern.test(value)) this.refuse(field, expected, value);
    return value;
  }

  https(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length > 2048 || httpsProblem(value) !== null) {
      this.refuse(field, 'an https URL with a host and no credentials', value);
    }
    return value;
  }

  artifact(value: unknown, field: string): PluginArtifact {
    if (!isRecord(value)) this.refuse(field, 'an object with url and sha256', value);
    this.keys(value, `${field}.`, ['url', 'sha256']);
    return {
      url: this.https(value['url'], `${field}.url`),
      sha256: this.matching(value['sha256'], `${field}.sha256`, SHA256_PATTERN, '64 lowercase hexadecimal characters'),
    };
  }

  artifacts(value: unknown): Partial<Record<PluginPlatform, PluginArtifact>> {
    if (!isRecord(value) || Object.keys(value).length === 0) {
      this.refuse('artifacts', `an object keyed by at least one of ${PLUGIN_PLATFORMS.join(', ')}`, value);
    }
    this.keys(value, 'artifacts.', PLUGIN_PLATFORMS);
    const out: Partial<Record<PluginPlatform, PluginArtifact>> = {};
    for (const platform of PLUGIN_PLATFORMS) {
      if (value[platform] !== undefined) out[platform] = this.artifact(value[platform], `artifacts.${platform}`);
    }
    return out;
  }

  provides(value: unknown): PluginManifest['provides'] {
    if (!isRecord(value) || Object.keys(value).length === 0) {
      this.refuse('provides', `an object naming at least one of ${FEATURES.join(', ')}`, value);
    }
    this.keys(value, 'provides.', FEATURES);
    const pools = value['accountPools'];
    if (!isRecord(pools)) this.refuse('provides.accountPools', 'an object with providers', pools);
    this.keys(pools, 'provides.accountPools.', ['providers']);
    const providers = pools['providers'];
    const expected = `a non-empty array of distinct provider ids among ${POOL_PROVIDERS.join(', ')}`;
    if (!Array.isArray(providers) || providers.length === 0) this.refuse('provides.accountPools.providers', expected, providers);
    providers.forEach((provider: unknown, index) => {
      if (typeof provider !== 'string' || !POOL_PROVIDERS.includes(provider) || providers.indexOf(provider) !== index) {
        this.refuse(`provides.accountPools.providers[${index}]`, expected, provider);
      }
    });
    return { accountPools: { providers: [...(providers as string[])] } };
  }
}

/**
 * The manifest, or a `ManifestRefused` naming the first thing wrong. `file` is
 * what the refusal says it read: a path, or `boite-plugin.json` for a
 * repository, or the recommended list's entry. `prefix` places the fields when
 * the manifest sits inside another file, `manifest.` in `installed.json`.
 */
export function parseManifest(raw: unknown, file: string, prefix = ''): PluginManifest {
  const read: Reader = new Reader(file, prefix);
  if (!isRecord(raw)) throw new ManifestRefused(file, prefix === '' ? '(root)' : prefix.replace(/\.$/, ''), 'a JSON object', describe(raw));
  read.keys(raw, '', FIELDS);
  if (raw['schema'] !== PLUGIN_MANIFEST_SCHEMA) read.refuse('schema', String(PLUGIN_MANIFEST_SCHEMA), raw['schema']);
  return {
    schema: PLUGIN_MANIFEST_SCHEMA,
    id: read.matching(raw['id'], 'id', ID_PATTERN, 'lowercase letters, digits and inner hyphens, 1 to 64 characters'),
    name: read.text(raw['name'], 'name', 60),
    version: read.matching(raw['version'], 'version', VERSION_PATTERN, 'a version such as 1.2.0 or 1.2.0-beta.1'),
    description: read.text(raw['description'], 'description', 300),
    homepage: read.https(raw['homepage'], 'homepage'),
    executable: read.matching(
      raw['executable'],
      'executable',
      EXECUTABLE_PATTERN,
      'a file name of letters, digits, _ and -, no extension (Boite adds .exe on Windows)',
    ),
    artifacts: read.artifacts(raw['artifacts']),
    provides: read.provides(raw['provides']),
  };
}

/** The manifest from its JSON text, the parse failure refused like any field. */
export function parseManifestText(text: string, file: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestRefused(file, '(file)', 'valid JSON', error instanceof Error ? error.message : 'unreadable text');
  }
  return parseManifest(raw, file);
}

export function artifactFor(manifest: PluginManifest, platform = platformKey()): PluginArtifact | null {
  return manifest.artifacts[platform as PluginPlatform] ?? null;
}

export function poolsOf(manifest: PluginManifest): ProviderId[] {
  return manifest.provides.accountPools?.providers ?? [];
}

/**
 * The account pool commands, the contract a plugin that provides
 * `accountPools` answers. `list` prints JSON on stdout; the other three change
 * the saved logins and print nothing Boite reads.
 */
export const POOL_COMMANDS = {
  list: (provider: string, refresh: boolean) => ['list', `-${provider}`, '-Json', ...(refresh ? ['-Refresh'] : [])],
  add: (provider: string) => ['add', `-${provider}`],
  switch: (provider: string, email: string) => ['switch', `-${provider}`, '-Email', email, '-Yes'],
  remove: (provider: string, email: string) => ['remove', `-${provider}`, '-Email', email, '-Yes'],
} as const;

/** What the owner is shown before an install: every command line Boite may run. */
export function commandsOf(manifest: PluginManifest): string[] {
  if (poolsOf(manifest).length === 0) return [];
  const run = (args: readonly string[]) => [manifest.executable, ...args].join(' ');
  return [
    run(POOL_COMMANDS.list('<pool>', false)),
    run(POOL_COMMANDS.list('<pool>', true)),
    run(POOL_COMMANDS.add('<pool>')),
    run(POOL_COMMANDS.switch('<pool>', '<email>')),
    run(POOL_COMMANDS.remove('<pool>', '<email>')),
  ];
}
