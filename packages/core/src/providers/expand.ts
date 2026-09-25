import { join, normalize } from 'node:path';
import type { Os, ProviderDescriptor } from '@boite/contracts';
import { agentsDirPath, appDataPath, browserNoopPath, homePath } from '../paths.ts';

/** The OS keys a descriptor's `profiles` may carry, in the order they are read. */
export const OS_KEYS: readonly Os[] = ['windows', 'linux', 'macos'];

/**
 * Where the shipped descriptors and the scripts they name live. A login command
 * writes `{shippedDir}/<script>` instead of a path nobody could write by hand.
 * Only echo uses it, and echo ships from the sources alone (`BOITE_ECHO=1`); a
 * command whose script is missing fails at spawn, with the path in the event.
 */
const SHIPPED_DIR = join(import.meta.dir, 'shipped');

/**
 * `{home}`, `{appdata}` and `{agentsDir}`, the three locations a descriptor may
 * name at load time. The last one is where a managed install puts its files, so
 * it needs the data directory and the provider's own id.
 */
export function substituteHome(value: string, agentsDir: string, dataDir: string): string {
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

export function expandDescriptor(descriptor: ProviderDescriptor, dataDir: string): ProviderDescriptor {
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
