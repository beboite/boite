/** Erase sealed blobs from older releases without loading DPAPI or decrypting a value. */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretVault } from '../types.ts';

export class DpapiVault implements SecretVault {
  readonly kind = 'dpapi' as const;
  readonly persistent = true;
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error(`secret id: expected letters, digits, _ or -, got ${id.length} characters`);
    return join(this.dir, `${id}.bin`);
  }

  async delete(id: string): Promise<void> {
    rmSync(this.file(id), { force: true });
  }

  async ids(): Promise<string[]> {
    try {
      return readdirSync(this.dir).filter(name => name.endsWith('.bin')).map(name => name.slice(0, -4));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
