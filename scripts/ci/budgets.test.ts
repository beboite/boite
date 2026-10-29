import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyReason, ceiling, comparisonBase, entryChunk, judge, mainRun, measure, publishedCommits, type Sizes } from './budgets.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('finds the entry chunk vite writes, relative or absolute', () => {
  expect(entryChunk('<script type="module" crossorigin src="./assets/index-A1.js"></script>')).toBe('assets/index-A1.js');
  expect(entryChunk('<script type="module" crossorigin src="/assets/index-A1.js"></script>')).toBe('assets/index-A1.js');
  expect(() => entryChunk('<script>inline()</script>')).toThrow('no module script');
});

test('measures all emitted core JavaScript including workers and lazy chunks, excluding native binaries and maps', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-budgets-'));
  dirs.push(root);
  const ui = join(root, 'packages', 'ui', 'dist');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  const core = join(root, 'packages', 'core', 'dist');
  mkdirSync(join(core, 'workers'), { recursive: true });
  const html = '<script type="module" crossorigin src="./assets/index-A1.js"></script>';
  writeFileSync(join(ui, 'index.html'), html);
  writeFileSync(join(ui, 'assets', 'index-A1.js'), 'x'.repeat(100));
  writeFileSync(join(ui, 'assets', 'index-A1.js.br'), 'x'.repeat(40));
  writeFileSync(join(ui, 'assets', 'index-A1.js.gz'), 'x'.repeat(50));
  writeFileSync(join(ui, 'assets', 'lazy.js'), 'x'.repeat(30));
  writeFileSync(join(core, 'main.js'), 'x'.repeat(70));
  writeFileSync(join(core, 'lazy.js'), 'x'.repeat(130));
  writeFileSync(join(core, 'workers', 'jobs-worker.js'), 'x'.repeat(15));
  writeFileSync(join(core, 'workers', 'guard-worker.js'), 'x'.repeat(25));
  writeFileSync(join(core, 'main.js.map'), 'x'.repeat(300));
  writeFileSync(join(core, 'boite-core.exe'), 'x'.repeat(10_000));
  expect(measure(root)).toEqual({ uiEntryChunk: 100, uiDist: html.length + 130, coreBundle: 70, coreJavaScript: 240 });
});

const base: Sizes = { uiEntryChunk: 500_000, uiDist: 5_000_000, coreBundle: 1_000_000, coreJavaScript: 4_000_000 };
const reference = { sizes: base, source: '`a1b2c3d4` (main bundle-sizes artifact)' };

test('growth up to 0.1 % passes without a reason, more needs one in the body', () => {
  expect(judge({ ...base, uiDist: base.uiDist + 5_000 }, reference, undefined, undefined).errors).toEqual([]);
  const grown = { ...base, uiEntryChunk: base.uiEntryChunk + 501, coreBundle: base.coreBundle - 10_000 };
  const [error, ...rest] = judge(grown, reference, undefined, undefined).errors;
  expect(rest).toEqual([]);
  expect(error).toContain('uiEntryChunk +501 bytes (0.10 %) over `a1b2c3d4` (main bundle-sizes artifact)');
  expect(error).toContain('"## Bundle size" heading in the pull request body');
  expect(error).not.toContain('coreBundle');
  expect(judge(grown, reference, undefined, 'the palette strings load with the entry').errors).toEqual([]);
});

test('the ceiling is the published build plus 2 %, and a reason does not lift it', () => {
  const limit = { sizes: ceiling(base), source: 'v2.0.0-nightly.20261018.2 at `0011aabb`' };
  expect(limit.sizes).toEqual({ uiEntryChunk: 510_000, uiDist: 5_100_000, coreBundle: 1_020_000, coreJavaScript: 4_080_000 });
  expect(judge({ ...base, uiDist: 5_100_000 }, reference, limit, 'reason').errors).toEqual([]);
  expect(judge({ ...base, uiDist: 5_100_001 }, reference, limit, 'reason').errors).toEqual([
    'uiDist: 5,100,001 bytes, above its 5,100,000-byte ceiling (v2.0.0-nightly.20261018.2 at `0011aabb` plus 2 %). Shrink the change; the ceiling rises only when a nightly or a release is published.',
  ]);
});

test('a pull request over a main already above the ceiling fails only for the growth it adds', () => {
  const limit = { sizes: ceiling(base), source: 'v2.0.0-nightly.20261018.2 at `0011aabb`' };
  // Main grew past the published ceiling after the last nightly; the pull request changes nothing it measures.
  const indebted = { sizes: { ...base, uiDist: 5_100_300 }, source: '`c3d4e5f6` (main bundle-sizes artifact)' };
  for (const head of [indebted.sizes, { ...indebted.sizes, uiDist: 5_100_200 }]) {
    const verdict = judge(head, indebted, limit, undefined);
    expect(verdict.errors).toEqual([]);
    expect(verdict.report).toContain(`uiDist: ${(head.uiDist).toLocaleString('en-US')} bytes, ${(head.uiDist - 5_100_000).toLocaleString('en-US')} above the 5,100,000-byte ceiling, carried from \`c3d4e5f6\` (main bundle-sizes artifact)`);
  }
  expect(judge({ ...indebted.sizes, uiDist: 5_100_301 }, indebted, limit, 'reason').errors).toEqual([
    'uiDist: 5,100,301 bytes, 1 more than `c3d4e5f6` (main bundle-sizes artifact), which is already above its 5,100,000-byte ceiling (v2.0.0-nightly.20261018.2 at `0011aabb` plus 2 %). Shrink the change; the ceiling rises only when a nightly or a release is published.',
  ]);
  // Main's own check has no base: the whole debt fails there.
  expect(judge(indebted.sizes, undefined, limit, undefined).errors).toEqual([
    'uiDist: 5,100,300 bytes, above its 5,100,000-byte ceiling (v2.0.0-nightly.20261018.2 at `0011aabb` plus 2 %). Shrink the change; the ceiling rises only when a nightly or a release is published.',
  ]);
});

test('reads the reason under a Bundle size heading, ignoring comments and empty sections', () => {
  expect(bodyReason('## What changed\n\nx\n\n## Bundle size\n\nThe new card adds 3 KB to the settings chunk.\n\n## Verification\n\nok')).toBe('The new card adds 3 KB to the settings chunk.');
  expect(bodyReason('### bundle size\r\nlazy chunk only')).toBe('lazy chunk only');
  expect(bodyReason('## Bundle size\n\n<!-- Explain growth above 0.1 %. -->\n\n## Verification')).toBeUndefined();
  expect(bodyReason('Bundle size grows, see below')).toBeUndefined();
  expect(bodyReason(null)).toBeUndefined();
  // A comment split by another, or never closed, leaves no `<!--` behind.
  expect(bodyReason('## Bundle size\n<!<!-- x -->-- hidden -->kept')).toBe('kept');
  expect(bodyReason('## Bundle size\nkept <!-- never closed\n## Verification')).toBe('kept');
  const verdict = judge({ ...base, uiEntryChunk: base.uiEntryChunk + 600 }, reference, undefined, '<img src=x onerror=alert(1)> & co');
  expect(verdict.report).toContain('&#60;img src=x onerror=alert(1)&#62; &#38; co');
  expect(verdict.report).not.toContain('<img');
});

test('takes measurements only from a bundle size push run on main of this repository', () => {
  const sha = 'a'.repeat(40);
  const ci = { id: 1, path: '.github/workflows/bundle-size.yml', head_sha: sha, head_branch: 'main', event: 'push', repository: { id: 7 }, head_repository: { id: 7 } };
  expect(mainRun([{ ...ci, id: 2, event: 'pull_request' }, { ...ci, id: 3, path: '.github/workflows/ci.yml' }, { ...ci, id: 4, head_repository: { id: 8 } }, ci], sha)?.id).toBe(1);
  expect(mainRun([{ ...ci, head_branch: 'feature' }], sha)).toBeUndefined();
});

test('the ceiling follows the newest published release, drafts and branch targets left out', () => {
  const release = (tag: string, published_at: string | null, target = tag.at(-1)!.repeat(40), draft = false) => ({ tag_name: tag, published_at, target_commitish: target, draft });
  expect(publishedCommits([
    release('v1', '2026-10-17T00:00:00Z'),
    release('v2', '2026-10-18T00:00:00Z'),
    release('v3', null, 'c'.repeat(40), true),
    release('v4', '2026-10-19T00:00:00Z', 'main'),
  ])).toEqual([{ tag: 'v2', sha: '2'.repeat(40) }, { tag: 'v1', sha: '1'.repeat(40) }]);
});

test('a pull request is compared with the main commit its merge ref was built on, not its stale base', () => {
  // #665 branched at 184e63a7; its merge ref sat on 156e44cf, whose UI growth was blamed on it (run 39319378723).
  const branchPoint = '184e63a7babb243849a6c3bff5ecdf2404af2f4f';
  const main = '156e44cf'.padEnd(40, '0');
  const commit = (...parents: string[]) => [`tree ${'1'.repeat(40)}`, ...parents.map((sha) => `parent ${sha}`), 'author A <a@b> 1 +0000', '', 'parent of nothing', ''].join('\n');
  expect(comparisonBase(commit(main, '8e2f74eb'.padEnd(40, '0')), branchPoint)).toBe(main);
  // A checkout that is not a merge ref keeps the pull request's base; the message is not read.
  expect(comparisonBase(commit(main), branchPoint)).toBe(branchPoint);
});
