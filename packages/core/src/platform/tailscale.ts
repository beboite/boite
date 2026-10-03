import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Os } from '@boite/contracts';

/**
 * Where the tailscale CLI lives on each OS, or null when it is not installed.
 * The Windows installer and the macOS app put it outside PATH; a Linux package
 * puts it in /usr/bin, a static install in /usr/local/bin.
 */
export function findTailscaleCli(os: Os, which: (name: string) => string | null = (name) => Bun.which(name)): string | null {
  const onPath = which(os === 'windows' ? 'tailscale.exe' : 'tailscale');
  if (onPath) return onPath;
  const candidates = os === 'windows'
    ? [join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : os === 'macos'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
      : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'];
  return candidates.find((path) => existsSync(path)) ?? null;
}
