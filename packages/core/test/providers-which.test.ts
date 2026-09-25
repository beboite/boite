import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/providers/loader.ts';
import { forgetWhich, which } from '../src/providers/which.ts';

let dataDir: string;
let asked: string[];
const original = Bun.which;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'boite-which-'));
  asked = [];
  forgetWhich();
  (Bun as { which: typeof Bun.which }).which = ((name: string, options?: Parameters<typeof Bun.which>[1]) => {
    asked.push(name);
    return original(name, options);
  }) as typeof Bun.which;
});

afterEach(() => {
  (Bun as { which: typeof Bun.which }).which = original;
  forgetWhich();
  rmSync(dataDir, { recursive: true, force: true });
});

test('listing providers again right away scans PATH once, and a reload looks again', () => {
  const registry = new ProviderRegistry(dataDir);
  // The core's start: the registry loads, then the default accounts list the available ones.
  registry.available();
  const first = asked.length;
  expect(first).toBeGreaterThan(0);
  // A client's boot lists them too.
  registry.list();
  registry.list();
  expect(asked.length).toBe(first);

  // Something the user installed outside Boite: the Providers page reloads.
  registry.load();
  expect(asked.length).toBeGreaterThan(first);
});

test('an answer is kept two seconds, then looked up again', () => {
  const at = 1_000_000;
  const found = which('bun', at);
  expect(found).toBe(original('bun'));
  expect(which('bun', at + 1_500)).toBe(found);
  expect(asked).toEqual(['bun']);
  expect(which('bun', at + 2_500)).toBe(found);
  expect(asked).toEqual(['bun', 'bun']);
  expect(which('no-such-program-boite', at + 2_500)).toBeNull();
  expect(which('no-such-program-boite', at + 2_600)).toBeNull();
  expect(asked).toEqual(['bun', 'bun', 'no-such-program-boite']);
});
