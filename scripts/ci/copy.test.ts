import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyViolations } from './copy.ts';

test('copy lint names nested sentences and array entries, including a bare dash', () => {
  expect(copyViolations({ chat: { hint: 'Ready\u2014go', steps: ['Wait', '\u2014'] } })).toEqual([
    'chat.hint: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence',
    'chat.steps.1: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence',
  ]);
  expect(copyViolations({ hint: 'Ready: go', steps: ['Wait, then go.', 'A-B'], count: 2, empty: null })).toEqual([]);
});

test('copy-producing functions are checked without calling them', () => {
  const neverCall = () => { throw new Error('copy lint must not execute functions'); };
  expect(copyViolations({ count: (n: number) => `${n}\u2014ready`, escaped: () => '\u{2014}', safe: neverCall })).toEqual([
    'count: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence',
    'escaped: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence',
  ]);
});

test('formatter escapes respect backslash parity instead of flagging literal Unicode notation', () => {
  expect(copyViolations({
    literal: () => '\\u2014',
    braced: () => '\\u{2014}',
    pairs: () => '\\\\u2014',
    plain: '\\u2014',
  })).toEqual([]);
  // A pair of escaped backslashes before a real Unicode escape still produces a dash.
  expect(copyViolations({ odd: () => '\\\u2014' })).toEqual([
    'odd: no-em-dash-copy: replace U+2014 with a comma, colon or separate sentence',
  ]);
});

test('the CLI checks English and every translation, including escaped copy in an imported part', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-copy-'));
  const dir = join(root, 'packages/ui/src/lib');
  const run = () => Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'copy.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'strings.en.ts'), "export const strings = { chat: { hint: 'Ready: go' } };\n");
    writeFileSync(join(dir, 'strings.fr.ts'), "export const fr = { chat: { hint: 'Prêt, partez' } };\n");
    expect(run().exitCode).toBe(0);
    writeFileSync(join(dir, 'part.ts'), "export const chat = { hint: 'Ready\\u2014go' };\n");
    writeFileSync(join(dir, 'strings.en.ts'), "import { chat } from './part.ts'; export const strings = { chat };\n");
    // An incomplete extra language must still have its own copy checked.
    writeFileSync(join(dir, 'strings.es.ts'), "export const es = { steps: ['Espera', '\\u{2014}'] };\n");
    const failed = run();
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain('strings.en.ts: chat.hint: no-em-dash-copy');
    expect(failed.stderr.toString()).toContain('strings.es.ts: steps.1: no-em-dash-copy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
