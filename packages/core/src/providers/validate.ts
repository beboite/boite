import type {
  EffortLevel,
  ExecutableCandidate,
  ModelInfo,
  OsProfile,
  Protocol,
  ProviderAuth,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderHookSource,
  ProviderInstall,
  ProviderSelfUpdate,
  ProviderIsolation,
  ProviderLogin,
  ProviderQuirk,
  ProviderRejected,
  ProviderShare,
  ProviderSharedKeys,
} from '@boite/contracts';
import { expandDescriptor, OS_KEYS } from './expand.ts';
import { isNpmSpec } from './npm.ts';
import { NPM_ROOT } from './resolve.ts';

const PROTOCOLS: readonly Protocol[] = ['claude-sdk', 'codex-appserver', 'muse', 'pi', 'acp', 'agy', 'echo'];
const AUTH_KINDS: readonly ProviderAuth['kind'][] = ['oauth-cli', 'api-key', 'none'];
const CANDIDATE_KINDS: readonly ExecutableCandidate['kind'][] = ['path', 'file', 'npm'];
const QUIRKS: readonly ProviderQuirk[] = ['antigravity', 'grok'];
const HOOK_FORMATS: readonly ProviderHookSource['format'][] = ['events', 'modules'];
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
  'shared',
  'sharedKeys',
  'hookSources',
  'quirks',
  'experimental',
  'models',
  'capabilities',
] as const;

/** Thrown with the file, the field and what was expected, so a caller can tell a refusal from any other error. */
export class Rejection extends Error {
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
  checkKeys(obj, ['kind', 'value', 'updateEnv', 'major'], file, field);
  const kind = asString(obj['kind'], file, `${field}.kind`);
  if (!CANDIDATE_KINDS.includes(kind as ExecutableCandidate['kind'])) {
    reject(file, `${field}.kind`, `one of: ${CANDIDATE_KINDS.join(', ')}`, `unknown candidate kind ${kind}`);
  }
  const candidateValue = asString(obj['value'], file, `${field}.value`);
  if (kind === 'npm' && !isNpmSpec(candidateValue)) {
    reject(file, `${field}.value`, 'an npm package name, @scope/name, with an optional #bin', `${candidateValue} is not an npm package name`);
  }
  if (candidateValue.includes(NPM_ROOT) && (kind !== 'file' || !/^{npmRoot}[\/]/.test(candidateValue))) {
    reject(file, `${field}.value`, `${NPM_ROOT} only at the start of a file candidate, followed by a separator`, `${candidateValue} places ${NPM_ROOT} where it cannot expand`);
  }
  const candidate: ExecutableCandidate = { kind: kind as ExecutableCandidate['kind'], value: candidateValue };
  if (obj['updateEnv'] !== undefined) candidate.updateEnv = checkStringMap(obj['updateEnv'], file, `${field}.updateEnv`);
  if (obj['major'] !== undefined) {
    // An npm candidate is already one package, and its program is `node`: there is no version to ask it.
    if (kind === 'npm') reject(file, `${field}.major`, 'a path or file candidate', 'an npm candidate names its package and takes no major');
    candidate.major = asPositiveInteger(obj['major'], file, `${field}.major`);
  }
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
  checkKeys(obj, ['detect', 'executable', 'launch', 'install', 'update', 'isolation', 'env', 'unsetEnv', 'session', 'close'], file, field);

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

  if (obj['session'] !== undefined) {
    profile.session = asArray(obj['session'], file, `${field}.session`).map((entry, index) =>
      asString(entry, file, `${field}.session[${index}]`),
    );
  }

  if (obj['install'] !== undefined) profile.install = checkInstall(obj['install'], file, `${field}.install`);
  if (obj['update'] !== undefined) profile.update = checkUpdate(obj['update'], file, `${field}.update`);

  return profile;
}

function checkAuth(value: unknown, file: string): ProviderAuth {
  const obj = asObject(value, file, 'auth');
  checkKeys(obj, ['kind', 'session', 'sqlite', 'identity'], file, 'auth');
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
  if (obj['sqlite'] !== undefined) {
    const sqlite = asObject(obj['sqlite'], file, 'auth.sqlite');
    checkKeys(sqlite, ['file', 'tables'], file, 'auth.sqlite');
    const tables = asArray(sqlite['tables'], file, 'auth.sqlite.tables').map((entry, index) => {
      const table = asString(entry, file, `auth.sqlite.tables[${index}]`);
      // The name goes into the query as an identifier, so it can be nothing else.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        reject(file, `auth.sqlite.tables[${index}]`, 'a table name of letters, digits and _', `${table} is not a table name`);
      }
      return table;
    });
    if (tables.length === 0) reject(file, 'auth.sqlite.tables', 'at least one table name', 'auth.sqlite.tables is empty');
    auth.sqlite = { file: checkRelative(sqlite['file'], file, 'auth.sqlite.file', 'the isolation directory'), tables };
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

/** A path under some directory: relative, no `..`, written with `/`. */
function checkRelative(value: unknown, file: string, field: string, within: string): string {
  const path = asString(value, file, field);
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
    reject(file, field, `a relative path inside ${within}`, `${field} must be relative: ${path}`);
  }
  for (const segment of path.split(/[\\/]/)) {
    if (segment !== '..' && segment !== '.' && segment !== '') continue;
    reject(file, field, 'a path with no "..", "." or empty segment', `${field} is not a plain path under ${within}: ${path}`);
  }
  return path.split('\\').join('/');
}

/**
 * Where an isolation variable points under `{isolationDir}` on each OS profile
 * that sets it, `''` for the directory itself. Null when no profile sets it.
 */
function isolationPrefixes(profiles: ProviderDescriptor['profiles'], variable: string): string[] | null {
  const prefixes: string[] = [];
  let found = false;
  for (const profile of Object.values(profiles)) {
    const template = profile?.isolation[variable];
    if (template === undefined) continue;
    found = true;
    if (!template.startsWith('{isolationDir}')) continue;
    prefixes.push(template.slice('{isolationDir}'.length).split('\\').join('/').replace(/^\/+|\/+$/g, ''));
  }
  return found ? prefixes : null;
}

function overlaps(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The isolation variable a share writes under, with its prefixes under
 * `{isolationDir}`. A profile that points the variable elsewhere would get the
 * share outside the account's directory, where no login or seed file is checked.
 */
function checkShareVariable(value: unknown, file: string, field: string, profiles: ProviderDescriptor['profiles']): [string, string[]] {
  const variable = asString(value, file, field);
  const prefixes = isolationPrefixes(profiles, variable);
  if (prefixes === null) {
    reject(file, field, 'an isolation variable of one of the profiles', `${field} names ${variable}, which no profile isolates`);
  }
  for (const [os, profile] of Object.entries(profiles)) {
    const template = profile?.isolation[variable];
    if (template === undefined || template.startsWith('{isolationDir}')) continue;
    reject(
      file,
      field,
      `a variable every profile sets under {isolationDir}`,
      `${field} names ${variable}, which the ${os} profile sets to ${template}, outside the account directory`,
    );
  }
  return [variable, prefixes];
}

/** A shared path under the variable, refused when it is, holds or sits in a file each account keeps to itself. */
function checkSharePath(value: unknown, file: string, field: string, variable: string, prefixes: string[], guarded: string[]): string {
  const path = checkRelative(value, file, field, variable);
  for (const prefix of prefixes) {
    const full = prefix.length === 0 ? path : `${prefix}/${path}`;
    const hit = guarded.find((other) => overlaps(full, other));
    if (hit !== undefined) {
      reject(file, field, 'a path apart from every login and seed file', `${field} (${path}) overlaps ${hit}, which each account keeps to itself`);
    }
  }
  return path;
}

/**
 * What an isolated account takes from the provider's own profile. A path that
 * is, holds or sits in a login file or a seed file is refused: sharing it would
 * hand every account the user's own login, or fight the seed for the file.
 */
function checkShared(
  value: unknown,
  file: string,
  profiles: ProviderDescriptor['profiles'],
  guarded: string[],
): ProviderShare[] {
  return asArray(value, file, 'shared').map((entry, index) => {
    const field = `shared[${index}]`;
    const obj = asObject(entry, file, field);
    checkKeys(obj, ['variable', 'paths', 'retarget'], file, field);
    const [variable, prefixes] = checkShareVariable(obj['variable'], file, `${field}.variable`, profiles);
    const paths = asArray(obj['paths'], file, `${field}.paths`).map((raw, at) =>
      checkSharePath(raw, file, `${field}.paths[${at}]`, variable, prefixes, guarded),
    );
    if (paths.length === 0) reject(file, `${field}.paths`, 'at least one path', `${field}.paths must list at least one path`);
    const share: ProviderShare = { variable, paths };
    if (obj['retarget'] !== undefined) {
      const retarget: Record<string, string[]> = {};
      for (const [name, names] of Object.entries(asObject(obj['retarget'], file, `${field}.retarget`))) {
        const at = `${field}.retarget.${name}`;
        if (!paths.includes(name)) reject(file, at, `one of: ${paths.join(', ')}`, `${at} is not one of the shared paths`);
        retarget[name] = asArray(names, file, at).map((other, k) => {
          const path = asString(other, file, `${at}[${k}]`);
          if (!paths.includes(path)) reject(file, `${at}[${k}]`, `one of: ${paths.join(', ')}`, `${at}[${k}] is not one of the shared paths`);
          return path;
        });
      }
      share.retarget = retarget;
    }
    return share;
  });
}

/**
 * Keys of a JSON file an isolated account keeps, taken from the user's copy.
 * The file obeys the same limits as a shared path: under the account's
 * directory and apart from every login and seed file.
 */
function checkSharedKeys(
  value: unknown,
  file: string,
  profiles: ProviderDescriptor['profiles'],
  guarded: string[],
): ProviderSharedKeys[] {
  return asArray(value, file, 'sharedKeys').map((entry, index) => {
    const field = `sharedKeys[${index}]`;
    const obj = asObject(entry, file, field);
    checkKeys(obj, ['variable', 'path', 'home', 'keys'], file, field);
    const [variable, prefixes] = checkShareVariable(obj['variable'], file, `${field}.variable`, profiles);
    const path = checkSharePath(obj['path'], file, `${field}.path`, variable, prefixes, guarded);
    const keys = asArray(obj['keys'], file, `${field}.keys`).map((raw, at) => {
      const key = asString(raw, file, `${field}.keys[${at}]`);
      if (key.length === 0) reject(file, `${field}.keys[${at}]`, 'a non-empty key', `${field}.keys[${at}] is empty`);
      // Assigning it would set the merged object's prototype instead of a key.
      if (key === '__proto__') reject(file, `${field}.keys[${at}]`, 'a key other than __proto__', `${field}.keys[${at}] cannot be __proto__`);
      return key;
    });
    if (keys.length === 0) reject(file, `${field}.keys`, 'at least one key', `${field}.keys must list at least one key`);
    const out: ProviderSharedKeys = { variable, path, keys: [...new Set(keys)] };
    if (obj['home'] !== undefined) {
      const home = asString(obj['home'], file, `${field}.home`);
      if (!home.startsWith('~/')) reject(file, `${field}.home`, 'a path starting with ~/', `${field}.home must start with ~/: ${home}`);
      out.home = `~/${checkRelative(home.slice(2), file, `${field}.home`, 'the home directory')}`;
    }
    return out;
  });
}

/** Where the user's own hooks live, for a provider that runs them. */
function checkHookSources(
  value: unknown,
  file: string,
  profiles: ProviderDescriptor['profiles'],
  runsHooks: boolean,
): ProviderHookSource[] {
  if (!runsHooks) {
    reject(file, 'hookSources', 'capabilities.hooks set to true', 'hookSources needs capabilities.hooks: an agent that runs no hooks has none to count');
  }
  return asArray(value, file, 'hookSources').map((entry, index) => {
    const field = `hookSources[${index}]`;
    const obj = asObject(entry, file, field);
    checkKeys(obj, ['variable', 'path', 'format'], file, field);
    const format = asString(obj['format'], file, `${field}.format`);
    if (!HOOK_FORMATS.includes(format as ProviderHookSource['format'])) {
      reject(file, `${field}.format`, `one of: ${HOOK_FORMATS.join(', ')}`, `unknown hook source format ${format}`);
    }
    if (obj['variable'] === undefined) {
      const path = asString(obj['path'], file, `${field}.path`);
      if (!path.startsWith('~/')) {
        reject(file, `${field}.path`, 'a path starting with ~/', `${field}.path needs a variable or a path under ~/: ${path}`);
      }
      checkRelative(path.slice(2), file, `${field}.path`, 'the home directory');
      return { path, format: format as ProviderHookSource['format'] };
    }
    const variable = asString(obj['variable'], file, `${field}.variable`);
    if (isolationPrefixes(profiles, variable) === null) {
      reject(file, `${field}.variable`, 'an isolation variable of one of the profiles', `${field}.variable names ${variable}, which no profile isolates`);
    }
    return { variable, path: checkRelative(obj['path'], file, `${field}.path`, variable), format: format as ProviderHookSource['format'] };
  });
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

function checkModels(value: unknown, file: string, protocol: Protocol): ModelInfo[] {
  const raw = asArray(value, file, 'models');
  if (raw.length === 0 && protocol === 'echo') reject(file, 'models', 'at least one model for echo', 'echo models must list at least one model');
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

  const auth = checkAuth(obj['auth'], file);
  const seedFiles = obj['seedFiles'] === undefined ? undefined : checkSeedFiles(obj['seedFiles'], file);
  const capabilities = checkCapabilities(obj['capabilities'], file);
  // What each account keeps to itself, relative to its isolation directory.
  const guarded = [
    ...(auth.session ?? []),
    ...(auth.sqlite === undefined ? [] : [auth.sqlite.file]),
    ...Object.values(profiles).flatMap((profile) => profile?.session ?? []),
    ...Object.keys(seedFiles ?? {}),
  ].map((path) => path.split('\\').join('/'));

  return expandDescriptor(
    {
      id,
      schemaVersion: 1,
      name: asString(obj['name'], file, 'name'),
      shortName: asString(obj['shortName'], file, 'shortName'),
      protocol: protocol as Protocol,
      roots: checkRoots(obj['roots'], file),
      profiles,
      auth,
      ...(obj['login'] === undefined ? {} : { login: checkLogin(obj['login'], file) }),
      ...(obj['isolation'] === undefined ? {} : { isolation: checkIsolation(obj['isolation'], file) }),
      ...(seedFiles === undefined ? {} : { seedFiles }),
      ...(obj['shared'] === undefined ? {} : { shared: checkShared(obj['shared'], file, profiles, guarded) }),
      ...(obj['sharedKeys'] === undefined ? {} : { sharedKeys: checkSharedKeys(obj['sharedKeys'], file, profiles, guarded) }),
      ...(obj['hookSources'] === undefined ? {} : { hookSources: checkHookSources(obj['hookSources'], file, profiles, capabilities.hooks) }),
      ...(obj['quirks'] === undefined ? {} : { quirks: checkQuirks(obj['quirks'], file) }),
      ...(obj['experimental'] === undefined ? {} : { experimental: asBoolean(obj['experimental'], file, 'experimental') }),
      models: checkModels(obj['models'], file, protocol as Protocol),
      capabilities,
    },
    dataDir,
  );
}
