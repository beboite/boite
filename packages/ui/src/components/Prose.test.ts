import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Prose from './Prose.svelte';
import type { Store } from '../lib/store.svelte';
import { resetFeatures, setFeature } from '../lib/features';
import { installExternalLinks } from '../lib/links';
import { contextMenu } from '../lib/context-menu.svelte';

/** `files.locate` for a file that is there as written. */
const asWritten = async (_threadId: string, path: string) => ({ ok: true, value: [path] });

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  resetFeatures();
  delete window.__TAURI_INTERNALS__;
});

test('clicking a local executable opens the original file without downloading or previewing it', async () => {
  setFeature('chat-artifacts', true);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, locateFile: asWritten, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }], readFile: vi.fn() } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Launch game](target/release/game.exe)', store, threadId: 'game' } });
  flushSync();
  expect(invoke).not.toHaveBeenCalled();
  query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_local_file', { directory: 'C:/project', path: 'target/release/game.exe' }, undefined));
  expect(store.readFile).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid=chat-file]')).toBeNull();
});

test('a native open failure is shown and never falls back to downloading', async () => {
  setFeature('chat-artifacts', true);
  const invoke = vi.fn(async () => { throw 'game.exe: file does not exist'; });
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const reportError = vi.fn();
  const store = { owner: true, locateFile: asWritten, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }], reportError } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Launch game](game.exe)', store, threadId: 'game' } });
  flushSync();
  query<HTMLAnchorElement>('a[data-file-path]').click();
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith('game.exe: file does not exist', 'minor'));
  expect(document.querySelector('[data-testid=artifact-download]')).toBeNull();
});

test('a local file can still open when its preview cannot be read', async () => {
  setFeature('chat-artifacts', true);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = {
    owner: true, locateFile: asWritten, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }],
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

test('dragging across a game path never launches it, and the next click still does', async () => {
  setFeature('chat-artifacts', true);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, locateFile: asWritten, localCore: true, threads: [{ id: 'game', cwd: 'C:/project' }] } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: '[Launch game](build/game.exe)', store, threadId: 'game' } });
  flushSync();
  const link = query<HTMLAnchorElement>('a[data-file-path]');
  link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  link.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientX: 60, clientY: 10 }));
  link.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 60, clientY: 10 }));
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await vi.dynamicImportSettled();
  expect(invoke).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  link.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  await vi.dynamicImportSettled();
  link.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_local_file', { directory: 'C:/project', path: 'build/game.exe' }, undefined));
});

test.each([false, true])('selecting external link text skips navigation, then a click still opens it (shell: %s)', async (shell) => {
  const invoke = vi.fn(async () => {});
  const opened = vi.spyOn(window, 'open').mockReturnValue(null);
  if (shell) window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  running = mount(Prose, { target: document.body, props: { text: '[External reference](https://example.invalid/reference)' } });
  flushSync();
  const stopLinks = installExternalLinks(document.body);
  try {
    const link = query<HTMLAnchorElement>('a[href]');
    link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    link.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientX: 60, clientY: 10 }));
    link.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 60, clientY: 10 }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    link.dispatchEvent(click);
    await vi.dynamicImportSettled();
    expect(click.defaultPrevented).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    link.click();
    if (shell) await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://example.invalid/reference', with: undefined }, undefined));
    else expect(opened).toHaveBeenCalledWith('https://example.invalid/reference', '_blank', 'noopener,noreferrer');
  } finally { stopLinks(); opened.mockRestore(); }
});

test('the open-chat-links switch opens a desktop shortcut and text outside the checkout only on a click', async () => {
  setFeature('chat-artifacts', false);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, locateFile: asWritten, localCore: true, threads: [{ id: 'local', cwd: 'E:/project' }], readFile: vi.fn() } as unknown as Store;
  running = mount(Prose, { target: document.body, props: {
    text: '[Test](</C:/Users/Chris/Desktop/Boite - Test medias.lnk>) [Notes](file:///E:/reports/test%20result.txt)', store, threadId: 'local',
  } });
  flushSync();
  expect(document.querySelector('a[data-file-path]')).toBeNull();
  setFeature('open-chat-links', true); flushSync();
  expect(invoke).not.toHaveBeenCalled();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[data-file-path]');
  links[0]!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_file', { directory: 'E:/project', path: 'C:/Users/Chris/Desktop/Boite - Test medias.lnk' }, undefined));
  await tick(); links[1]!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_file', { directory: 'E:/project', path: 'E:/reports/test result.txt' }, undefined));
  expect(store.readFile).not.toHaveBeenCalled();
  setFeature('open-chat-links', false); flushSync();
  expect(document.querySelector('a[data-file-path]')).toBeNull();
});

test('a remote machine file is never opened by the open-chat-links switch', async () => {
  setFeature('open-chat-links', true);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const readFile = vi.fn(async () => ({ ok: false, error: 'Remote file unavailable' }));
  const store = { owner: true, locateFile: asWritten, localCore: false, threads: [{ id: 'remote', cwd: 'C:/project' }], readFile } as unknown as Store;
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

test('tilde and longer backtick fences render as code with a copy button, blank lines and inner fences included', async () => {
  running = mount(Prose, {
    target: document.body,
    props: { text: 'One:\n\n~~~ts\nconst a = 1;\n\nconst b = 2;\n~~~\n\nTwo:\n\n````md\n```sh\nls\n```\n\nend\n````\n' }
  });
  flushSync();
  await tick();

  const code = [...document.querySelectorAll('pre code')].map(node => node.textContent);
  expect(code).toEqual(['const a = 1;\n\nconst b = 2;', '```sh\nls\n```\n\nend']);
  expect(document.querySelectorAll('[data-testid=code-copy]')).toHaveLength(2);
});

test('fenced code inside a quote carries its copy button too', async () => {
  running = mount(Prose, {
    target: document.body,
    props: { text: 'Quoted:\n\n> ```sh\n> echo hello\n> ```\n\n> ~~~\n> echo tilde\n> ~~~\n' }
  });
  flushSync();
  await tick();

  const code = [...document.querySelectorAll('pre code')].map(node => node.textContent);
  expect(code).toEqual(['echo hello', 'echo tilde']);
  expect(document.querySelectorAll('blockquote [data-testid=code-copy]')).toHaveLength(2);
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

test('live text shows the unfinished paragraph instead of only typing dots', () => {
  running = mount(Prose, { target: document.body, props: { text: 'First paragraph.\n\nWriting the next', live: true, typing: true, bubble: true } });
  flushSync();
  expect(query('[data-testid=text-part]').textContent).toContain('Writing the next');
});

test('plain text preserves its rendered content and gets no copy button', async () => {
  running = mount(Prose, { target: document.body, props: { text: 'Plain `inline` text only.' } });
  flushSync();
  await tick();

  expect(query('[data-testid=text-part]').textContent).toBe('Plain inline text only.');
  expect(document.querySelector('[data-testid=code-copy]')).toBeNull();
});

test('a file named by its tail opens where the core finds it, and two candidates are reported', async () => {
  setFeature('open-chat-links', true);
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const reportError = vi.fn();
  const locateFile = vi.fn(async (_threadId: string, path: string) => ({ ok: true, value: path === 'core.md' ? ['.local/core.md'] : ['a/index.ts', 'b/index.ts'] }));
  const store = { owner: true, locateFile, localCore: true, threads: [{ id: 'brain', cwd: 'D:/brain' }], reportError } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: 'Trim `core.md` and `index.ts`.', store, threadId: 'brain' } });
  flushSync();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[data-file-path]');
  links[0]!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_chat_file', { directory: 'D:/brain', path: '.local/core.md' }, undefined));
  await tick(); links[1]!.click();
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(new Error('index.ts names several files: a/index.ts, b/index.ts'), 'minor'));
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('a file link\'s menu copies the whole path, not the #file placeholder, and still opens it', async () => {
  setFeature('chat-artifacts', true);
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const invoke = vi.fn(async () => {});
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const store = { owner: true, localCore: true, locateFile: asWritten, threads: [{ id: 'hex', cwd: 'E:\\Hexalife' }], reportError: vi.fn() } as unknown as Store;
  running = mount(Prose, { target: document.body, props: { text: 'See `addons/printer.qc:12`, `E:\\Hexalife\\models\\` and `thr_abcdefabcdef12`.', store, threadId: 'hex' } });
  flushSync();
  const [file, folder] = document.querySelectorAll<HTMLAnchorElement>('a[data-file-path]');

  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  file!.dispatchEvent(menu);
  expect(menu.defaultPrevented).toBe(true);
  expect(contextMenu.current?.items.map(item => item.id)).toEqual(['open', 'copy']);
  contextMenu.current!.onpick('copy');
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('E:\\Hexalife\\addons\\printer.qc'));

  folder!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  contextMenu.current!.onpick('copy');
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('E:\\Hexalife\\models\\'));

  file!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  contextMenu.current!.onpick('open');
  await vi.waitFor(() => expect(document.querySelector('[data-testid=chat-file]')).not.toBeNull());

  query<HTMLAnchorElement>('a[data-thread-address]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  contextMenu.current!.onpick('copy');
  await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('thr_abcdefabcdef12'));
  contextMenu.close();
});
