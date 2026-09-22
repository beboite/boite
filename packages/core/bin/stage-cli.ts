/**
 * The `boite` shim beside the Linux core, mode 755, so the two are copied to a
 * server together. Without it no agent there can run `boite`.
 */
import { chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const target = join(import.meta.dir, '..', 'dist', 'boite');
copyFileSync(join(import.meta.dir, '..', 'shims', 'boite'), target);
chmodSync(target, 0o755);
console.log(`staged ${target}`);
