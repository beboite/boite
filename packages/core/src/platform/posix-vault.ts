/** Delete legacy keyring entries without ever reading or writing their values. */
import type { SecretVault } from './types.ts';

const SERVICE = 'boite-secret';
const TOOL_TIMEOUT_MS = 15_000;

async function erase(cmd: string[], missingCode?: number): Promise<void> {
  const child = Bun.spawn({ cmd, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), TOOL_TIMEOUT_MS);
  try {
    const [code] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // An absent Keychain item is already erased; secret-tool has no separate missing-entry status.
    if (code === 0 || code === missingCode) return;
    throw new Error(`${cmd[0]} could not erase a legacy secret (exit ${code}); cleanup will retry`);
  } finally {
    clearTimeout(timer);
  }
}

function checkId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error(`secret id: expected letters, digits, _ or -, got ${id.length} characters`);
  return id;
}

export class KeychainVault implements SecretVault {
  readonly kind = 'keychain' as const;
  readonly persistent = true;
  async delete(id: string): Promise<void> {
    await erase(['security', 'delete-generic-password', '-a', checkId(id), '-s', SERVICE], 44);
  }
}

export class SecretServiceVault implements SecretVault {
  readonly kind = 'libsecret' as const;
  readonly persistent = true;
  async delete(id: string): Promise<void> {
    await erase(['secret-tool', 'clear', 'service', SERVICE, 'id', checkId(id)]);
  }
}
