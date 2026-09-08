import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type {
  EffortLevel,
  ExecutableCandidate,
  ModelInfo,
  Os,
  OsProfile,
  Protocol,
  ProviderAuth,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderId,
  ProviderLogin,
  ProviderRejected,
  ProviderSummary,
  RpcResult,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { appDataPath, currentOs, homePath } from '../paths.ts';
import { notFound } from '../errors.ts';
import claudeShipped from './shipped/claude.json';
import opencodeShipped from './shipped/opencode.json';
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

/**
 * Where the shipped descriptors and the scripts they name live. A login command
 * writes `{shippedDir}/<script>` instead of a path nobody could write by hand.
 * Only echo uses it, and echo ships from the sources alone (`BOITE_ECHO=1`); a
 * command whose script is missing fails at spawn, with the path in the event.
 */
const SHIPPED_DIR = join(import.meta.dir, 'shipped');

const SHIPPED_SOURCES: { file: string; raw: unknown; when?: () => boolean }[] = [
  { file: 'shipped/claude.json', raw: claudeShipped },
  { file: 'shipped/opencode.json', raw: opencodeShipped },
  { file: 'shipped/echo.json', raw: echoShipped, when: echoEnabled },
];

const PROTOCOLS: readonly Protocol[] = ['claude-sdk', 'codex-appserver', 'opencode', 'pi', 'acp', 'echo'];
const OS_KEYS: readonly Os[] = ['windows', 'linux', 'macos'];
const AUTH_KINDS: readonly ProviderAuth['kind'][] = ['oauth-cli', 'api-key', 'none'];
const CANDIDATE_KINDS: readonly ExecutableCandidate['kind'][] = ['path', 'file', 'registry', 'acp-registry'];
const CAPABILITY_KEYS: readonly (keyof ProviderCapabilities)[] = [
  'approvals',
  'hooks',
  'checkpoint',
  'images',
  'planMode',
  'resume',
];

const DESCRIPTOR_KEYS = [
  'id',
  'schemaVersion',
  'name',
  'shortName',
  'protocol',
  'roots',
  'profiles',
  'auth',
  'login',
  'models',
  'capabilities',
] as const;

export interface LoadedProvider {
  descriptor: ProviderDescriptor;
  source: 'shipped' | 'user';
  file: string;
}

export interface ProviderLoadResult {
  loaded: ProviderSummary[];
  rejected: ProviderRejected[];
}

class Rejection extends Error {
  constructor(readonly rejected: ProviderRejected) {
    super(rejected.message);
    this.name = 'ProviderRejection';
  }
}

function reject(file: string, field: string, expected: string, message: string): never {
  throw new Rejection({ file, field, expected, message });
}

function asObject(value: unknown, file: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(file, field, 'an object', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, file: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    reject(file, field, 'a non-empty string', `${field} must be a non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') reject(file, field, 'a boolean', `${field} must be a boolean`);
  return value;
}

function asArray(value: unknown, file: string, field: string): unknown[] {
  if (!Array.isArray(value)) reject(file, field, 'an array', `${field} must be an array`);
  return value;
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const field = path === '' ? key : `${path}.${key}`;
    reject(file, field, `one of: ${allowed.join(', ')}`, `unknown field ${field}`);
  }
}

function checkRoots(value: unknown, file: string): string[] {
  const raw = asArray(value, file, 'roots');
  const roots: string[] = [];
  raw.forEach((entry, index) => {
    const root = asString(entry, file, `roots[${index}]`);
    for (const segment of root.split(/[\\/]/)) {
      if (segment === '..') {
        reject(file, `roots[${index}]`, 'a path with no ".." segment', `roots[${index}] escapes its root: ${root}`);
      }
    }
    roots.push(root);
  });
  return roots;
}

function checkCandidate(value: unknown, file: string, field: string): ExecutableCandidate {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['kind', 'value'], file, field);
  const kind = asString(obj['kind'], file, `${field}.kind`);
  if (!CANDIDATE_KINDS.includes(kind as ExecutableCandidate['kind'])) {
    reject(file, `${field}.kind`, `one of: ${CANDIDATE_KINDS.join(', ')}`, `unknown candidate kind ${kind}`);
  }
  return { kind: kind as ExecutableCandidate['kind'], value: asString(obj['value'], file, `${field}.value`) };
}

function checkStringMap(value: unknown, file: string, field: string): Record<string, string> {
  const obj = asObject(value, file, field);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj)) out[key] = asString(entry, file, `${field}.${key}`);
  return out;
}

function checkProfile(value: unknown, file: string, field: string): OsProfile {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['detect', 'executable', 'launch', 'isolation', 'close'], file, field);

  const detectRaw = asObject(obj['detect'] ?? {}, file, `${field}.detect`);
  checkKeys(detectRaw, ['command', 'file'], file, `${field}.detect`);
  const detect: OsProfile['detect'] = {};
  if (detectRaw['command'] !== undefined) detect.command = asString(detectRaw['command'], file, `${field}.detect.command`);
  if (detectRaw['file'] !== undefined) detect.file = asString(detectRaw['file'], file, `${field}.detect.file`);

  const executable = asArray(obj['executable'] ?? [], file, `${field}.executable`).map((entry, index) =>
    checkCandidate(entry, file, `${field}.executable[${index}]`),
  );

  const profile: OsProfile = {
    detect,
    executable,
    isolation: checkStringMap(obj['isolation'] ?? {}, file, `${field}.isolation`),
  };

  if (obj['launch'] !== undefined) {
    const launch = asObject(obj['launch'], file, `${field}.launch`);
    checkKeys(launch, ['args'], file, `${field}.launch`);
    const args = asArray(launch['args'] ?? [], file, `${field}.launch.args`).map((entry, index) =>
      asString(entry, file, `${field}.launch.args[${index}]`),
    );
    profile.launch = { args };
  }

  if (obj['close'] !== undefined) {
    const close = asObject(obj['close'], file, `${field}.close`);
    checkKeys(close, ['processes'], file, `${field}.close`);
    const processes = asArray(close['processes'] ?? [], file, `${field}.close.processes`).map((entry, index) =>
      asString(entry, file, `${field}.close.processes[${index}]`),
    );
    profile.close = { processes };
  }

  return profile;
}

function checkAuth(value: unknown, file: string): ProviderAuth {
  const obj = asObject(value, file, 'auth');
  checkKeys(obj, ['kind', 'session', 'identity'], file, 'auth');
  const kind = asString(obj['kind'], file, 'auth.kind');
  if (!AUTH_KINDS.includes(kind as ProviderAuth['kind'])) {
    reject(file, 'auth.kind', `one of: ${AUTH_KINDS.join(', ')}`, `unknown auth kind ${kind}`);
  }
  const auth: ProviderAuth = { kind: kind as ProviderAuth['kind'] };
  if (obj['session'] !== undefined) {
    auth.session = asArray(obj['session'], file, 'auth.session').map((entry, index) =>
      asString(entry, file, `auth.session[${index}]`),
    );
  }
  if (obj['identity'] !== undefined) {
    const identity = asObject(obj['identity'], file, 'auth.identity');
    checkKeys(identity, ['source', 'format'], file, 'auth.identity');
    const source = asObject(identity['source'], file, 'auth.identity.source');
    if (source['command'] !== undefined) {
      checkKeys(source, ['command'], file, 'auth.identity.source');
      const command = asArray(source['command'], file, 'auth.identity.source.command').map((entry, index) =>
        asString(entry, file, `auth.identity.source.command[${index}]`),
      );
      auth.identity = { source: { command }, format: asString(identity['format'], file, 'auth.identity.format') };
    } else {
      checkKeys(source, ['file', 'field'], file, 'auth.identity.source');
      auth.identity = {
        source: {
          file: asString(source['file'], file, 'auth.identity.source.file'),
          field: asString(source['field'], file, 'auth.identity.source.field'),
        },
        format: asString(identity['format'], file, 'auth.identity.format'),
      };
    }
  }
  return auth;
}

/** The provider's login command: a non-empty argv of strings, plus optional environment. */
function checkLogin(value: unknown, file: string): ProviderLogin {
  const obj = asObject(value, file, 'login');
  checkKeys(obj, ['command', 'env'], file, 'login');
  const raw = asArray(obj['command'], file, 'login.command');
  if (raw.length === 0) {
    reject(file, 'login.command', 'at least one argument', 'login.command must name an executable');
  }
  const login: ProviderLogin = {
    command: raw.map((entry, index) => asString(entry, file, `login.command[${index}]`)),
  };
  if (obj['env'] !== undefined) login.env = checkStringMap(obj['env'], file, 'login.env');
  return login;
}

/** Reasoning effort: a non-empty scale of uniquely named levels, one of them the default. */
function checkEffort(value: unknown, file: string, field: string): { levels: EffortLevel[]; default: string } {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['levels', 'default'], file, field);

  const raw = asArray(obj['levels'], file, `${field}.levels`);
  if (raw.length === 0) {
    reject(file, `${field}.levels`, 'at least one level', `${field}.levels must list at least one level`);
  }
  const seen = new Set<string>();
  const levels = raw.map((entry, index) => {
    const levelField = `${field}.levels[${index}]`;
    const level = asObject(entry, file, levelField);
    checkKeys(level, ['id', 'label', 'description'], file, levelField);
    const id = asString(level['id'], file, `${levelField}.id`);
    if (seen.has(id)) {
      reject(file, `${levelField}.id`, 'an id no other level uses', `the effort level ${id} is listed twice`);
    }
    seen.add(id);
    const out: EffortLevel = { id, label: asString(level['label'], file, `${levelField}.label`) };
    if (level['description'] !== undefined) {
      out.description = asString(level['description'], file, `${levelField}.description`);
    }
    return out;
  });

  const fallback = asString(obj['default'], file, `${field}.default`);
  if (!seen.has(fallback)) {
    reject(
      file,
      `${field}.default`,
      `one of: ${[...seen].join(', ')}`,
      `${field}.default names ${fallback}, which is not one of the levels`,
    );
  }
  return { levels, default: fallback };
}

function checkModels(value: unknown, file: string): ModelInfo[] {
  const raw = asArray(value, file, 'models');
  if (raw.length === 0) reject(file, 'models', 'at least one model', 'models must list at least one model');
  return raw.map((entry, index) => {
    const obj = asObject(entry, file, `models[${index}]`);
    checkKeys(obj, ['id', 'name', 'default', 'legacy', 'badge', 'effort'], file, `models[${index}]`);
    const model: ModelInfo = {
      id: asString(obj['id'], file, `models[${index}].id`),
      name: asString(obj['name'], file, `models[${index}].name`),
    };
    if (obj['default'] !== undefined) model.default = asBoolean(obj['default'], file, `models[${index}].default`);
    if (obj['legacy'] !== undefined) model.legacy = asBoolean(obj['legacy'], file, `models[${index}].legacy`);
    if (obj['badge'] !== undefined) {
      const badge = asString(obj['badge'], file, `models[${index}].badge`);
      if (badge !== 'new') reject(file, `models[${index}].badge`, '"new"', `unknown badge ${badge}`);
      model.badge = 'new';
    }
    if (obj['effort'] !== undefined) model.effort = checkEffort(obj['effort'], file, `models[${index}].effort`);
    return model;
  });
}

function checkCapabilities(value: unknown, file: string): ProviderCapabilities {
  const obj = asObject(value, file, 'capabilities');
  checkKeys(obj, CAPABILITY_KEYS, file, 'capabilities');
  return {
    approvals: asBoolean(obj['approvals'], file, 'capabilities.approvals'),
    hooks: asBoolean(obj['hooks'], file, 'capabilities.hooks'),
    checkpoint: asBoolean(obj['checkpoint'], file, 'capabilities.checkpoint'),
    images: asBoolean(obj['images'], file, 'capabilities.images'),
    planMode: asBoolean(obj['planMode'], file, 'capabilities.planMode'),
    resume: asBoolean(obj['resume'], file, 'capabilities.resume'),
  };
}

/** `{home}` and `{appdata}`, the two locations a descriptor may name at load time. */
function substituteHome(value: string): string {
  let out = value;
  if (out.includes('{home}')) out = out.split('{home}').join(homePath());
  if (out.includes('{appdata}')) out = out.split('{appdata}').join(appDataPath());
  return out;
}

/** Load-time tokens. `{isolationDir}` is not one of them: it is per account, substituted at spawn. */
function substitutePaths(value: string): string {
  return substituteHome(value).split('{shippedDir}').join(SHIPPED_DIR);
}

function expandDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  const profiles: ProviderDescriptor['profiles'] = {};
  for (const os of OS_KEYS) {
    const profile = descriptor.profiles[os];
    if (profile === undefined) continue;
    profiles[os] = {
      ...profile,
      executable: profile.executable.map((candidate) => ({
        kind: candidate.kind,
        value: candidate.kind === 'file' ? normalize(substituteHome(candidate.value)) : substituteHome(candidate.value),
      })),
    };
  }
  const expanded: ProviderDescriptor = { ...descriptor, roots: descriptor.roots.map(substituteHome), profiles };
  if (descriptor.login !== undefined) {
    expanded.login = { ...descriptor.login, command: descriptor.login.command.map(substitutePaths) };
  }
  return expanded;
}

export function validateDescriptor(raw: unknown, file: string, forbiddenIds: ReadonlySet<string>): ProviderDescriptor {
  const obj = asObject(raw, file, 'descriptor');
  checkRoots(obj['roots'], file);
  checkKeys(obj, DESCRIPTOR_KEYS, file, '');

  const id = asString(obj['id'], file, 'id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    reject(file, 'id', 'lowercase letters, digits and dashes', `id ${id} is not a valid provider id`);
  }
  if (forbiddenIds.has(id)) {
    reject(file, 'id', 'an id no shipped provider already uses', `a shipped provider already owns the id ${id}`);
  }
  if (obj['schemaVersion'] !== 1) {
    reject(file, 'schemaVersion', 'the number 1', 'schemaVersion must be 1');
  }
  const protocol = asString(obj['protocol'], file, 'protocol');
  if (!PROTOCOLS.includes(protocol as Protocol)) {
    reject(file, 'protocol', `one of: ${PROTOCOLS.join(', ')}`, `unknown protocol ${protocol}`);
  }

  const profilesRaw = asObject(obj['profiles'], file, 'profiles');
  checkKeys(profilesRaw, OS_KEYS, file, 'profiles');
  const profiles: ProviderDescriptor['profiles'] = {};
  for (const os of OS_KEYS) {
    if (profilesRaw[os] === undefined) continue;
    profiles[os] = checkProfile(profilesRaw[os], file, `profiles.${os}`);
  }
  if (Object.keys(profiles).length === 0) {
    reject(file, 'profiles', 'at least one of: windows, linux, macos', 'profiles must describe at least one OS');
  }

  return expandDescriptor({
    id,
    schemaVersion: 1,
    name: asString(obj['name'], file, 'name'),
    shortName: asString(obj['shortName'], file, 'shortName'),
    protocol: protocol as Protocol,
    roots: checkRoots(obj['roots'], file),
    profiles,
    auth: checkAuth(obj['auth'], file),
    ...(obj['login'] === undefined ? {} : { login: checkLogin(obj['login'], file) }),
    models: checkModels(obj['models'], file),
    capabilities: checkCapabilities(obj['capabilities'], file),
  });
}

/** The same lookup `ProviderSummary.executable` reports, for a driver that needs the path. */
export function resolveExecutable(profile: OsProfile): string | null {
  for (const candidate of profile.executable) {
    if (candidate.kind === 'path') {
      const found = Bun.which(candidate.value);
      if (found !== null) return found;
    } else if (candidate.kind === 'file') {
      if (existsSync(candidate.value)) return candidate.value;
    }
    // 'registry' and 'acp-registry' resolve in a later wave.
  }
  return null;
}

function detectResolves(profile: OsProfile): boolean {
  if (profile.detect.file !== undefined && !existsSync(substituteHome(profile.detect.file))) return false;
  if (profile.detect.command !== undefined && Bun.which(profile.detect.command) === null) return false;
  return true;
}

export function profileFor(descriptor: ProviderDescriptor, os: Os = currentOs()): OsProfile | undefined {
  return descriptor.profiles[os];
}

export function summarize(entry: LoadedProvider): ProviderSummary {
  const profile = profileFor(entry.descriptor);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  const available =
    profile !== undefined &&
    detectResolves(profile) &&
    (profile.executable.length === 0 || executable !== null);
  return {
    id: entry.descriptor.id,
    name: entry.descriptor.name,
    shortName: entry.descriptor.shortName,
    protocol: entry.descriptor.protocol,
    source: entry.source,
    available,
    executable,
    models: entry.descriptor.models,
    capabilities: entry.descriptor.capabilities,
  };
}

export class ProviderRegistry {
  private entries = new Map<ProviderId, LoadedProvider>();
  private rejected: ProviderRejected[] = [];

  constructor(private readonly dataDir: string) {
    this.load();
  }

  load(): ProviderLoadResult {
    const entries = new Map<ProviderId, LoadedProvider>();
    const rejected: ProviderRejected[] = [];

    for (const shipped of SHIPPED_SOURCES) {
      if (shipped.when !== undefined && !shipped.when()) continue;
      try {
        const descriptor = validateDescriptor(shipped.raw, shipped.file, new Set());
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
        const descriptor = validateDescriptor(raw, file, shippedIds);
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
      loaded: [...this.entries.values()].map(summarize),
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
    return entry === undefined ? undefined : summarize(entry);
  }

  available(): ProviderSummary[] {
    return this.list().loaded.filter((provider) => provider.available);
  }

  dryRun(file: string): RpcResult<'providers.dryRun'> {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const shippedIds = new Set(
        [...this.entries.values()].filter((entry) => entry.source === 'shipped').map((entry) => entry.descriptor.id),
      );
      const descriptor = validateDescriptor(raw, file, shippedIds);
      const entry: LoadedProvider = { descriptor, source: 'user', file };
      const profile = profileFor(descriptor);
      return {
        ok: true,
        summary: summarize(entry),
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
  core.router.register('providers.list', () => core.providers.list());
  core.router.register('providers.reload', () => {
    const result = core.providers.load();
    core.bus.emit('providers.updated', result);
    return result;
  });
  core.router.register('providers.dryRun', (params) => core.providers.dryRun(params.file));
}
