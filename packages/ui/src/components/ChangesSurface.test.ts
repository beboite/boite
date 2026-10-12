import { expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { GitDiff, GitStatus } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import ChangesSurface from './ChangesSurface.svelte';

const PATH = 'src/components/RightPanel.svelte';

/** Holds every git read until the test lets it through, so the order of the requests can be seen. */
function gate(store: Store) {
  const held: { kind: 'status' | 'diff'; release: () => void }[] = [];
  const realStatus = store.gitStatus.bind(store);
  const realDiff = store.gitDiff.bind(store);
  store.gitStatus = (id) =>
    new Promise<GitStatus | null>((resolve) => held.push({ kind: 'status', release: () => resolve(realStatus(id)) }));
  store.gitDiff = (id, path) =>
    new Promise<GitDiff | null>((resolve) => held.push({ kind: 'diff', release: () => resolve(realDiff(id, path)) }));
  return {
    pending: () => held.map((one) => one.kind),
    async releaseAll() {
      for (const one of held.splice(0)) one.release();
      for (let round = 0; round < 10; round++) await new Promise((done) => setTimeout(done, 0));
      flushSync();
    }
  };
}

function detail(): string {
  return document.querySelector('.detail')?.textContent ?? '';
}

test('a refresh reads the diff beside the status and keeps the old diff on screen until the new one lands', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  let component;
  try {
    await store.connect();
    await store.open('t-trace');
    const reads = gate(store);
    const surface: Surface = { id: 'changes', kind: 'changes', path: PATH };
    const panel = { update() {} } as unknown as BoundPanel;
    component = mount(ChangesSurface, { target: document.body, props: { store, surface, panel } });
    flushSync();
    // Both reads leave together: the diff never waits for the status to answer.
    expect(reads.pending().sort()).toEqual(['diff', 'status']);
    await reads.releaseAll();
    expect(document.querySelector('[data-testid=diff-view]')?.getAttribute('data-path')).toBe(PATH);

    document.querySelector<HTMLButtonElement>('[data-testid=changes-refresh]')!.click();
    flushSync();
    expect(reads.pending().sort()).toEqual(['diff', 'status']);
    // While both are out, the diff already read stays: no blank flash.
    expect(document.querySelector('[data-testid=diff-view]')).not.toBeNull();
    expect(detail()).not.toContain(strings.changes.loading);
    await reads.releaseAll();
    expect(document.querySelector('[data-testid=diff-view]')?.getAttribute('data-path')).toBe(PATH);

    // Another thread starts from an empty list, not the previous thread's files.
    expect(document.querySelectorAll('[data-testid=changes-row]').length).toBeGreaterThan(0);
    await store.open('t-scheduler');
    flushSync();
    expect(document.querySelectorAll('[data-testid=changes-row]')).toHaveLength(0);
    expect(document.querySelector('[data-testid=changes-count]')?.textContent).toContain(strings.changes.loading);
    expect(document.querySelector('[data-testid=diff-view]')).toBeNull();
    await reads.releaseAll();
    expect(document.querySelectorAll('[data-testid=changes-row]').length).toBeGreaterThan(0);
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = '';
  }
});
