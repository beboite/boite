// English is the reference catalogue of the UI. A translation may lag behind
// it on main and in a nightly, where the UI shows the English sentence in the
// missing one's place; a release may not. `--release` turns every missing
// sentence into a failure. A key English does not have, a sentence whose
// `{slots}` differ, or a value of another kind fails in both modes.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CATALOGUE_DIR = 'packages/ui/src/lib';

export type Report = {
  /** Every sentence English has and the translation lacks, as a dotted path. */
  missing: string[];
  /** Keys the translation has and English does not. */
  extra: string[];
  /** Same key, but another kind of value or other `{slots}`. */
  mismatched: string[];
};

function isNode(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function kind(value: unknown): string {
  if (Array.isArray(value)) return `list of ${value.length}`;
  return value === null ? 'null' : typeof value;
}

function slots(text: string): string {
  return [...text.matchAll(/\{(\w+)\}/g)].map((hit) => hit[1]!).sort().join(', ');
}

/** The sentences under a node, one dotted path each. A list is one sentence set. */
export function leaves(value: unknown, path: string[] = []): string[] {
  if (!isNode(value)) return [path.join('.')];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
}

export function compare(reference: unknown, translation: unknown): Report {
  const report: Report = { missing: [], extra: [], mismatched: [] };
  const walk = (a: unknown, b: unknown, path: string[]): void => {
    const at = path.join('.');
    if (b === undefined) {
      report.missing.push(...leaves(a, path));
      return;
    }
    if (kind(a) !== kind(b)) {
      report.mismatched.push(`${at}: expected ${kind(a)}, got ${kind(b)}`);
      return;
    }
    if (typeof a === 'string' && slots(a) !== slots(b as string)) {
      report.mismatched.push(`${at}: expected slots {${slots(a)}}, got {${slots(b as string)}}`);
      return;
    }
    if (!isNode(a) || !isNode(b)) return;
    for (const key of Object.keys(a)) walk(a[key], b[key], [...path, key]);
    for (const key of Object.keys(b)) if (!Object.hasOwn(a, key)) report.extra.push([...path, key].join('.'));
  };
  walk(reference, translation, []);
  return report;
}

/** `strings.<code>.ts` beside `strings.en.ts`, each exporting a const named after its code. */
export async function loadCatalogues(dir = CATALOGUE_DIR): Promise<{ reference: unknown; translations: Map<string, unknown> }> {
  const reference = (await import(resolve(dir, 'strings.en.ts'))).strings;
  if (!isNode(reference)) throw new Error(`${join(dir, 'strings.en.ts')}: expected an export named strings`);
  const translations = new Map<string, unknown>();
  for (const file of readdirSync(dir).sort()) {
    const code = /^strings\.([a-z]{2})\.ts$/.exec(file)?.[1];
    if (!code || code === 'en') continue;
    const catalogue = (await import(resolve(dir, file)))[code];
    if (!isNode(catalogue)) throw new Error(`${join(dir, file)}: expected an export named ${code}`);
    translations.set(code, catalogue);
  }
  return { reference, translations };
}

if (import.meta.main) {
  const release = process.argv.includes('--release');
  const { reference, translations } = await loadCatalogues();
  const total = leaves(reference).length;
  let failed = false;
  for (const [code, catalogue] of translations) {
    const file = `${CATALOGUE_DIR}/strings.${code}.ts`;
    const report = compare(reference, catalogue);
    for (const line of [...report.mismatched, ...report.extra.map((path) => `${path}: not in strings.en.ts`)]) {
      console.log(`::error file=${file},title=Translation ${code}::${line}`);
      failed = true;
    }
    console.log(`${code}: ${total - report.missing.length} of ${total} sentences translated`);
    if (report.missing.length === 0) continue;
    const shown = report.missing.slice(0, 20).join(', ') + (report.missing.length > 20 ? ` and ${report.missing.length - 20} more` : '');
    const level = release ? 'error' : 'warning';
    const consequence = release ? 'a release needs every sentence translated' : 'shown in English until translated';
    console.log(`::${level} file=${file},title=Translation ${code}::${report.missing.length} missing, ${consequence}: ${shown}`);
    for (const path of report.missing) console.log(`  missing ${code}: ${path}`);
    if (release) failed = true;
  }
  if (failed) process.exit(1);
}
