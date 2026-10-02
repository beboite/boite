import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Prose from './Prose.svelte';
import type { Store } from '../lib/store.svelte';
import { writeExperiments } from '../lib/experiments';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  writeExperiments([]);
  delete window.__TAURI_INTERNALS__;
});

test('clicking a local executable opens the original file without downloading or previewing it', async () => {
  writeExperiments(['chat-artifacts']);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }], readFile: vi.fn() } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Launch game](target/release/game.exe)', store, threadId: 'game' } });
  flushSync();
  expect(invoke).not.toHaveBeenCalled();
  query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_local_file', { directory: 'C:/project', path: 'target/release/game.exe' }, undefined));
  expect(store.readFile).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid=chat-file]')).toBeNull();
});

test('a native open failure is shown and never falls back to downloading', async () => {
  writeExperiments(['chat-artifacts']);
  const invoke = vi.fn(async () => { throw 'game.exe: file does not exist'; });
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }], error: null } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Launch game](game.exe)', store, threadId: 'game' } });
  flushSync();
  query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(store.error).toBe('game.exe: file does not exist'));
  expect(document.querySelector('[data-testid=artifact-download]')).toBeNull();
});

test('a local file can still open when its preview cannot be read', async () => {
  writeExperiments(['chat-artifacts']);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = {
    owner: true, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }],
    readFile: vi.fn(async () => ({ ok: false, error: 'Preview could not be read' })),
  } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Manual](manual.pdf)', store, threadId: 'game' } });
  flushSync();
  query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(document.querySelector('[role=alert] p')?.textContent).toBe('Preview could not be read'));
  query<HTMLButtonElement>('[role=alert] button').click();
  await vi.waitFor(() => expect(store.readFile).toHaveBeenCalledTimes(2));
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid=artifact-download]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=artifact-open]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_local_file', { directory: 'C:/project', path: 'manual.pdf' }, undefined));
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

test('the direct-link experiment opens a desktop shortcut and text outside the checkout only on a click', async () => {
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, localCore: true, threads: [{ id: 'local', cwd: 'E:/project' }], readFile: vi.fn() } as unknown as Store;
  running = mount(Prose, { target: document.body, props: {
    text: '[Test](</C:/Users/Chris/Desktop/Boite - Test medias.lnk>) [Notes](file:///E:/reports/test%20result.txt)', store, threadId: 'local',
  } });
  flushSync();
  expect(document.querySelector('a[data-file-path]')).toBeNull();
  writeExperiments(['open-chat-links']); flushSync();
  expect(invoke).not.toHaveBeenCalled();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[data-file-path]');
  links[0]!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_file', { directory: 'E:/project', path: 'C:/Users/Chris/Desktop/Boite - Test medias.lnk' }, undefined));
  await tick(); links[1]!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_file', { directory: 'E:/project', path: 'E:/reports/test result.txt' }, undefined));
  expect(store.readFile).not.toHaveBeenCalled();
  writeExperiments([]); flushSync();
  expect(document.querySelector('a[data-file-path]')).toBeNull();
});

test('a remote machine file is never opened by the desktop experiment', async () => {
  writeExperiments(['open-chat-links']);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const readFile = vi.fn(async () => ({ ok: false, error: 'Remote file unavailable' }));
  const store = { owner: true, localCore: false, threads: [{ id: 'remote', cwd: 'C:/project' }], readFile } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Notes](report.txt)', store, threadId: 'remote' } });
  flushSync(); query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith('remote', 'report.txt'));
  expect(invoke).not.toHaveBeenCalled();
});

test('a fenced block carries a copy button that writes the code to the clipboard', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  running = mount(Prose, {
    target: document.body,
    props: { text: 'Run it:\n\n```sh\nbun run --cwd packages/ui test\n```\n' }
  });
  flushSync();
  await tick();

  // One button per fenced block, inside the wrapper the effect hangs around it.
  const button = query<HTMLButtonElement>('[data-testid=code-copy]');
  expect(button.parentElement?.classList.contains('code-block')).toBe(true);
  expect(document.querySelectorAll('[data-testid=code-copy]')).toHaveLength(1);
  expect(button.textContent).toBe('Copy');

  button.click();
  await tick();
  await tick();

  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0]?.[0]).toContain('bun run --cwd packages/ui test');
  expect(button.textContent).toBe('Copied');

  // The label goes back on the way out, so nothing has to time it.
  button.dispatchEvent(new Event('pointerleave'));
  expect(button.textContent).toBe('Copy');
});

test('a block that is still being written carries no button yet', async () => {
  // The pass that hangs them walks every block of the answer, and it ran every
  // 48 ms while the part streamed, for a button on code nobody can copy yet.
  running = mount(Prose, {
    target: document.body,
    props: { text: 'Run it:\n\n```sh\nbun run --cwd packages/ui te', live: true }
  });
  flushSync();
  // An unfinished fenced block stays buffered while the complete paragraph is visible.
  await new Promise((resolve) => setTimeout(resolve, 120));
  flushSync();
  await tick();

  expect(document.querySelector('pre')).toBeNull();
  expect(query('[data-testid=text-part]').textContent).toContain('Run it:');
  expect(document.querySelector('[data-testid=code-copy]')).toBeNull();
});

test('text with no fenced block gets no button', async () => {
  running = mount(Prose, { target: document.body, props: { text: 'Plain `inline` text only.' } });
  flushSync();
  await tick();

  expect(document.querySelector('[data-testid=code-copy]')).toBeNull();
});
