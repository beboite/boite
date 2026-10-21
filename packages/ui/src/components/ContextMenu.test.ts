import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ContextMenu from './ContextMenu.svelte';
import { contextMenu } from '../lib/context-menu.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  contextMenu.close();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}

test('a scroll beside the row a menu was opened on leaves it open, and one that moves the row closes it', async () => {
  running = mount(ContextMenu, { target: document.body }); await settle();
  const sidebar = document.body.appendChild(document.createElement('nav'));
  const row = sidebar.appendChild(document.createElement('div'));
  const timeline = document.body.appendChild(document.createElement('section'));
  row.addEventListener('contextmenu', event => contextMenu.open(event, [{ id: 'import', label: 'Import' }], () => {}));
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  await settle();
  expect(document.querySelector('[data-value=import]')).not.toBeNull();

  // The timeline settles after a view comes back, or follows a streaming answer.
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(contextMenu.current).not.toBeNull();

  sidebar.dispatchEvent(new Event('scroll'));
  await settle();
  expect(contextMenu.current).toBeNull();
});

test('ArrowRight opens a submenu from its row and ArrowLeft goes back from any row of it', async () => {
  running = mount(ContextMenu, { target: document.body }); await settle();
  const row = document.body.appendChild(document.createElement('div'));
  const picked: string[] = [];
  const main = [{ id: 'open', label: 'Open' }, { id: 'manage', label: 'Manage project', hint: '›', submenu: true }];
  const sub = [{ id: 'back', label: 'Back', back: true }, { id: 'archive', label: 'Archive' }];
  const pick = (id: string) => { picked.push(id); if (id === 'manage') contextMenu.follow(sub, pick); if (id === 'back') contextMenu.follow(main, pick); };
  row.addEventListener('contextmenu', event => contextMenu.open(event, main, pick));
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  await settle();
  const key = (name: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

  // On a row that opens nothing, ArrowRight does nothing.
  document.querySelector<HTMLElement>('[data-value=open]')!.focus();
  key('ArrowRight'); await settle();
  expect(picked).toEqual([]);
  document.querySelector<HTMLElement>('[data-value=manage]')!.focus();
  key('ArrowRight'); await settle();
  expect(picked).toEqual(['manage']);
  expect(document.querySelector('[data-value=archive]')).not.toBeNull();

  document.querySelector<HTMLElement>('[data-value=archive]')!.focus();
  key('ArrowLeft'); await settle();
  expect(picked).toEqual(['manage', 'back']);
  expect(document.querySelector('[data-value=manage]')).not.toBeNull();
});
