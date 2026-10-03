/*
 * A paired phone reads a thread's changes and files, and writes nothing: the
 * Changes list then one diff at a time with steps between files, a file as
 * wrapped read-only lines, and no Save. The fake client holds the same gate as
 * the core, so a call the phone must not make would fail here too.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { rightPanel } from '../lib/right-panel.svelte';
import { Store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import RightPanel from './RightPanel.svelte';

let app: ReturnType<typeof mount> | undefined, store: Store;
const clients: FakeClient[] = [];
const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
const query = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const button = (id: string) => query<HTMLButtonElement>(`[data-testid=${id}]`)!;

beforeEach(() => {
  localStorage.clear(); rightPanel.load(); work.load(); work.setPanel('launcher');
});

afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks(); document.body.innerHTML = '';
  localStorage.clear(); rightPanel.load(); work.load();
});

async function phone(width: number): Promise<FakeClient> {
  // jsdom lays nothing out: the panel is as wide as the test says.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  const client = new FakeClient({ delayMs: 0, principal: 'session' }); clients.push(client);
  store = new Store(); store.attach(client); await store.connect();
  await store.open('t-trace');
  store.panel.closeAll();
  app = mount(RightPanel, { target: document.body, props: { store, panel: store.panel, attach: () => ({ destroy() {} }), onexit() {} } });
  await settle();
  return client;
}

test('a phone walks the changes one diff at a time, against HEAD only', async () => {
  const client = await phone(390);
  const calls = vi.spyOn(client, 'call');
  expect(store.owner).toBe(false);
  button('launch-changes').click(); await settle();
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid=changes-row]'));
  expect(rows.length).toBe(7);
  expect(query('[data-testid=changes-pager]')).toBeNull();

  rows[0]!.click(); await settle();
  const panel = query('[data-testid=changes-panel]')!;
  expect(panel.classList.contains('reading')).toBe(true);
  expect(query('[data-testid=diff-view]')?.getAttribute('data-path')).toBe(rows[0]!.dataset.path);
  expect(query('[data-testid=changes-position]')?.textContent).toBe('1 of 7');
  expect(button('changes-previous').disabled).toBe(true);

  button('changes-next').click(); await settle();
  expect(store.panel.active?.path).toBe(rows[1]!.dataset.path);
  expect(query('[data-testid=changes-position]')?.textContent).toBe('2 of 7');
  button('changes-previous').click(); await settle();
  expect(store.panel.active?.path).toBe(rows[0]!.dataset.path);

  button('changes-back').click(); await settle();
  expect(store.panel.active?.path).toBeUndefined();
  expect(panel.classList.contains('reading')).toBe(false);
  expect(query('[data-testid=changes-pager]')).toBeNull();

  const diffs = calls.mock.calls.filter(([method]) => method === 'git.diff');
  expect(diffs.length).toBeGreaterThan(0);
  for (const [, params] of diffs) expect((params as { ref?: string }).ref).toBeUndefined();
});

test('a wide panel keeps the list beside the diff, with no pager', async () => {
  await phone(1000);
  button('launch-changes').click(); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=changes-row]')!.click(); await settle();
  expect(query('[data-testid=diff-view]')).not.toBeNull();
  expect(query('[data-testid=changes-pager]')).toBeNull();
  expect(query('[data-testid=changes-panel]')!.classList.contains('narrow')).toBe(false);
});

test('a phone reads a file as wrapped lines and is offered no save', async () => {
  const client = await phone(390);
  button('launch-files').click(); await settle();
  expect(document.querySelectorAll('[data-testid=files-row]').length).toBeGreaterThan(0);
  store.panel.openFile('src/components/RightPanel.svelte', 2); await settle();
  expect(query('[data-testid=file-lines]')).not.toBeNull();
  expect(query('[data-testid=file-text]')).toBeNull();
  expect(query('[data-testid=file-save]')).toBeNull();
  expect(query('[data-testid=file-readonly]')).not.toBeNull();
  expect(query('[data-testid=file-line][data-line="2"]')?.classList.contains('on')).toBe(true);
  // And the gate behind the hidden button holds on its own.
  await expect(client.call('files.write', { threadId: 't-trace', path: 'src/components/RightPanel.svelte', text: 'x' })).rejects.toThrow('files.write is for the owner only');
  await expect(client.call('git.diff', { threadId: 't-trace', path: 'src/components/RightPanel.svelte', ref: 'HEAD~1' })).rejects.toThrow('HEAD only');
  await expect(client.call('files.read', { threadId: 't-trace', path: '../outside.txt' })).rejects.toThrow();
});

test('tasks stay the owner\'s on a phone', async () => {
  await phone(390);
  expect(button('launch-tasks').disabled).toBe(true);
  expect(button('launch-changes').disabled).toBe(false);
  expect(button('launch-files').disabled).toBe(false);
});
