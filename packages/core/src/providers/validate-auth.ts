// Authentication, login, isolation policy and seeded file checks.
import type { ProviderAuth, ProviderLogin, ProviderIsolation } from '@boite/contracts';
import { reject, asObject, asString, asBoolean, asArray, checkKeys, checkStringMap } from './validate-primitives.ts';
import { checkRelative } from './validate-share.ts';

const AUTH_KINDS: readonly ProviderAuth['kind'][] = ['oauth-cli', 'api-key', 'none'];

export function checkAuth(value: unknown, file: string): ProviderAuth {
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
export function checkLogin(value: unknown, file: string): ProviderLogin {
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
export function checkIsolation(value: unknown, file: string): ProviderIsolation {
  const obj = asObject(value, file, 'isolation');
  checkKeys(obj, ['alwaysIsolated'], file, 'isolation');
  return { alwaysIsolated: asBoolean(obj['alwaysIsolated'], file, 'isolation.alwaysIsolated') };
}

/**
 * Files the core writes under an account's isolation directory before the agent
 * runs. A path that climbs out of that directory is refused by name, the same
 * way an archive member is.
 */
export function checkSeedFiles(value: unknown, file: string): Record<string, string> {
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

