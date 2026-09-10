import { existsSync, lstatSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../dist');
if (existsSync(directory)) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`refusing linked build output: ${directory}`);
  rmSync(directory, { recursive: true });
}
