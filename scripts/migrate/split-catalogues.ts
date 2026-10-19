/**
 * The UI catalogues moved from `strings.en.ts` and `strings.fr.ts` to one file
 * per top-level key under `lib/strings/<locale>/`. A branch cut before that
 * split edits the old single files, so merging main conflicts on them.
 *
 * Run on the branch once `git merge origin/main` stopped (or after the merge
 * commit):
 *
 *   bun scripts/migrate/split-catalogues.ts
 *
 * It splits the merge base and the branch versions of both catalogues with the
 * codemod that made the split, then replays each part's change onto main's part
 * with `git merge-file`, so main's edits made since the split stay. Resolved
 * files are staged; a part both sides changed on the same lines keeps conflict
 * markers and is listed, like any merge conflict.
 *
 * `bun scripts/migrate/split-catalogues.ts --split` reruns the codemod on the
 * working tree of a tree that still has the single files.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Node = { type: string; start: number; end: number; [key: string]: any };
export const LIB = 'packages/ui/src/lib';
const ROOT = join(import.meta.dir, '..', '..');

const { parseSync } = await import(createRequire(join(ROOT, 'packages/ui/package.json')).resolve('vite'));

export interface Catalogue {
  keys: string[];
  /** top-level key to its source text, comments above it included */
  entries: Map<string, string>;
  /** every byte outside the catalogue object: header comment, imports, types */
  outside: string;
}

export function parseCatalogue(file: string, source: string, name: string): Catalogue {
  const parsed = parseSync(file, source, { lang: 'ts' });
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  for (const statement of parsed.program.body as Node[]) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : null;
    if (declaration?.type !== 'VariableDeclaration') continue;
    const declarator = declaration.declarations.find((d: Node) => d.id.name === name);
    if (!declarator) continue;
    let init = declarator.init as Node;
    while (init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression') init = init.expression;
    const properties = init.properties as Node[];
    const keys = properties.map((p) => p.key.name ?? p.key.value);
    // Each entry keeps the comments above it; the separator comma stays behind.
    const entries = new Map<string, string>();
    properties.forEach((property, i) => {
      const from = i === 0 ? init.start + 1 : properties[i - 1].end;
      entries.set(keys[i], source.slice(from, property.end).replace(/^,/, '').replace(/^[ \t]*\n/, ''));
    });
    const tail = source.slice(properties.at(-1)!.end, init.end - 1).replace(/^,/, '').trim();
    if (tail) throw new Error(`${file}: text after the last entry: ${tail.slice(0, 80)}`);
    return { keys, entries, outside: source.slice(0, init.start) + source.slice(init.end) };
  }
  throw new Error(`${file}: no export const ${name}`);
}

export const enPart = (entry: string) => `export const strings = {\n${entry}\n} as const;\n`;
export const frPart = (entry: string | undefined) =>
  `import type { Translation } from '../../i18n.svelte';\n\nexport const fr: Translation = ${entry ? `{\n${entry}\n}` : '{}'};\n`;
export const enImport = (key: string) => `import { strings as ${key} } from './strings/en/${key}';`;
export const frImport = (key: string) => `import { fr as ${key} } from './strings/fr/${key}';`;

/** The files the split writes, by path under `lib/`, from the two single catalogues. */
export function splitCatalogues(enSource: string, frSource: string): Map<string, string> {
  const en = parseCatalogue('strings.en.ts', enSource, 'strings');
  const fr = parseCatalogue('strings.fr.ts', frSource, 'fr');
  const unknown = fr.keys.filter((key) => !en.entries.has(key));
  if (unknown.length) throw new Error(`strings.fr.ts: keys English lacks: ${unknown.join(', ')}`);
  const files = new Map<string, string>();
  for (const key of en.keys) {
    files.set(`strings/en/${key}.ts`, enPart(en.entries.get(key)!));
    files.set(`strings/fr/${key}.ts`, frPart(fr.entries.get(key)));
  }
  const spread = en.keys.map((key) => `  ...${key},`).join('\n');
  files.set('strings.en.ts', `/**
 * Every user-facing string of the UI. No literal UI text lives anywhere else.
 *
 * One file per top-level key in \`./strings/en/\`, so two changes to different
 * parts of the UI never edit the same file. A new key goes in the file of its
 * part; a new part is a file here and in every translation, and a line in each
 * index.
 */
${en.keys.map(enImport).join('\n')}

export const strings = {
${spread}
} as const;

export type Strings = typeof strings;
`);
  files.set('strings.fr.ts', `/*
 * Le catalogue français, calqué sur \`strings.en.ts\`, un fichier par clé de
 * premier niveau dans \`./strings/fr/\`, nommé comme son modèle anglais.
 *
 * Le type vient de l'anglais : une clé inconnue de l'anglais arrête
 * \`svelte-check\`. Une phrase pas encore traduite peut manquer ici, elle
 * s'affiche alors en anglais (\`lib/i18n.svelte.ts\`) et passe en nightly, mais
 * \`scripts/ci/translations.ts --release\` bloque la release tant qu'elle manque.
 * Les accolades sont des emplacements remplis par \`fill\`, leur nom ne se
 * traduit pas.
 */
import type { Translation } from './i18n.svelte';
${en.keys.map(frImport).join('\n')}

export const fr: Translation = {
${spread}
};
`);
  return files;
}

function git(cwd: string, args: string[], input?: string): { status: number; stdout: string } {
  const run = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: run.status ?? 1, stdout: run.stdout };
}

function show(cwd: string, ref: string, path: string): string | undefined {
  const run = git(cwd, ['show', `${ref}:${path}`]);
  return run.status === 0 ? run.stdout : undefined;
}

const isSplit = (cwd: string, ref: string) => git(cwd, ['cat-file', '-e', `${ref}:${LIB}/strings/en`]).status === 0;

/** Adds a part to an index after the part that precedes it on the branch, or last. */
export function addToIndex(index: string, key: string, after: string | undefined, locale: 'en' | 'fr'): string {
  const line = locale === 'en' ? enImport : frImport;
  const lines = index.split('\n');
  const importAt = after === undefined ? -1 : lines.indexOf(line(after));
  const lastImport = lines.findLastIndex((l) => l.startsWith(locale === 'en' ? 'import { strings as ' : 'import { fr as '));
  lines.splice((importAt >= 0 ? importAt : lastImport) + 1, 0, line(key));
  const spreadAt = after === undefined ? -1 : lines.indexOf(`  ...${after},`);
  const close = lines.findLastIndex((l) => l === '} as const;' || l === '};');
  lines.splice(spreadAt >= 0 ? spreadAt + 1 : close, 0, `  ...${key},`);
  return lines.join('\n');
}

export function removeFromIndex(index: string, key: string, locale: 'en' | 'fr'): string {
  const line = (locale === 'en' ? enImport : frImport)(key);
  return index.split('\n').filter((l) => l !== line && l !== `  ...${key},`).join('\n');
}

function mergeFile(ours: string, base: string, theirs: string): { text: string; conflict: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-merge-'));
  try {
    const paths = ['ours', 'base', 'theirs'].map((name) => join(dir, name));
    [ours, base, theirs].forEach((text, i) => writeFileSync(paths[i], text));
    const run = spawnSync('git', ['merge-file', '-p', '-L', 'HEAD', '-L', 'merge base', '-L', 'main', ...paths], { encoding: 'utf8' });
    if ((run.status ?? -1) < 0 || run.status === null) throw new Error(`git merge-file failed: ${run.stderr}`);
    return { text: run.stdout, conflict: run.status !== 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MigrationResult {
  written: string[];
  deleted: string[];
  conflicts: string[];
  warnings: string[];
}

/**
 * Replays the branch's catalogue edits (`base` to `ours`, single files) onto
 * main's split catalogues (`theirs`) in the working tree of `cwd`.
 */
export function migrate(cwd: string, ours: string, theirs: string): MigrationResult {
  const result: MigrationResult = { written: [], deleted: [], conflicts: [], warnings: [] };
  const base = git(cwd, ['merge-base', ours, theirs]).stdout.trim();
  if (!base) throw new Error(`no merge base between ${ours} and ${theirs}`);
  const catalogues = (ref: string) => {
    const en = show(cwd, ref, `${LIB}/strings.en.ts`);
    const fr = show(cwd, ref, `${LIB}/strings.fr.ts`);
    if (en === undefined || fr === undefined) throw new Error(`${ref} has no ${LIB}/strings.en.ts or strings.fr.ts`);
    return { en, fr, files: splitCatalogues(en, fr) };
  };
  const before = catalogues(base);
  const after = catalogues(ours);
  for (const [file, name] of [['strings.en.ts', 'strings'], ['strings.fr.ts', 'fr']] as const) {
    const was = parseCatalogue(file, before[file === 'strings.en.ts' ? 'en' : 'fr'], name).outside;
    const now = parseCatalogue(file, after[file === 'strings.en.ts' ? 'en' : 'fr'], name).outside;
    if (was !== now) result.warnings.push(`${file}: the branch changed text outside the catalogue object (header, imports, types); carry it over by hand`);
  }

  const index = { en: show(cwd, theirs, `${LIB}/strings.en.ts`)!, fr: show(cwd, theirs, `${LIB}/strings.fr.ts`)! };
  const indexBefore = { ...index };
  const branchKeys = [...after.files.keys()].filter((p) => p.startsWith('strings/en/')).map((p) => p.slice(11, -3));
  const parts = new Set([...before.files.keys(), ...after.files.keys()].filter((p) => p.startsWith('strings/')));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };

  for (const part of parts) {
    const path = `${LIB}/${part}`;
    const was = before.files.get(part);
    const now = after.files.get(part);
    if (was === now) continue;
    const main = show(cwd, theirs, path);
    const locale = part.startsWith('strings/en/') ? 'en' : 'fr';
    const key = part.slice(11, -3);
    if (now === undefined) {
      if (main === undefined) continue;
      if (main !== was) {
        result.conflicts.push(`${path}: the branch deletes this part, main changed it since; delete or keep it by hand`);
        continue;
      }
      rmSync(join(cwd, path), { force: true });
      index[locale] = removeFromIndex(index[locale], key, locale);
      result.deleted.push(path);
      continue;
    }
    if (main === undefined && was !== undefined) {
      write(path, now);
      result.conflicts.push(`${path}: main deleted this part since the split, the branch changed it; the branch version is in place`);
      continue;
    }
    const merged = main === undefined ? { text: now, conflict: false } : mergeFile(now, was ?? '', main);
    if (main === undefined) {
      const at = branchKeys.indexOf(key);
      index[locale] = addToIndex(index[locale], key, at > 0 ? branchKeys[at - 1] : undefined, locale);
    }
    write(path, merged.text);
    (merged.conflict ? result.conflicts : result.written).push(path);
  }

  for (const locale of ['en', 'fr'] as const) {
    const path = `${LIB}/strings.${locale}.ts`;
    write(path, index[locale]);
    if (index[locale] !== indexBefore[locale]) result.written.push(path);
  }
  return result;
}

function main() {
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout.trim() || process.cwd();
  if (process.argv.includes('--split')) {
    const lib = join(cwd, LIB);
    const read = (file: string) => readFileSync(join(lib, file), 'utf8').replaceAll('\r\n', '\n');
    const files = splitCatalogues(read('strings.en.ts'), read('strings.fr.ts'));
    rmSync(join(lib, 'strings'), { recursive: true, force: true });
    for (const [path, text] of files) {
      mkdirSync(dirname(join(lib, path)), { recursive: true });
      writeFileSync(join(lib, path), text);
    }
    console.log(`${(files.size - 2) / 2} parts`);
    return;
  }

  // Mid-merge: HEAD is the branch, MERGE_HEAD main. After the merge commit: its two parents.
  const merging = git(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).status === 0;
  const [ours, theirs] = merging ? ['HEAD', 'MERGE_HEAD'] : ['HEAD^1', 'HEAD^2'];
  if (!merging && git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^2']).status !== 0) {
    console.error('Merge main first: git merge origin/main, then rerun this command.');
    process.exit(2);
  }
  if (isSplit(cwd, ours)) {
    console.log('The branch already has the split catalogues; nothing to migrate.');
    return;
  }
  if (!isSplit(cwd, theirs)) {
    console.error(`${theirs} does not have the split catalogues; merge a main that has them.`);
    process.exit(2);
  }

  const result = migrate(cwd, ours, theirs);
  const staged = [...result.written, ...result.deleted];
  if (staged.length) git(cwd, ['add', '-A', '--', ...staged]);
  if (merging) git(cwd, ['add', '--', `${LIB}/strings.en.ts`, `${LIB}/strings.fr.ts`]);
  for (const path of result.written) console.log(`merged   ${path}`);
  for (const path of result.deleted) console.log(`deleted  ${path}`);
  for (const warning of result.warnings) console.warn(`warning  ${warning}`);
  for (const conflict of result.conflicts) console.error(`conflict ${conflict}`);
  if (!merging) console.log('Files are staged; commit them on top of the merge.');
  if (result.conflicts.length) process.exit(1);
}

if (import.meta.main) main();
