import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
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
  ProviderInstall,
  ProviderSelfUpdate,
  ProviderIsolation,
  ProviderLogin,
  ProviderQuirk,
  ProviderRejected,
  ProviderSummary,
  RpcResult,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { agentsDirPath, appDataPath, browserNoopPath, currentOs, homePath } from '../paths.ts';
import { InstallManager } from './install.ts';
import { isNpmSpec, resolveNpm } from './npm.ts';
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

/**
 * Where the shipped descriptors and the scripts they name live. A login command
 * writes `{shippedDir}/<script>` instead of a path nobody could write by hand.
 * Only echo uses it, and echo ships from the sources alone (`BOITE_ECHO=1`); a
 * command whose script is missing fails at spawn, with the path in the event.
 */
const SHIPPED_DIR = join(import.meta.dir, 'shipped');

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

const PROTOCOLS: readonly Protocol[] = ['claude-sdk', 'codex-appserver', 'muse', 'pi', 'acp', 'agy', 'echo'];
const OS_KEYS: readonly Os[] = ['windows', 'linux', 'macos'];
const AUTH_KINDS: readonly ProviderAuth['kind'][] = ['oauth-cli', 'api-key', 'none'];
const CANDIDATE_KINDS: readonly ExecutableCandidate['kind'][] = ['path', 'file', 'npm'];
const QUIRKS: readonly ProviderQuirk[] = ['antigravity', 'grok'];
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
  'isolation',
  'seedFiles',
  'quirks',
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

function asPositiveInteger(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    reject(file, field, 'a positive whole number of bytes', `${field} must be a positive whole number`);
  }
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
  checkKeys(obj, ['kind', 'value', 'updateEnv'], file, field);
  const kind = asString(obj['kind'], file, `${field}.kind`);
  if (!CANDIDATE_KINDS.includes(kind as ExecutableCandidate['kind'])) {
    reject(file, `${field}.kind`, `one of: ${CANDIDATE_KINDS.join(', ')}`, `unknown candidate kind ${kind}`);
  }
  const candidateValue = asString(obj['value'], file, `${field}.value`);
  if (kind === 'npm' && !isNpmSpec(candidateValue)) {
    reject(file, `${field}.value`, 'an npm package name, @scope/name, with an optional #bin', `${candidateValue} is not an npm package name`);
  }
  const candidate: ExecutableCandidate = { kind: kind as ExecutableCandidate['kind'], value: candidateValue };
  if (obj['updateEnv'] !== undefined) candidate.updateEnv = checkStringMap(obj['updateEnv'], file, `${field}.updateEnv`);
  return candidate;
}

function checkStringMap(value: unknown, file: string, field: string): Record<string, string> {
  const obj = asObject(value, file, field);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj)) out[key] = asString(entry, file, `${field}.${key}`);
  return out;
}

/**
 * A release Boite downloads itself: the archive, what it hashes to, and every
 * file that has to come out of it with its exact size. The first file is the
 * executable, and nothing outside the list is kept.
 */
function checkInstall(value: unknown, file: string, field: string): ProviderInstall {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['version', 'url', 'sha256', 'archiveBytes', 'files', 'arch', 'format'], file, field);
  const arch = obj['arch'];
  if (arch !== undefined && arch !== 'x64' && arch !== 'arm64') {
    reject(file, `${field}.arch`, 'x64 or arm64', `${field}.arch must be x64 or arm64`);
  }
  const format = obj['format'];
  if (format !== undefined && format !== 'zip' && format !== 'binary') {
    reject(file, `${field}.format`, 'zip or binary', `${field}.format must be zip or binary`);
  }

  const url = asString(obj['url'], file, `${field}.url`);
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    reject(file, `${field}.url`, 'an http or https url', `${field}.url must be an http or https url`);
  }
  const sha256 = asString(obj['sha256'], file, `${field}.sha256`);
  if (!/^[a-fA-F0-9]{64}$/.test(sha256)) {
    reject(file, `${field}.sha256`, '64 hexadecimal characters', `${field}.sha256 is not a sha256 digest`);
  }
  const archiveBytes = asPositiveInteger(obj['archiveBytes'], file, `${field}.archiveBytes`);

  const rawFiles = asArray(obj['files'], file, `${field}.files`);
  if (rawFiles.length === 0) {
    reject(file, `${field}.files`, 'at least one file', `${field}.files must name the executable at least`);
  }
  const files = rawFiles.map((entry, index) => {
    const entryField = `${field}.files[${index}]`;
    const item = asObject(entry, file, entryField);
    checkKeys(item, ['path', 'bytes', 'executable'], file, entryField);
    const path = asString(item['path'], file, `${entryField}.path`);
    for (const segment of path.split(/[\\/]/)) {
      if (segment !== '..') continue;
      reject(file, `${entryField}.path`, 'a path with no ".." segment', `${entryField}.path escapes the release: ${path}`);
    }
    if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
      reject(file, `${entryField}.path`, 'a relative path inside the archive', `${entryField}.path must be relative: ${path}`);
    }
    return { path, bytes: asPositiveInteger(item['bytes'], file, `${entryField}.bytes`),
      ...(item['executable'] === undefined ? {} : { executable: asBoolean(item['executable'], file, `${entryField}.executable`) }) };
  });

  if (format === 'binary' && (files.length !== 1 || files[0]?.bytes !== archiveBytes)) {
    reject(file, `${field}.files`, 'one file whose bytes equal archiveBytes', `${field}.files must describe the downloaded binary`);
  }
  // The version names a directory the installer deletes on failure, so it is one plain path segment.
  const version = asString(obj['version'], file, `${field}.version`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) {
    reject(file, `${field}.version`, 'letters, digits and . _ + -, starting with a letter or digit', `${field}.version is not a plain version: ${version}`);
  }
  return { version, url, sha256, archiveBytes, files,
    ...(arch === undefined ? {} : { arch: arch as 'x64' | 'arm64' }),
    ...(format === 'zip' || format === 'binary' ? { format } : {}) };
}

function checkUpdate(value: unknown, file: string, field: string): ProviderSelfUpdate {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['versionArgs', 'latestNpm', 'latestArgs', 'args'], file, field);
  const strings = (key: string): string[] =>
    asArray(obj[key], file, `${field}.${key}`).map((entry, index) => asString(entry, file, `${field}.${key}[${index}]`));
  const update: ProviderSelfUpdate = { args: strings('args') };
  if (update.args.length === 0) {
    reject(file, `${field}.args`, "the updater's arguments, such as [\"update\"]", `${field}.args must name at least one argument`);
  }
  if (obj['versionArgs'] !== undefined) update.versionArgs = strings('versionArgs');
  if (obj['latestArgs'] !== undefined) update.latestArgs = strings('latestArgs');
  if (obj['latestNpm'] !== undefined) {
    const name = asString(obj['latestNpm'], file, `${field}.latestNpm`);
    // The name goes in a registry URL, so it is a package name and nothing else.
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      reject(file, `${field}.latestNpm`, 'an npm package name, such as @scope/name', `${name} is not an npm package name`);
    }
    update.latestNpm = name;
  }
  if (update.latestNpm !== undefined && update.latestArgs !== undefined) {
    reject(file, field, 'latestNpm or latestArgs, not both', `${field} names two sources for the newest version`);
  }
  return update;
}

function checkProfile(value: unknown, file: string, field: string): OsProfile {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['detect', 'executable', 'launch', 'install', 'update', 'isolation', 'env', 'unsetEnv', 'close'], file, field);

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

  if (obj['env'] !== undefined) profile.env = checkStringMap(obj['env'], file, `${field}.env`);

  if (obj['unsetEnv'] !== undefined) {
    profile.unsetEnv = asArray(obj['unsetEnv'], file, `${field}.unsetEnv`).map((entry, index) =>
      asString(entry, file, `${field}.unsetEnv[${index}]`),
    );
  }

  if (obj['install'] !== undefined) profile.install = checkInstall(obj['install'], file, `${field}.install`);
  if (obj['update'] !== undefined) profile.update = checkUpdate(obj['update'], file, `${field}.update`);

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

/**
 * The provider's login: either a non-empty argv with optional environment, or
 * the protocol's own `authenticate` call. Exactly one of the two, because a
 * descriptor that named both would leave the core picking on its own.
 */
function checkLogin(value: unknown, file: string): ProviderLogin {
  const obj = asObject(value, file, 'login');
  checkKeys(obj, ['command', 'env', 'acp', 'terminal'], file, 'login');
  const hasCommand = obj['command'] !== undefined;
  const hasAcp = obj['acp'] !== undefined;
  if (hasCommand === hasAcp) {
    reject(
      file,
      'login',
      'exactly one of: command, acp',
      hasCommand ? 'login names both a command and an acp method' : 'login names neither a command nor an acp method',
    );
  }

  const login: ProviderLogin = {};
  if (hasCommand) {
    const raw = asArray(obj['command'], file, 'login.command');
    if (raw.length === 0) {
      reject(file, 'login.command', 'at least one argument', 'login.command must name an executable');
    }
    login.command = raw.map((entry, index) => asString(entry, file, `login.command[${index}]`));
  }
  if (hasAcp) {
    const acp = asObject(obj['acp'], file, 'login.acp');
    checkKeys(acp, ['methodId'], file, 'login.acp');
    login.acp = { methodId: asString(acp['methodId'], file, 'login.acp.methodId') };
  }
  if (obj['env'] !== undefined) login.env = checkStringMap(obj['env'], file, 'login.env');
  if (obj['terminal'] !== undefined) {
    if (!hasCommand) reject(file, 'login.terminal', 'a login with a command', 'login.terminal types a command, and this login has none');
    login.terminal = asBoolean(obj['terminal'], file, 'login.terminal');
  }
  return login;
}

/** Isolation policy for every account of the provider, whatever the OS profile does. */
function checkIsolation(value: unknown, file: string): ProviderIsolation {
  const obj = asObject(value, file, 'isolation');
  checkKeys(obj, ['alwaysIsolated'], file, 'isolation');
  return { alwaysIsolated: asBoolean(obj['alwaysIsolated'], file, 'isolation.alwaysIsolated') };
}

/**
 * Files the core writes under an account's isolation directory before the agent
 * runs. A path that climbs out of that directory is refused by name, the same
 * way an archive member is.
 */
function checkSeedFiles(value: unknown, file: string): Record<string, string> {
  const obj = asObject(value, file, 'seedFiles');
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(obj)) {
    const field = `seedFiles.${path}`;
    if (path.length === 0) reject(file, 'seedFiles', 'a non-empty relative path', 'a seed file has no path');
    if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
      reject(file, field, 'a relative path inside the isolation directory', `${field} must be relative: ${path}`);
    }
    for (const segment of path.split(/[\\/]/)) {
      if (segment !== '..') continue;
      reject(file, field, 'a path with no ".." segment', `${field} escapes the isolation directory: ${path}`);
    }
    if (typeof content !== 'string') reject(file, field, 'a string of file content', `${field} must be a string`);
    out[path] = content;
  }
  return out;
}

/** Dialect fixes, each one a name the core knows how to apply. */
function checkQuirks(value: unknown, file: string): ProviderQuirk[] {
  return asArray(value, file, 'quirks').map((entry, index) => {
    const quirk = asString(entry, file, `quirks[${index}]`);
    if (!QUIRKS.includes(quirk as ProviderQuirk)) {
      reject(file, `quirks[${index}]`, `one of: ${QUIRKS.join(', ')}`, `unknown quirk ${quirk}`);
    }
    return quirk as ProviderQuirk;
  });
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

/**
 * `{home}`, `{appdata}` and `{agentsDir}`, the three locations a descriptor may
 * name at load time. The last one is where a managed install puts its files, so
 * it needs the data directory and the provider's own id.
 */
function substituteHome(value: string, agentsDir: string, dataDir: string): string {
  let out = value;
  if (out.includes('{home}')) out = out.split('{home}').join(homePath());
  if (out.includes('{appdata}')) out = out.split('{appdata}').join(appDataPath());
  if (out.includes('{agentsDir}')) out = out.split('{agentsDir}').join(agentsDir);
  if (out.includes('{browserNoop}')) out = out.split('{browserNoop}').join(browserNoopPath(dataDir));
  return out;
}

/** Load-time tokens. `{isolationDir}` is not one of them: it is per account, substituted at spawn. */
function substitutePaths(value: string, agentsDir: string, dataDir: string): string {
  return substituteHome(value, agentsDir, dataDir).split('{shippedDir}').join(SHIPPED_DIR);
}

function expandDescriptor(descriptor: ProviderDescriptor, dataDir: string): ProviderDescriptor {
  const agentsDir = agentsDirPath(dataDir, descriptor.id);
  const expand = (value: string): string => substituteHome(value, agentsDir, dataDir);
  const expandMap = (map: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) out[key] = expand(value);
    return out;
  };
  const profiles: ProviderDescriptor['profiles'] = {};
  for (const os of OS_KEYS) {
    const profile = descriptor.profiles[os];
    if (profile === undefined) continue;
    profiles[os] = {
      ...profile,
      executable: profile.executable.map((candidate) => ({
        ...candidate,
        value: candidate.kind === 'file' ? normalize(expand(candidate.value)) : expand(candidate.value),
      })),
      // A launch argument can name a path like an executable candidate does,
      // so it takes the same tokens.
      ...(profile.launch === undefined ? {} : { launch: { args: (profile.launch.args ?? []).map(expand) } }),
      // The fixed environment names the harness beside the executable and the
      // browser launcher under the data directory, so it takes the same tokens.
      ...(profile.env === undefined ? {} : { env: expandMap(profile.env) }),
    };
  }
  const expanded: ProviderDescriptor = {
    ...descriptor,
    roots: descriptor.roots.map(expand),
    profiles,
  };
  if (descriptor.login?.command !== undefined) {
    expanded.login = {
      ...descriptor.login,
      command: descriptor.login.command.map((arg) => substitutePaths(arg, agentsDir, dataDir)),
    };
  }
  return expanded;
}

/**
 * The environment a process of this provider runs under: what it inherited,
 * minus the names the profile unsets, plus the account's own. `unsetEnv` is
 * matched without case, because Windows treats a variable name that way and an
 * alias would otherwise slip through.
 */
/** How a client starts this provider's login, if it can. */
function loginSummary(login: ProviderLogin | undefined): ProviderSummary['login'] {
  if (login === undefined) return false;
  if (login.acp !== undefined) return { kind: 'acp' };
  return { kind: login.terminal === true ? 'terminal' : 'command' };
}

export function agentEnv(
  descriptor: ProviderDescriptor,
  accountEnv: Record<string, string>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const unset = new Set((profileFor(descriptor)?.unsetEnv ?? []).map((name) => name.toUpperCase()));
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (unset.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return { ...env, ...accountEnv };
}

export function validateDescriptor(
  raw: unknown,
  file: string,
  forbiddenIds: ReadonlySet<string>,
  dataDir: string,
): ProviderDescriptor {
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
    // Only these drivers launch the program with the descriptor's arguments after
    // it, which is what `node <script>` needs; the SDK and app-server drivers do not.
    if (protocol !== 'pi' && protocol !== 'acp') {
      profiles[os]!.executable.forEach((candidate, index) => {
        if (candidate.kind === 'npm') {
          reject(file, `profiles.${os}.executable[${index}].kind`, 'path or file for this protocol', `an npm candidate needs the pi or acp protocol, not ${protocol}`);
        }
      });
    }
  }
  if (Object.keys(profiles).length === 0) {
    reject(file, 'profiles', 'at least one of: windows, linux, macos', 'profiles must describe at least one OS');
  }

  return expandDescriptor(
    {
      id,
      schemaVersion: 1,
      name: asString(obj['name'], file, 'name'),
      shortName: asString(obj['shortName'], file, 'shortName'),
      protocol: protocol as Protocol,
      roots: checkRoots(obj['roots'], file),
      profiles,
      auth: checkAuth(obj['auth'], file),
      ...(obj['login'] === undefined ? {} : { login: checkLogin(obj['login'], file) }),
      ...(obj['isolation'] === undefined ? {} : { isolation: checkIsolation(obj['isolation'], file) }),
      ...(obj['seedFiles'] === undefined ? {} : { seedFiles: checkSeedFiles(obj['seedFiles'], file) }),
      ...(obj['quirks'] === undefined ? {} : { quirks: checkQuirks(obj['quirks'], file) }),
      models: checkModels(obj['models'], file),
      capabilities: checkCapabilities(obj['capabilities'], file),
    },
    dataDir,
  );
}

/**
 * What a profile launches: the program, the arguments that belong to it before
 * the descriptor's own (the bin script, for an `npm` candidate), and the path a
 * person recognises as the agent, which for a script is the script, not Node.
 */
export interface ResolvedCommand {
  executable: string;
  prefix: string[];
  shown: string;
  /** The candidate's `updateEnv`, empty when it names none. */
  updateEnv: Record<string, string>;
}

export function resolveCommand(profile: OsProfile): ResolvedCommand | null {
  for (const candidate of profile.executable) {
    const updateEnv = candidate.updateEnv ?? {};
    if (candidate.kind === 'path') {
      const found = Bun.which(candidate.value);
      if (found !== null) return { executable: found, prefix: [], shown: found, updateEnv };
    } else if (candidate.kind === 'file') {
      try {
        if (!statSync(candidate.value).isFile()) continue;
        accessSync(candidate.value, constants.X_OK);
        return { executable: candidate.value, prefix: [], shown: candidate.value, updateEnv };
      } catch { /* Missing or non-executable candidates leave the next one available. */ }
    } else if (candidate.kind === 'npm') {
      const found = resolveNpm(candidate.value);
      if (found !== null) return { executable: found.executable, prefix: [found.script], shown: found.script, updateEnv };
    }
  }
  return null;
}

/** The program to spawn, for a driver that needs the path. Its arguments start with `launchPrefix`. */
export function resolveExecutable(profile: OsProfile): string | null {
  return resolveCommand(profile)?.executable ?? null;
}

/** The descriptor's launch arguments behind whatever the resolved program needs first. */
export function launchPrefix(profile: OsProfile | undefined): string[] {
  return profile === undefined ? [] : (resolveCommand(profile)?.prefix ?? []);
}

function detectResolves(profile: OsProfile, agentsDir: string, dataDir: string): boolean {
  if (profile.detect.file !== undefined && !existsSync(substituteHome(profile.detect.file, agentsDir, dataDir))) {
    return false;
  }
  if (profile.detect.command !== undefined && Bun.which(profile.detect.command) === null) return false;
  return true;
}

export function profileFor(descriptor: ProviderDescriptor, os: Os = currentOs()): OsProfile | undefined {
  return descriptor.profiles[os];
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
    const entries = new Map<ProviderId, LoadedProvider>();
    const rejected: ProviderRejected[] = [];

    for (const shipped of SHIPPED_SOURCES) {
      if (shipped.when !== undefined && !shipped.when()) continue;
      try {
        const descriptor = validateDescriptor(shipped.raw, shipped.file, new Set(), this.dataDir);
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
  core.router.register('providers.reload', () => {
    const result = core.providers.load();
    core.accounts.ensureDefaults();
    core.bus.emit('providers.updated', result);
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
