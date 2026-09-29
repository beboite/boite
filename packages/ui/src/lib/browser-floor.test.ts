import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { tooNewForFloor } from './browser-floor';

// Vitest runs from packages/ui, like service-worker.test.ts.
const SRC = resolve('src');

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) return name === 'fake-client' ? [] : sources(full);
    // Tests and the dev-only fake client never reach a built page.
    if (/\.test\.ts$|^fake-/.test(name)) return [];
    return /\.(?:ts|js|svelte)$/.test(name) ? [full] : [];
  });
}

test('the check names a lookbehind and a copying array method', () => {
  expect(tooNewForFloor('a.split(/(?<=\\n)/)')).toHaveLength(1);
  expect(tooNewForFloor('/(?<!x)y/')).toHaveLength(1);
  expect(tooNewForFloor('xs.toSorted((a, b) => a - b); ys.toReversed()')).toHaveLength(2);
  // A named group is fine on Safari 15.4.
  expect(tooNewForFloor('/(?<year>\\d{4})/.exec(s)')).toEqual([]);
});

test('no UI source uses what Safari 15.4 cannot run', () => {
  const offenders = sources(SRC).flatMap((file) => tooNewForFloor(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}: ${hit}`));
  expect(offenders).toEqual([]);
});
