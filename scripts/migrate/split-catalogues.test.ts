import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LIB, migrate, splitCatalogues } from './split-catalogues';

const en = (entries: string) => `/** header */\nexport const strings = {\n${entries}\n} as const;\n\nexport type Strings = typeof strings;\n`;
const fr = (entries: string) => `import type { Translation } from './i18n.svelte';\n\nexport const fr: Translation = {\n${entries}\n};\n`;
const single = {
  en: ['  alpha: {\n    one: \'One\',\n    two: \'Two\',\n    three: \'Three\',\n    four: \'Four\',\n  },', '  /** Beta. */\n  beta: {\n    three: \'Three\',\n  },'],
  fr: ['  alpha: {\n    one: \'Un\',\n    two: \'Deux\',\n  },', '  beta: {\n    three: \'Trois\',\n  },'],
};

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function repo() {
  dir = mkdtempSync(join(tmpdir(), 'split-catalogues-'));
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    return run.stdout.trim();
  };
  const put = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, LIB, path)), { recursive: true });
      writeFileSync(join(dir, LIB, path), text);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  put({ 'strings.en.ts': en(single.en.join('\n')), 'strings.fr.ts': fr(single.fr.join('\n')) });
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { git, put, read: (path: string) => readFileSync(join(dir, LIB, path), 'utf8') };
}

/** Main splits the catalogues, then edits a part; the branch edits the single files. */
function diverge(branch: { en: string[]; fr: string[] }, mainEdit?: (files: Map<string, string>) => void) {
  const r = repo();
  r.git('checkout', '-qb', 'feature');
  r.put({ 'strings.en.ts': en(branch.en.join('\n')), 'strings.fr.ts': fr(branch.fr.join('\n')) });
  r.git('commit', '-qam', 'branch');
  r.git('checkout', '-q', 'main');
  const files = splitCatalogues(r.read('strings.en.ts'), r.read('strings.fr.ts'));
  mainEdit?.(files);
  r.put(Object.fromEntries(files));
  r.git('add', '-A');
  r.git('commit', '-qm', 'split');
  r.git('checkout', '-q', 'feature');
  r.git('merge', '-q', '--no-edit', 'main');
  return r;
}

describe('migrate', () => {
  test('replays a branch edit onto the part main kept editing', () => {
    const r = diverge(
      { en: [single.en[0].replace("'Four'", "'Four, edited'"), single.en[1]], fr: single.fr },
      (files) => files.set('strings/en/alpha.ts', files.get('strings/en/alpha.ts')!.replace("'One'", "'One, from main'")),
    );
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD');
    expect(result.conflicts).toEqual([]);
    expect(result.written).toEqual([`${LIB}/strings/en/alpha.ts`]);
    expect(r.read('strings/en/alpha.ts')).toContain("one: 'One, from main',\n    two: 'Two',\n    three: 'Three',\n    four: 'Four, edited',");
    expect(r.read('strings.en.ts')).toContain("import { strings as beta } from './strings/en/beta';");
  });

  test('adds a part the branch created to both indexes, after its neighbour', () => {
    const gamma = { en: '  gamma: {\n    four: \'Four\',\n  },', fr: '  gamma: {\n    four: \'Quatre\',\n  },' };
    const r = diverge({ en: [single.en[0], gamma.en, single.en[1]], fr: [single.fr[0], gamma.fr, single.fr[1]] });
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD');
    expect(result.conflicts).toEqual([]);
    expect(r.read('strings/fr/gamma.ts')).toContain("four: 'Quatre'");
    expect(r.read('strings.en.ts')).toContain('  ...alpha,\n  ...gamma,\n  ...beta,');
    expect(r.read('strings.fr.ts')).toContain("from './strings/fr/alpha';\nimport { fr as gamma } from './strings/fr/gamma';");
  });

  test('deletes a part the branch removed when main left it alone', () => {
    const r = diverge({ en: [single.en[0]], fr: [single.fr[0]] });
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD');
    expect(result.deleted.sort()).toEqual([`${LIB}/strings/en/beta.ts`, `${LIB}/strings/fr/beta.ts`]);
    expect(existsSync(join(dir, LIB, 'strings/en/beta.ts'))).toBe(false);
    expect(r.read('strings.en.ts')).not.toContain('beta');
  });

  test('leaves conflict markers where both sides changed the same line', () => {
    const r = diverge(
      { en: [single.en[0].replace("'One'", "'One, branch'"), single.en[1]], fr: single.fr },
      (files) => files.set('strings/en/alpha.ts', files.get('strings/en/alpha.ts')!.replace("'One'", "'One, main'")),
    );
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD');
    expect(result.conflicts).toEqual([`${LIB}/strings/en/alpha.ts`]);
    expect(r.read('strings/en/alpha.ts')).toMatch(/<<<<<<< HEAD\n {4}one: 'One, branch',\n=======\n {4}one: 'One, main',\n>>>>>>> main/);
  });

  test('warns when the branch changed text outside the catalogue object', () => {
    const r = repo();
    r.git('checkout', '-qb', 'feature');
    r.put({ 'strings.en.ts': en(single.en.join('\n')).replace('/** header */', '/** new header */') });
    r.git('commit', '-qam', 'branch');
    r.git('checkout', '-q', 'main');
    r.put(Object.fromEntries(splitCatalogues(r.read('strings.en.ts'), r.read('strings.fr.ts'))));
    r.git('add', '-A');
    r.git('commit', '-qm', 'split');
    r.git('checkout', '-q', 'feature');
    r.git('merge', '-q', '--no-edit', 'main');
    expect(migrate(dir, 'HEAD', 'MERGE_HEAD').warnings).toEqual([expect.stringContaining('strings.en.ts: the branch changed text outside')]);
  });
});
