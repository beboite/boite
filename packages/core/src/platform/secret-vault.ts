/** Delete-only legacy vault selection, loaded solely for migration cleanup. */
import { which } from 'bun';
import { currentOs } from '../paths.ts';
import type { SecretVault } from './types.ts';

/** In-memory fixture storage; production uses its empty delete-only view when no legacy vault is available. */
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

/** Legacy cleanup backend; `dir` holds the old sealed blobs on Windows. */
export async function openSecretVault(dir: string): Promise<SecretVault> {
  const os = currentOs();
  if (os === 'windows') {
    const { DpapiVault } = await import('./windows/dpapi-vault.ts');
    return new DpapiVault(dir);
  }
  const posix = await import('./posix-vault.ts');
  if (os === 'macos' && which('security')) return new posix.KeychainVault();
  if (os === 'linux' && which('secret-tool')) return new posix.SecretServiceVault();
  return new MemoryVault();
}
