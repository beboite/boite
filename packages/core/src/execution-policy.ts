import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {inside, policyIdentity, secretPath} from './contacts/file-policy.ts';
import type {PermissionMode} from '@boite/contracts';

export interface ProtectedExecutionInput {
  scope: {kind: 'job' | 'board' | 'letter'; id: string; associationId: string; grantRevision: number};
  /** An external conversation can intersect several independently revocable associations. */
  additionalScopes?: readonly ProtectedExecutionInput['scope'][];
  /** Retain the host selection; this capability adds isolation without replacing approval semantics. */
  route?: {providerId: string; accountId: string; permissionMode: PermissionMode; profileId?: string};
  checkout: string;
  /** Trusted host configuration, never remote request parameters. Values are never opened here. */
  credentialPaths: readonly string[];
  /** Extra individual toolchain binaries. No account directories, config or arbitrary directory binds. */
  executables?: readonly string[];
  /** Read-only exceptions for exact captured files, with their existing policyFile identity. */
  readOverrides?: readonly {path: string; identity: string; expiresAt: number}[];
  expiresAt: number;
}

export interface ExecutionPolicy {
  readonly version: 1;
  readonly capabilityId: string;
  readonly scope: Readonly<ProtectedExecutionInput['scope']>;
  readonly additionalScopes: readonly Readonly<ProtectedExecutionInput['scope']>[];
  readonly route: Readonly<NonNullable<ProtectedExecutionInput['route']>> | null;
  readonly checkout: string;
  readonly checkoutIdentity: string;
  readonly credentialPaths: readonly string[];
  readonly executables: readonly Readonly<{path: string; identity: string}>[];
  readonly readOverrides: readonly Readonly<{path: string; identity: string; expiresAt: number}>[];
  readonly expiresAt: number;
  /** Warm sessions may only be reused under this exact filesystem and authority identity. */
  readonly fingerprint: string;
}

export const executionIdentity = (path: string): string => {
  const s = lstatSync(path, {bigint: true});
  return `${s.dev}:${s.ino}`;
};
export const executionFileIdentity = (path: string): string => policyIdentity(path, lstatSync(path, {bigint: true}));

/** Capture before untrusted text is executed. No mutable request object survives this call. */
export function captureExecutionPolicy(input: ProtectedExecutionInput): ExecutionPolicy {
  const scope = (s: ProtectedExecutionInput['scope']) => {
    if (!s || !['job', 'board', 'letter'].includes(s.kind) || typeof s.id !== 'string' || !s.id
      || typeof s.associationId !== 'string' || !s.associationId || !Number.isSafeInteger(s.grantRevision) || s.grantRevision < 0) {
      throw new Error('execution.scope: expected a job, board claim or letter and its association/grant revision');
    }
    return Object.freeze({kind: s.kind, id: s.id, associationId: s.associationId, grantRevision: s.grantRevision});
  };
  const primary = scope(input?.scope);
  const additional = Object.freeze((input.additionalScopes ?? []).map(scope));
  const route = input.route;
  if (route && (typeof route.providerId !== 'string' || !route.providerId || typeof route.accountId !== 'string' || !route.accountId
    || route.profileId !== undefined && typeof route.profileId !== 'string'
    || !['default', 'plan', 'acceptEdits', 'bypassPermissions', 'yolo', 'dontAsk'].includes(route.permissionMode))) {
    throw new Error('execution.route: expected the selected host provider, account and permission mode');
  }
  if (!isAbsolute(input.checkout) || realpathSync(input.checkout) !== resolve(input.checkout) || !lstatSync(input.checkout).isDirectory()) {
    throw new Error('execution.checkout: expected an absolute canonical directory');
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error('execution.expiresAt: expected a future authority expiry');
  if (!Array.isArray(input.credentialPaths)) throw new Error('execution.credentialPaths: expected host credential paths, including account configuration');
  const credentials = [...new Set(input.credentialPaths.flatMap(path => {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('execution.credentialPaths: expected absolute host paths');
    try { return [resolve(path), realpathSync(path)]; } catch { return [resolve(path)]; }
  }))].sort();
  if (credentials.some(path => inside(path, input.checkout))) throw new Error('execution.checkout: credential directories cannot contain the checkout');
  const executables = [...new Set(input.executables ?? [])].sort().map(path => {
    const real = realpathSync(path), s = lstatSync(real);
    const credentialAlias = credentials.some(c => {
      try { return lstatSync(c).isFile() && executionIdentity(c) === executionIdentity(real); } catch { return false; }
    });
    const executable = process.platform === 'win32' ? /\.exe$/i.test(real) : !!(s.mode & 0o111);
    if (!isAbsolute(path) || !s.isFile() || !executable || secretPath(real) || credentialAlias
      || credentials.some(c => inside(c, real)) || inside(input.checkout, real)) {
      throw new Error('execution.executables: expected an executable toolchain file outside checkout and credentials');
    }
    return Object.freeze({path: real, identity: executionFileIdentity(real)});
  });
  const overrides = (input.readOverrides ?? []).map(o => {
    if (typeof o.path !== 'string' || !o.path || isAbsolute(o.path) || !inside(input.checkout, resolve(input.checkout, o.path)) || typeof o.identity !== 'string' || !o.identity
      || !Number.isSafeInteger(o.expiresAt) || o.expiresAt <= Date.now()) throw new Error('execution.readOverrides: expected an exact live checkout file identity');
    return Object.freeze({path: o.path, identity: o.identity, expiresAt: o.expiresAt});
  });
  const fields = {version: 1 as const, capabilityId: randomUUID(), scope: primary, additionalScopes: additional,
    route: route ? Object.freeze({providerId: route.providerId, accountId: route.accountId, permissionMode: route.permissionMode, ...(route.profileId ? {profileId: route.profileId} : {})}) : null,
    checkout: input.checkout,
    checkoutIdentity: executionIdentity(input.checkout), credentialPaths: Object.freeze(credentials),
    executables: Object.freeze(executables), readOverrides: Object.freeze(overrides),
    expiresAt: Math.min(input.expiresAt, ...overrides.map(o => o.expiresAt))};
  return Object.freeze({...fields, fingerprint: createHash('sha256').update(JSON.stringify(fields)).digest('hex')});
}

export function assertExecutionPolicy(policy: ExecutionPolicy): void {
  if (Date.now() >= policy.expiresAt) throw new Error('execution.scope: captured authority expired');
  if (realpathSync(policy.checkout) !== policy.checkout || executionIdentity(policy.checkout) !== policy.checkoutIdentity) {
    throw new Error('execution.checkout: expected the captured directory identity');
  }
  for (const executable of policy.executables) if (executionFileIdentity(executable.path) !== executable.identity) {
    throw new Error('execution.executables: captured toolchain file changed');
  }
}
