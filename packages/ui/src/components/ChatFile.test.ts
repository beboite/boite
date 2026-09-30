import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatFile from './ChatFile.svelte';
import { writeExperiments } from '../lib/experiments';

let running: Record<string, unknown> | null = null;
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = () => 'blob:attachment';
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  writeExperiments([]);
  delete window.__TAURI_INTERNALS__;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

const photo = { type: 'file' as const, name: 'capture.png', mimeType: 'image/png', data: btoa('png bytes') };
const archive = { type: 'file' as const, name: 'build.zip', mimeType: 'application/zip', data: btoa('zip bytes') };

function query<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} is not on the page`);
  return found;
}

test('a picture opens full size from its preview and from its name, and Escape closes it', async () => {
  writeExperiments(['chat-artifacts']);
  running = mount(ChatFile, { target: document.body, props: { file: photo } });
  flushSync();
  query<HTMLButtonElement>('[data-testid=artifact-preview]').click();
  flushSync();
  query<HTMLButtonElement>('[data-testid=artifact-enlarge]').click();
  flushSync();
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').getAttribute('src')).toBe('blob:attachment');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(document.querySelector('[data-testid=image-viewer]')).toBeNull();

  query<HTMLButtonElement>('[data-testid=artifact-launch]').click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid=image-viewer]')).not.toBeNull());
  query<HTMLButtonElement>('[data-testid=image-viewer-close]').click();
  flushSync();
  expect(document.querySelector('[data-testid=image-viewer]')).toBeNull();
});

test('in the shell the name saves and opens the file, and Download saves it without the browser', async () => {
  const invoke = vi.fn(async () => ({ path: 'C:/Users/me/Downloads/build.zip', opened: true }));
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  running = mount(ChatFile, { target: document.body, props: { file: archive } });
  flushSync();
  query<HTMLButtonElement>('[data-testid=artifact-launch]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const [command, body, options] = invoke.mock.lastCall as unknown as [string, Uint8Array, unknown];
  expect([command, new TextDecoder().decode(body), options])
    .toEqual(['save_attachment', 'zip bytes', { headers: { 'x-boite-name': 'build.zip', 'x-boite-open': '1' } }]);
  await vi.waitFor(() => expect(query('[data-testid=artifact-launch]').textContent).toContain('Saved in Downloads'));

  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  query<HTMLAnchorElement>('[data-testid=artifact-download]').dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect((invoke.mock.lastCall as unknown as unknown[])[2]).toEqual({ headers: { 'x-boite-name': 'build.zip', 'x-boite-open': '0' } });
  expect(document.querySelector('[data-testid=image-viewer]')).toBeNull();
});
