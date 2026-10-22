import { CATALOGUE_DIR, loadCatalogues } from './translations.ts';

/** Authored UI copy only: never rewrite messages, code or provider output. */
export function copyViolations(value: unknown, path = ''): string[] {
  // Catalogue formatters contain authored copy too; inspect them without invoking them.
  if (typeof value === 'function') {
    value = Function.prototype.toString.call(value).replace(/(\\+)u(?:2014|\{0*2014\})/gi,
      (escape, slashes: string) => slashes.length % 2 ? `${slashes.slice(1)}\u2014` : escape);
  }
  if (typeof value === 'string') {
    return value.includes('\u2014') ? [`${path}: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence`] : [];
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => copyViolations(child, path ? `${path}.${key}` : key));
}

export async function checkCopy(dir = CATALOGUE_DIR): Promise<string[]> {
  const { reference, translations } = await loadCatalogues(dir);
  return [['en', reference], ...translations].flatMap(([code, catalogue]) =>
    copyViolations(catalogue).map(line => `${dir}/strings.${code}.ts: ${line}`));
}

if (import.meta.main) {
  const errors = await checkCopy();
  for (const error of errors) console.error(error);
  if (errors.length) process.exit(1);
  console.log('UI copy passed: no em dashes in any language catalogue');
}
