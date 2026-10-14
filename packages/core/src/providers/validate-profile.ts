// OS profiles and protocol-specific executable checks.
import type { OsProfile, Protocol, ProviderDescriptor } from '@boite/contracts';
import { OS_KEYS } from './expand.ts';
import { reject, asObject, asString, asArray, checkKeys, checkStringMap } from './validate-primitives.ts';
import { checkCandidate, checkInstall, checkUpdate } from './validate-install.ts';

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

export function checkProfiles(value: unknown, file: string, protocol: Protocol): ProviderDescriptor['profiles'] {
  const profilesRaw = asObject(value, file, 'profiles');
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
  return profiles;
}
