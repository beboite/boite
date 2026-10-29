// Shared paths, shared JSON keys, hook sources and provider quirks.
import type { ProviderDescriptor, ProviderShare, ProviderSharedKeys, ProviderHookSource, ProviderQuirk } from '@boite/contracts';
import { reject, asObject, asString, asArray, checkKeys } from './validate-primitives.ts';

const QUIRKS: readonly ProviderQuirk[] = ['antigravity', 'grok', 'hermes'];
const HOOK_FORMATS: readonly ProviderHookSource['format'][] = ['events', 'modules'];

/** A path under some directory: relative, no `..`, written with `/`. */
export function checkRelative(value: unknown, file: string, field: string, within: string): string {
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
export function checkShared(
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
export function checkSharedKeys(
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
export function checkHookSources(
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
export function checkQuirks(value: unknown, file: string): ProviderQuirk[] {
  return asArray(value, file, 'quirks').map((entry, index) => {
    const quirk = asString(entry, file, `quirks[${index}]`);
    if (!QUIRKS.includes(quirk as ProviderQuirk)) {
      reject(file, `quirks[${index}]`, `one of: ${QUIRKS.join(', ')}`, `unknown quirk ${quirk}`);
    }
    return quirk as ProviderQuirk;
  });
}

