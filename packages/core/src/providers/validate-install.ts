// Executable candidates, downloaded releases and self-update checks.
import type { ExecutableCandidate, ProviderInstall, ProviderInstallLatest, ProviderSelfUpdate } from '@boite/contracts';
import { isNpmSpec } from './npm.ts';
import { NPM_ROOT } from './resolve.ts';
import { PLAIN_VERSION, SHA256_HEX } from './install-latest.ts';
import { reject, asObject, asString, asBoolean, asArray, asPositiveInteger, checkKeys, checkStringMap } from './validate-primitives.ts';

const CANDIDATE_KINDS: readonly ExecutableCandidate['kind'][] = ['path', 'file', 'npm'];

export function checkCandidate(value: unknown, file: string, field: string): ExecutableCandidate {
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

/**
 * A release Boite downloads itself: the archive, what it hashes to, and every
 * file that has to come out of it with its exact size. The first file is the
 * executable, and nothing outside the list is kept.
 */
export function checkInstall(value: unknown, file: string, field: string): ProviderInstall {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['version', 'url', 'sha256', 'archiveBytes', 'files', 'arch', 'format', 'latest'], file, field);
  const arch = obj['arch'];
  if (arch !== undefined && arch !== 'x64' && arch !== 'arm64') {
    reject(file, `${field}.arch`, 'x64 or arm64', `${field}.arch must be x64 or arm64`);
  }
  const format = obj['format'];
  if (format !== undefined && format !== 'zip' && format !== 'binary' && format !== 'tgz') {
    reject(file, `${field}.format`, 'zip, binary or tgz', `${field}.format must be zip, binary or tgz`);
  }

  const url = asString(obj['url'], file, `${field}.url`);
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    reject(file, `${field}.url`, 'an http or https url', `${field}.url must be an http or https url`);
  }
  const sha256 = asString(obj['sha256'], file, `${field}.sha256`);
  if (!SHA256_HEX.test(sha256)) {
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
  if (!PLAIN_VERSION.test(version)) {
    reject(file, `${field}.version`, 'letters, digits and . _ + -, starting with a letter or digit', `${field}.version is not a plain version: ${version}`);
  }
  let latest: ProviderInstallLatest | undefined;
  if (obj['latest'] !== undefined) {
    // A manifest names one binary and its size: a zip's members could not be checked.
    if (format !== 'binary') {
      reject(file, `${field}.latest`, 'format "binary"', `${field}.latest needs format "binary": a manifest describes one binary`);
    }
    latest = checkInstallLatest(obj['latest'], file, `${field}.latest`);
  }
  return { version, url, sha256, archiveBytes, files,
    ...(arch === undefined ? {} : { arch: arch as 'x64' | 'arm64' }),
    ...(format === 'zip' || format === 'binary' || format === 'tgz' ? { format } : {}),
    ...(latest === undefined ? {} : { latest }) };
}

function checkInstallLatest(value: unknown, file: string, field: string): ProviderInstallLatest {
  const obj = asObject(value, file, field);
  checkKeys(obj, ['versionUrl', 'manifest', 'platform', 'url'], file, field);
  // What these name is trusted for a digest, so only https.
  const https = (key: string, templated: boolean): string => {
    const url = asString(obj[key], file, `${field}.${key}`);
    if (!url.startsWith('https://')) reject(file, `${field}.${key}`, 'an https url', `${field}.${key} must be an https url`);
    // The version file is read before any version is known, so it cannot name one.
    if (templated !== url.includes('{version}')) {
      const expected = templated ? 'a url containing {version}' : 'a url without {version}';
      reject(file, `${field}.${key}`, expected, `${field}.${key} must be ${expected}`);
    }
    return url;
  };
  const platform = asString(obj['platform'], file, `${field}.platform`);
  if (!/^[A-Za-z0-9._-]+$/.test(platform)) {
    reject(file, `${field}.platform`, 'a manifest platform key such as win32-x64', `${field}.platform is not a platform key: ${platform}`);
  }
  return { versionUrl: https('versionUrl', false), manifest: https('manifest', true), platform, url: https('url', true) };
}

export function checkUpdate(value: unknown, file: string, field: string): ProviderSelfUpdate {
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

