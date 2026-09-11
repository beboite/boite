import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FileIndex, ignoredNames, rankFiles, scorePath, walkFiles } from '../src/files.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/** A small tree under the test data directory: sources, a build output, a git dir, dependencies. */
function plantTree(root: string): void {
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'coverage'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(root, 'src', 'lib', 'store.ts'), 'export {};\n');
  writeFileSync(join(root, 'src', 'lib', 'strings.ts'), 'export {};\n');
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, 'dist', 'app.js'), '');
  writeFileSync(join(root, 'coverage', 'lcov.info'), '');
  writeFileSync(join(root, '.gitignore'), '# build\ndist/\n/coverage\n*.log\n!keep.log\nsrc/lib/*.tmp\n');
}

describe('the file index', () => {
  test('a root .gitignore skips the plain names it lists, never a glob or a negation', () => {
    const names = ignoredNames('# build\ndist/\n/coverage\n*.log\n!keep.log\nsrc/lib/*.tmp\n\n  target  \n');
    expect([...names].sort()).toEqual(['coverage', 'dist', 'target']);
  });

  test('the walk leaves out .git, node_modules and the ignored names, and names the rest with slashes', async () => {
    const root = join(harness.dataDir, 'tree');
    plantTree(root);
    const walk = await walkFiles(root);
    expect(walk.capped).toBe(false);
    expect(walk.files.sort()).toEqual(['.gitignore', 'README.md', 'src/app.ts', 'src/lib/store.ts', 'src/lib/strings.ts']);
  });

  test('the walk stops at the cap and says so', async () => {
    const root = join(harness.dataDir, 'tree');
    plantTree(root);
    const walk = await walkFiles(root, 2);
    expect(walk.capped).toBe(true);
    expect(walk.files).toHaveLength(2);
  });

  test('a file name beats a directory in the ranking, and a query needs every word', () => {
    expect(scorePath('store', 'src/lib/store.ts')).toBe(80);
    expect(scorePath('store.ts', 'src/lib/store.ts')).toBe(100);
    expect(scorePath('lib', 'src/lib/store.ts')).toBe(40);
    expect(scorePath('sls', 'src/lib/store.ts')).toBe(20);
    expect(scorePath('lib nope', 'src/lib/store.ts')).toBe(0);
    expect(scorePath('', 'anything')).toBe(1);

    const page = rankFiles('str', { files: ['src/lib/strings.ts', 'src/lib/store.ts', 'README.md', 'docs/structure.md'], capped: false }, 2);
    // Two names start with the query and the shorter path goes first; `store.ts`
    // only carries the letters in order, so it is third and off the page.
    expect(page.files).toEqual(['docs/structure.md', 'src/lib/strings.ts']);
    expect(page.total).toBe(3);
  });

  test('one walk serves the letters of a query for a few seconds, then a fresh one', async () => {
    const root = join(harness.dataDir, 'tree');
    plantTree(root);
    let clock = 1_000;
    const index = new FileIndex(() => clock);
    expect((await index.list(root, 'app')).files).toEqual(['src/app.ts']);
    writeFileSync(join(root, 'src', 'apple.ts'), '');
    // Still the held walk: the new file is not there yet.
    expect((await index.list(root, 'app')).files).toEqual(['src/app.ts']);
    clock += 10_000;
    expect((await index.list(root, 'app')).files).toEqual(['src/app.ts', 'src/apple.ts']);
  });

  test('projects.files ranks a project tree over rpc and refuses an unknown project', async () => {
    const client = await harness.connect();
    const root = join(harness.dataDir, 'tree');
    plantTree(root);
    const project = await client.call('projects.add', { path: root, name: 'tree' });
    const page = await client.call('projects.files', { projectId: project.id, query: 'st', limit: 1 });
    // `app.ts` carries an s then a t, so it is a weak third match.
    expect(page).toEqual({ files: ['src/lib/store.ts'], total: 3, capped: false });
    const all = await client.call('projects.files', { projectId: project.id, query: '' });
    expect(all.total).toBe(5);
    expect(all.files).toContain('README.md');
    expect(all.files).not.toContain('dist/app.js');

    let failure = 'none';
    try {
      await client.call('projects.files', { projectId: 'prj_nope', query: '' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('unknown project prj_nope');
  });
});
