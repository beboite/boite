import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cycles, dependencyGraph } from './graph.ts';
import { languageOf, readInventory, ROOTS } from './inventory.ts';
import { sizeViolations } from './size.ts';

test('the native shell and the Android code are production sources; their tests are not', () => {
  expect(languageOf('apps/shell/src-tauri/src/browser.rs')).toEqual({ language: 'Rust', imports: false });
  expect(languageOf('apps/android-server/termux/boite-server.ts')).toEqual({ language: 'TypeScript', imports: true });
  expect(languageOf('apps/android-server/app/src/main/java/com/boite/server/App.kt')).toEqual({ language: 'Kotlin', imports: false });
  expect(languageOf('packages/ui/src/components/Panel.svelte')).toEqual({ language: 'Svelte', imports: true });
  for (const file of ['apps/android-server/termux/boite-server.test.ts', 'apps/shell/src-tauri/src/local_core/tests.rs', 'packages/ui/src/env.d.ts', 'packages/ui/src/app.css']) {
    expect(languageOf(file)).toBeUndefined();
  }
  expect(ROOTS).toEqual(expect.arrayContaining(['apps/shell/src-tauri/src', 'apps/android-server/termux']));
});

test('an oversized controller or shell file fails the size check, and a component cycle the graph', () => {
  const base = mkdtempSync(join(tmpdir(), 'boite-architecture-'));
  try {
    const write = (file: string, source: string) => {
      mkdirSync(dirname(join(base, file)), { recursive: true });
      writeFileSync(join(base, file), source);
    };
    const long = 'line\n'.repeat(901);
    write('apps/android-server/termux/boite-server.ts', long);
    write('apps/android-server/termux/boite-server.test.ts', long);
    write('apps/shell/src-tauri/src/browser.rs', long);
    write('packages/ui/src/lib/open.ts', "export const open = () => import('../components/Panel.svelte');");
    write('packages/ui/src/components/Panel.svelte', "<script lang=\"ts\">import { open } from '../lib/open';</script><button onclick={open}>open</button>");
    const inventory = readInventory(base, ['apps/android-server/termux', 'apps/shell/src-tauri/src', 'packages/ui/src']);
    expect(sizeViolations(inventory.lines, { ceiling: 900, allow: {} })).toEqual([
      'apps/android-server/termux/boite-server.ts: 901 lines, above the 900-line ceiling; split it',
      'apps/shell/src-tauri/src/browser.rs: 901 lines, above the 900-line ceiling; split it',
    ]);
    expect([...inventory.sources.keys()]).not.toContain('apps/shell/src-tauri/src/browser.rs');
    expect(cycles(dependencyGraph(inventory.sources))).toEqual([
      'packages/ui/src/components/Panel.svelte -> packages/ui/src/lib/open.ts -> packages/ui/src/components/Panel.svelte',
    ]);
    expect(Object.fromEntries(inventory.languages)).toEqual({ TypeScript: 2, Rust: 1, Svelte: 1 });
    expect(() => readInventory(base, ['apps/missing'])).toThrow('ENOENT');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
