import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { TECH_ICON_IDS, type Project } from '@boite/contracts';
import ProjectTile from './ProjectTile.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { techGlyphs } from '../lib/tech-icons';

let running: Record<string, unknown> | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}

async function seeded(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  cleanups.push(() => { store.detach(); client.close(); });
  return { store, client };
}

function draw(store: Store, project: Project, size?: number) {
  running = mount(ProjectTile, { target: document.body, props: { store, project, ...(size ? { size } : {}) } });
  flushSync();
}

const tile = () => document.querySelector<HTMLElement>('[data-testid=project-tile]')!;

test('a project whose folder had a logo draws it, fetched once for its version', async () => {
  const { store, client } = await seeded();
  const asked = vi.spyOn(client, 'call');
  const boite = store.projects.find((p) => p.id === 'p-boite')!;
  expect(boite.icon).toMatchObject({ kind: 'image' });
  draw(store, boite);
  // The initial stands until the bytes land.
  expect(tile().dataset['kind']).toBe('letter');
  await settle();
  expect(tile().dataset['kind']).toBe('image');
  expect(tile().querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);

  // A second tile of the same project, the sidebar and the phone's menu at once, asks nothing more.
  unmount(running!, { outro: false });
  draw(store, boite, 18);
  await settle();
  expect(tile().dataset['kind']).toBe('image');
  expect(asked.mock.calls.filter(([method]) => method === 'projects.icon')).toHaveLength(1);
});

test('an answer for a newer version than the list named still draws, and is asked for once', async () => {
  const { store, client } = await seeded();
  const asked = vi.spyOn(client, 'call');
  const boite = store.projects.find((p) => p.id === 'p-boite')!;
  draw(store, { ...boite, icon: { kind: 'image', version: 'older' } });
  await settle();
  await settle();
  expect(tile().dataset['kind']).toBe('image');
  expect(asked.mock.calls.filter(([method]) => method === 'projects.icon')).toHaveLength(1);
});

test("a project with no logo draws its stack's mark, a black or white one in the foreground colour", async () => {
  const { store } = await seeded();
  const notes = store.projects.find((p) => p.id === 'p-notes')!;
  draw(store, notes);
  // The marks are their own chunk: the initial until it lands.
  await vi.waitFor(() => expect(tile().dataset['tech']).toBe('python'));
  const path = tile().querySelector('path');
  expect(path?.getAttribute('d')).toBe(techGlyphs.python.path);
  expect(path?.getAttribute('fill')).toBe(techGlyphs.python.hex);

  unmount(running!, { outro: false });
  draw(store, { ...notes, icon: { kind: 'tech', id: 'rust' } });
  expect(tile().querySelector('path')?.getAttribute('fill')).toBe('currentColor');
});

test('nothing detected, a stack this UI does not know, or an image that cannot be fetched: the initial', async () => {
  const { store } = await seeded();
  const notes = store.projects.find((p) => p.id === 'p-notes')!;
  const { icon: _icon, ...bare } = notes;
  draw(store, bare);
  expect(tile().dataset['kind']).toBe('letter');
  expect(tile().textContent).toBe('N');

  unmount(running!, { outro: false });
  draw(store, { ...notes, icon: { kind: 'tech', id: 'cobol' as never } });
  await settle();
  expect(tile().dataset['kind']).toBe('letter');

  // The core refuses: this project holds no image, whatever an old answer said.
  unmount(running!, { outro: false });
  draw(store, { ...notes, icon: { kind: 'image', version: 'stale' } });
  await settle();
  expect(tile().dataset['kind']).toBe('letter');
});

test('every stack a core can name has a mark', () => {
  for (const id of TECH_ICON_IDS) expect(techGlyphs[id]?.path.length, id).toBeGreaterThan(20);
});
