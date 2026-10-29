import type { Protocol, ProviderDescriptor } from '@boite/contracts';
import { expandDescriptor } from './expand.ts';
import { reject, asObject, asString, asBoolean, checkKeys, checkRoots, checkStringMap } from './validate-primitives.ts';
import { checkProfiles } from './validate-profile.ts';
import { checkAuth, checkLogin, checkIsolation, checkSeedFiles } from './validate-auth.ts';
import { checkShared, checkSharedKeys, checkHookSources, checkQuirks } from './validate-share.ts';
import { checkModels, checkCapabilities } from './validate-models.ts';
export { Rejection } from './validate-primitives.ts';

const PROTOCOLS: readonly Protocol[] = ['claude-sdk', 'codex-appserver', 'muse', 'pi', 'acp', 'echo'];

const DESCRIPTOR_KEYS = [
  'id',
  'schemaVersion',
  'name',
  'shortName',
  'protocol',
  'roots',
  'profiles',
  'env',
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

  const profiles = checkProfiles(obj['profiles'], file, protocol as Protocol);
  if (obj['env'] !== undefined) {
    const env = checkStringMap(obj['env'], file, 'env');
    for (const profile of Object.values(profiles)) profile.env = { ...env, ...profile.env };
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
