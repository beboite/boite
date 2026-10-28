import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sources } from './graph.ts';
import { lineCount } from './size.ts';

/** Where production sources live. The packages, then the native and Android code around them. */
export const ROOTS = [
  'packages/contracts/src', 'packages/core/src', 'packages/ui/src',
  'apps/android-server/termux', 'apps/android-server/app/src/main', 'apps/android/app/src/main',
  'apps/shell/src-tauri/src', 'apps/shell/launcher/src',
];

/** Each source extension's language, and whether its imports enter the dependency graph or only its size is checked. */
const LANGUAGES: Record<string, { language: string; imports: boolean }> = {
  '.ts': { language: 'TypeScript', imports: true },
  '.js': { language: 'JavaScript', imports: true },
  '.svelte': { language: 'Svelte', imports: true },
  '.rs': { language: 'Rust', imports: false },
  '.kt': { language: 'Kotlin', imports: false },
  '.java': { language: 'Java', imports: false },
};
/** Tests, declarations and a Rust module's `tests.rs` are not production code. */
const NOT_PRODUCTION = /(?:\.test\.ts|\.d\.ts|(?:^|\/)tests\.rs)$/;

export function languageOf(file: string): { language: string; imports: boolean } | undefined {
  if (NOT_PRODUCTION.test(file)) return undefined;
  const extension = /\.[a-z]+$/.exec(file)?.[0];
  return extension === undefined ? undefined : LANGUAGES[extension];
}

export interface Inventory {
  /** what the dependency graph reads, by repository path */
  sources: Sources;
  /** the line count of every production source */
  lines: Map<string, number>;
  /** how many files of each language were read */
  languages: Map<string, number>;
}

/** Every production source under `ROOTS`, read from the repository at `base`. A missing root fails: the gate never narrows silently. */
export function readInventory(base = '.', roots = ROOTS): Inventory {
  const inventory: Inventory = { sources: new Map(), lines: new Map(), languages: new Map() };
  function read(directory: string): void {
    for (const entry of readdirSync(join(base, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { read(file); continue; }
      const kind = languageOf(file);
      if (!kind) continue;
      const source = readFileSync(join(base, file), 'utf8');
      if (kind.imports) inventory.sources.set(file, source);
      inventory.lines.set(file, lineCount(source));
      inventory.languages.set(kind.language, (inventory.languages.get(kind.language) ?? 0) + 1);
    }
  }
  for (const root of roots) read(root);
  return inventory;
}
