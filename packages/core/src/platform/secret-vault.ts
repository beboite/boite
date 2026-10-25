/**
 * Picks the system's secret store for this OS, loaded only when the first
 * secret is saved or used: DPAPI on Windows, the Keychain on macOS, the Secret
 * Service on Linux. When none answers, values live in memory and are lost when
 * the core stops; `persistent` tells the caller so.
 */
import { which } from 'bun';
import { currentOs } from '../paths.ts';
import type { SecretVault } from './types.ts';

/** Values in this process only. Used when no system vault answers, and by tests. */
export class MemoryVault implements SecretVault {
  readonly kind = 'memory' as const;
  readonly persistent: boolean = false;
  readonly #values = new Map<string, Uint8Array>();

  async put(id: string, value: Uint8Array): Promise<void> {
    this.#values.get(id)?.fill(0);
    this.#values.set(id, value.slice());
  }

  async take(id: string): Promise<Uint8Array | null> {
    return this.#values.get(id)?.slice() ?? null;
  }

  async delete(id: string): Promise<void> {
    this.#values.get(id)?.fill(0);
    this.#values.delete(id);
  }

  async ids(): Promise<string[]> {
    return [...this.#values.keys()];
  }
}

/** The vault for this machine; `dir` holds DPAPI's sealed blobs on Windows. */
export async function openSecretVault(dir: string): Promise<SecretVault> {
  const os = currentOs();
  if (os === 'windows') {
    const { DpapiVault } = await import('./windows/dpapi-vault.ts');
    return new DpapiVault(dir);
  }
  const posix = await import('./posix-vault.ts');
  if (os === 'macos' && which('security')) return new posix.KeychainVault();
  if (os === 'linux' && which('secret-tool')) {
    const vault = new posix.SecretServiceVault();
    if (await posix.answers(vault)) return vault;
  }
  return new MemoryVault();
}
