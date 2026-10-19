import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSync, type Plugin } from 'vite';

/**
 * A translation as its module ships it: English with every sentence the
 * translation has written over it (`src/lib/i18n.svelte.ts`), one part at a
 * time: `strings/fr/chat.ts` over `strings/en/chat.ts`. A device loads
 * the one catalogue it speaks, and a sentence the translation lacks still
 * answers in English without the English chunk. The build and the tests both
 * run it, so what a test reads is what ships. `scripts/ci/translations.ts`
 * reads the source files and still sees what is missing.
 */
export function completeCatalogues(): Plugin {
  return {
    name: 'boite-complete-catalogues',
    enforce: 'pre',
    transform(code, id) {
      // One file per part of the catalogue: `strings/fr/chat.ts` over `strings/en/chat.ts`.
      const [, locale, part] = /[\\/]src[\\/]lib[\\/]strings[\\/]([a-z]{2})[\\/]([\w-]+)\.ts$/.exec(id) ?? [];
      if (!locale || !part || locale === 'en') return null;
      const english = join(dirname(id), '..', 'en', `${part}.ts`);
      this.addWatchFile(english);
      return { code: overEnglish(readFileSync(english, 'utf8'), code, locale, part), map: null };
    },
  };
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Property = Node & { key: Node & { name?: string; value?: unknown }; value: Node; computed: boolean; method: boolean; shorthand: boolean; kind: string };

/** The object literal `export const <name> = { ... }` holds, through `as const` or a type annotation. */
function catalogueObject(source: string, file: string, name: string): Node {
  const parsed = parseSync(file, source, { lang: 'ts' });
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0]?.message}`);
  for (const statement of parsed.program.body as unknown as Node[]) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration as Node | null : null;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const declarator of declaration.declarations as Node[]) {
      if ((declarator.id as Node & { name: string }).name !== name) continue;
      const init = unwrap(declarator.init as Node);
      if (init.type === 'ObjectExpression') return init;
    }
  }
  throw new Error(`${file}: expected export const ${name} = { ... }`);
}

function unwrap(node: Node): Node {
  return node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression' ? unwrap(node.expression as Node) : node;
}

function keyOf(property: Property, file: string): string {
  const key = property.key;
  if (property.type !== 'Property' || property.computed || property.method || property.shorthand || property.kind !== 'init') {
    throw new Error(`${file}: a catalogue holds plain \`key: value\` entries, found ${property.type} at offset ${property.start}`);
  }
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  throw new Error(`${file}: a catalogue key is a name or a string, found ${key.type} at offset ${key.start}`);
}

/**
 * The source of `export const <locale> = { ... }`: English's keys in English's
 * order, each sentence the translation's when it has one. Values are copied as
 * written, so a sentence that is a function (a count, a plural) stays one.
 */
export function overEnglish(english: string, translation: string, locale: string, part: string): string {
  const englishFile = `strings/en/${part}.ts`;
  const translationFile = `strings/${locale}/${part}.ts`;
  const merge = (reference: Node, translated: Node | undefined): string => {
    const own = new Map<string, Node>();
    for (const property of (translated?.properties ?? []) as Property[]) own.set(keyOf(property, translationFile), unwrap(property.value));
    const entries = (reference.properties as Property[]).map((property) => {
      const key = keyOf(property, englishFile);
      const value = unwrap(property.value);
      const theirs = own.get(key);
      const name = english.slice(property.key.start, property.key.end);
      if (value.type === 'ObjectExpression') return `${name}: ${merge(value, theirs?.type === 'ObjectExpression' ? theirs : undefined)}`;
      return `${name}: ${theirs ? translation.slice(theirs.start, theirs.end) : english.slice(value.start, value.end)}`;
    });
    return `{\n${entries.join(',\n')}\n}`;
  };
  const merged = merge(catalogueObject(english, englishFile, 'strings'), catalogueObject(translation, translationFile, locale));
  return `export const ${locale} = ${merged};\n`;
}
