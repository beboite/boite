import type { Settings } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Flags } from './main.ts';

// Loaded with the server graph, so the policy check stays out of the startup entry.

/**
 * Where the core binds. A `--host` or a `--lan` on the command line always wins,
 * because the person who typed it meant it; with neither, the stored
 * `listenOnLan` setting decides, which is what the switch in General settings
 * changes. The address is read once, at start: a running core never rebinds.
 * An admin policy with `network.lan: false` keeps it on loopback whatever the
 * command line says.
 */
export function resolveHost(flags: Flags, settings: Settings, lanForbidden = false): string {
  if (lanForbidden) return flags.hostExplicit && isLoopbackHost(flags.host) ? flags.host : '127.0.0.1';
  if (flags.hostExplicit) return flags.host;
  return settings.listenOnLan ? '0.0.0.0' : '127.0.0.1';
}

/** The address the core listens on, with the admin policy's network.lan over the setting and the flags. */
export function listenHost(core: Core, flags: Flags): string {
  const lanForbidden = core.policy.networkOff('lan');
  const host = resolveHost(flags, core.settings.get(), lanForbidden);
  if (lanForbidden && flags.hostExplicit && host !== flags.host) {
    core.logs.warn(`listening on ${host}, not ${flags.host}: ${core.policy.refusal('network.lan').message}`, { source: 'startup', event: 'startup.policy-host' });
  }
  return host;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
