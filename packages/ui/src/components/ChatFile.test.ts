import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatFile from './ChatFile.svelte';
import { writeExperiments } from '../lib/experiments';
import type { Store } from '../lib/store.svelte';

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
  writeExperiments([]);
  running = mount(ChatFile, { target: document.body, props: { file: photo } });
  flushSync();
  expect(document.querySelector('[data-testid=artifact-preview]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=artifact-enlarge]').click();
  flushSync();
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').getAttribute('src')).toBe('blob:attachment');
  query<HTMLButtonElement>('button[aria-label="Zoom in"]').click(); flushSync();
  expect(query('button[aria-label="Fit image"]').textContent).toContain('150%');
  query<HTMLButtonElement>('[data-testid=image-viewer-close]').focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(query('[data-testid=image-viewer]').contains(document.activeElement)).toBe(true);
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

test('a deferred file shows its size and fetches the owning conversation only when opened', async () => {
  const invoke = vi.fn(async () => ({ path: 'C:/Downloads/build.zip', opened: true }));
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const loadMessageAttachment = vi.fn(async () => archive.data);
  running = mount(ChatFile, { target: document.body, props: {
    file: { ...archive, data: '', dataDeferred: true, bytes: 9 },
    store: { loadMessageAttachment } as unknown as Store, threadId: 'owning-thread', messageId: 'message', partIndex: 3
  } });
  flushSync();
  expect(loadMessageAttachment).not.toHaveBeenCalled();
  expect(query('[data-testid=artifact-launch]').textContent).toContain('9 B');
  query<HTMLButtonElement>('[data-testid=artifact-launch]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(loadMessageAttachment).toHaveBeenCalledWith('owning-thread', 'message', 3);
  expect(new TextDecoder().decode((invoke.mock.lastCall as unknown as [string, Uint8Array])[1])).toBe('zip bytes');
});

test('a failed attachment refresh does not save bytes from the previous successful read', async () => {
  const invoke = vi.fn(async () => ({ path: 'C:/Downloads/build.zip', opened: true }));
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const loadMessageAttachment = vi.fn().mockResolvedValueOnce(archive.data).mockRejectedValueOnce(new Error('Attachment unavailable'));
  running = mount(ChatFile, { target: document.body, props: {
    file: { ...archive, data: '', dataDeferred: true, bytes: 9 },
    store: { loadMessageAttachment } as unknown as Store, threadId: 'thread', messageId: 'message', partIndex: 0
  } });
  flushSync();
  query<HTMLButtonElement>('[data-testid=artifact-launch]').click();
  await vi.waitFor(() => expect(query('[data-testid=artifact-launch]').textContent).toContain('Saved in Downloads'));
  query<HTMLButtonElement>('[data-testid=artifact-launch]').click();
  await vi.waitFor(() => expect(query('[role=alert]').textContent).toContain('Attachment unavailable'));
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('a disk snapshot uses its owning store and streams its download without a full-body fetch', async () => {
  writeExperiments([]);
  const invoke = vi.fn(async () => ({ path: 'C:/Downloads/clip.mp4', opened: false }));
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const url = `http://127.0.0.1:4311/file/${'a'.repeat(64)}`;
  const readArtifact = vi.fn(async () => ({ ok: true, value: { name: 'clip.mp4', mimeType: 'video/mp4', bytes: 24 * 1024 * 1024, url } }));
  const store = { readArtifact } as unknown as Store;
  running = mount(ChatFile, { target: document.body, props: { store, threadId: 'thread', messageId: 'message', file: { type: 'artifact', id: 'artifact', mimeType: 'video/mp4', name: 'clip.mp4', bytes: 24 * 1024 * 1024 } } });
  await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  expect(readArtifact).toHaveBeenCalledWith('thread', 'message', 'artifact', undefined);
  expect(query<HTMLVideoElement>('video').src).toBe(url);
  expect(query<HTMLVideoElement>('video').autoplay).toBe(false);
  expect(query<HTMLVideoElement>('video').controls).toBe(true);
  expect(query<HTMLVideoElement>('video').playsInline).toBe(true);
  query<HTMLAnchorElement>('[data-testid=artifact-download]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('save_attachment_url', { name: 'clip.mp4', url, open: false }, undefined));
  expect(readArtifact).toHaveBeenLastCalledWith('thread', 'message', 'artifact', 'a'.repeat(64));
});

test('a media decoding failure keeps download available and can retry the preview', () => {
  running = mount(ChatFile, { target: document.body, props: { file: photo } }); flushSync();
  query('img').dispatchEvent(new Event('error')); flushSync();
  expect(query('[role=status]').textContent).toContain('could not be previewed');
  expect(query<HTMLAnchorElement>('[data-testid=artifact-download]').download).toBe(photo.name);
  query<HTMLButtonElement>('[role=status] button').click(); flushSync();
  expect(document.querySelector('img')).not.toBeNull();
  expect(document.querySelector('[role=status]')).toBeNull();
});

test.each([false, true])('large images wait for a click, with rich previews %j', async rich => {
  writeExperiments(rich ? ['chat-artifacts'] : []);
  const url = `https://core.example/file/${'b'.repeat(64)}`;
  const file = { type: 'artifact' as const, id: 'large-image', name: 'panorama.png', mimeType: 'image/png', bytes: 60 * 1024 * 1024 };
  const readArtifact = vi.fn(async () => ({ ok: true, value: { ...file, url } }));
  running = mount(ChatFile, { target: document.body, props: { file, store: { readArtifact } as unknown as Store, threadId: 'thread', messageId: 'message' } });
  await vi.waitFor(() => expect(document.querySelector('[data-testid=artifact-load-image]')).not.toBeNull());
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('[data-testid=artifact-content]')).toBeNull();
  expect(query<HTMLAnchorElement>('[data-testid=artifact-download]').href).toBe(url);
  query<HTMLButtonElement>('[data-testid=artifact-load-image]').click(); flushSync();
  expect(query<HTMLImageElement>('.preview img').src).toBe(url);
  query<HTMLButtonElement>('[data-testid=artifact-launch]').click(); flushSync();
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').src).toBe(url);
});
