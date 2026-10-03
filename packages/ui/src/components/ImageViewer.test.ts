import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message } from '@boite/contracts';
import ImageViewer from './ImageViewer.svelte';
import ChatFile from './ChatFile.svelte';
import UserMessage from './UserMessage.svelte';
import type { MediaItem } from '../lib/media-gallery';
import type { Store } from '../lib/store.svelte';
import type { TurnProgress } from '../lib/turn-progress.svelte';

const mounted: Record<string, unknown>[] = [];
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
const realFetch = globalThis.fetch;

beforeEach(() => {
  let made = 0;
  URL.createObjectURL = () => `blob:attachment-${++made}`;
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  for (const one of mounted.splice(0)) unmount(one, { outro: false });
  document.body.innerHTML = '';
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
  globalThis.fetch = realFetch;
});

function query<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} is not on the page`);
  return found;
}

function item(name: string, kind: 'image' | 'video' = 'image', src = `data:image/png;base64,${btoa(name)}`, save?: () => void): MediaItem {
  return { src, name, mimeType: kind === 'image' ? 'image/png' : 'video/mp4', kind, ...(save ? { save } : {}) };
}

function open(items: MediaItem[], index = 0) {
  const onclose = vi.fn();
  mounted.push(mount(ImageViewer, { target: document.body, props: { items, index, onclose } }));
  flushSync();
  return onclose;
}

function pointer(target: Element, type: string, x: number, y: number, pointerId = 1, pointerType = 'touch'): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, pointerType, button: 0 }));
  flushSync();
}

/** A finger from one point to another, in a few moves. */
function drag(target: Element, from: [number, number], to: [number, number], pointerType = 'touch'): void {
  pointer(target, 'pointerdown', ...from, 1, pointerType);
  for (const step of [0.25, 0.5, 1]) pointer(target, 'pointermove', from[0] + (to[0] - from[0]) * step, from[1] + (to[1] - from[1]) * step, 1, pointerType);
  pointer(target, 'pointerup', ...to, 1, pointerType);
}

const zoomLabel = () => query('button[aria-label="Fit image"]').textContent?.trim();
const position = () => query('[data-testid=image-viewer-position]').textContent;

test('the arrows, the keys and the counter walk the gallery, a video plays in place', () => {
  open([item('first.png'), item('second.png'), item('clip.mp4', 'video', 'blob:clip')], 1);
  expect(position()).toBe('2 of 3');
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').alt).toBe('second.png');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); flushSync();
  expect(position()).toBe('3 of 3');
  const video = query<HTMLVideoElement>('[data-testid=image-viewer] video');
  expect([video.getAttribute('src'), video.controls, video.playsInline]).toEqual(['blob:clip', true, true]);
  expect(document.querySelector('button[aria-label="Zoom in"]')).toBeNull();
  expect(query<HTMLButtonElement>('[data-testid=image-viewer-next]').disabled).toBe(true);
  query<HTMLButtonElement>('[data-testid=image-viewer-previous]').click(); flushSync();
  query<HTMLButtonElement>('[data-testid=image-viewer-previous]').click(); flushSync();
  expect(position()).toBe('1 of 3');
  expect(query<HTMLButtonElement>('[data-testid=image-viewer-previous]').disabled).toBe(true);
});

test('a finger swipes to the next picture and back, the mouse does not', () => {
  const onclose = open([item('first.png'), item('second.png')]);
  const stage = query('[data-testid=image-viewer-stage]');
  drag(stage, [300, 400], [200, 410]);
  expect(position()).toBe('2 of 2');
  drag(stage, [100, 400], [220, 395]);
  expect(position()).toBe('1 of 2');
  drag(stage, [300, 400], [150, 400], 'mouse');
  expect(position()).toBe('1 of 2');
  // A drag ends on the backdrop with a click: it does not close the viewer.
  query<HTMLButtonElement>('.backdrop').click();
  expect(onclose).not.toHaveBeenCalled();
  query<HTMLButtonElement>('.backdrop').click();
  expect(onclose).toHaveBeenCalledTimes(1);
});

test('dragged down, the viewer closes; dragged up, it stays', () => {
  const onclose = open([item('shot.png')]);
  const stage = query('[data-testid=image-viewer-stage]');
  drag(stage, [200, 300], [205, 220]);
  expect(onclose).not.toHaveBeenCalled();
  drag(stage, [200, 300], [205, 420]);
  expect(onclose).toHaveBeenCalledTimes(1);
});

test('a double tap zooms in and out, a pinch zooms with the fingers', () => {
  open([item('shot.png')]);
  const image = query('[data-testid=image-viewer] img');
  expect(zoomLabel()).toBe('100%');
  for (const at of [0, 1]) { pointer(image, 'pointerdown', 100 + at, 200); pointer(image, 'pointerup', 100 + at, 200); }
  expect(zoomLabel()).toBe('200%');
  for (const at of [0, 1]) { pointer(image, 'pointerdown', 100 + at, 200); pointer(image, 'pointerup', 100 + at, 200); }
  expect(zoomLabel()).toBe('100%');

  pointer(image, 'pointerdown', 150, 300, 1);
  pointer(image, 'pointerdown', 250, 300, 2);
  pointer(image, 'pointermove', 100, 300, 1);
  pointer(image, 'pointermove', 300, 300, 2);
  expect(zoomLabel()).toBe('200%');
  pointer(image, 'pointerup', 100, 300, 1);
  pointer(image, 'pointerup', 300, 300, 2);
  expect(zoomLabel()).toBe('200%');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); flushSync();
  expect(zoomLabel()).toBe('100%');
});

function shareSheet(result: () => Promise<void> = async () => {}) {
  const share = vi.fn(result);
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => (data.files?.length ?? 0) > 0 });
  return share;
}

test('Share hands an attachment to the system sheet straight from the tap', async () => {
  const share = shareSheet();
  globalThis.fetch = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })));
  open([item('shot.png')]);
  // Read ahead while the picture shows, so the tap itself opens the sheet.
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  query<HTMLButtonElement>('[data-testid=image-viewer-share]').click();
  expect(share).toHaveBeenCalledTimes(1);
  const [{ files, title }] = share.mock.calls[0] as unknown as [{ files: File[]; title: string }];
  expect([files[0]!.name, files[0]!.type, title]).toEqual(['shot.png', 'image/png', 'shot.png']);
});

test('a file fetched too late for the tap is kept for the next one, and a dismissed sheet says nothing', async () => {
  const share = shareSheet(async () => { throw new DOMException('no gesture', 'NotAllowedError'); });
  globalThis.fetch = vi.fn(async () => new Response(new Blob(['mp4'], { type: 'video/mp4' })));
  open([item('clip', 'video', 'https://core.example/file/clip')]);
  // A remote file is not read ahead: it may be large.
  expect(fetch).not.toHaveBeenCalled();
  query<HTMLButtonElement>('[data-testid=image-viewer-share]').click();
  await vi.waitFor(() => expect(query('[data-testid=image-viewer-notice]').textContent).toBe('clip is ready: tap Share again.'));
  expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]!.name).toBe('clip.mp4');
  share.mockImplementation(async () => { throw new DOMException('dismissed', 'AbortError'); });
  query<HTMLButtonElement>('[data-testid=image-viewer-share]').click();
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.querySelector('[data-testid=image-viewer-notice]')).toBeNull());
});

test('without a share sheet the file downloads the way its owner saves it', () => {
  const save = vi.fn();
  open([item('shot.png', 'image', 'blob:shot', save)]);
  expect(document.querySelector('[data-testid=image-viewer-share]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=image-viewer-download]').click();
  expect(save).toHaveBeenCalledTimes(1);
});

test('the pictures and videos of a thread make one gallery, in reading order', async () => {
  const thread = document.createElement('div');
  thread.dataset.mediaGallery = '';
  document.body.append(thread);
  const parts = [
    { type: 'file' as const, name: 'before.png', mimeType: 'image/png', data: btoa('a') },
    { type: 'file' as const, name: 'notes.zip', mimeType: 'application/zip', data: btoa('b') },
    { type: 'file' as const, name: 'clip.mp4', mimeType: 'video/mp4', data: btoa('c') },
    { type: 'file' as const, name: 'after.png', mimeType: 'image/png', data: btoa('d') }
  ];
  for (const file of parts) {
    const slot = document.createElement('div');
    thread.append(slot);
    mounted.push(mount(ChatFile, { target: slot, props: { file } }));
  }
  flushSync();
  const shots = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=artifact-enlarge]')];
  shots[1]!.click(); flushSync();
  expect(position()).toBe('3 of 3');
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').alt).toBe('after.png');
  query<HTMLButtonElement>('[data-testid=image-viewer-previous]').click(); flushSync();
  expect(query<HTMLVideoElement>('[data-testid=image-viewer] video').getAttribute('aria-label')).toBe('clip.mp4');
  query<HTMLButtonElement>('[data-testid=image-viewer-close]').click(); flushSync();

  query<HTMLButtonElement>('[data-testid=video-enlarge]').click(); flushSync();
  expect(position()).toBe('2 of 3');
});

test('a picture sent with a prompt opens in the viewer among the others', () => {
  const thread = document.createElement('div');
  thread.dataset.mediaGallery = '';
  document.body.append(thread);
  const message = {
    id: 'm1', threadId: 't1', turnId: 'u1', role: 'user', createdAt: 1_790_000_000_000,
    parts: [
      { type: 'text', text: 'two screens' },
      { type: 'image', mimeType: 'image/png', data: btoa('one'), alt: 'IMG_0001.jpg' },
      { type: 'image', mimeType: 'image/jpeg', data: btoa('two') }
    ]
  } as unknown as Message;
  const store = { providerOf: () => undefined, openThread: null } as unknown as Store;
  const progress = { responded: () => false } as unknown as TurnProgress;
  mounted.push(mount(UserMessage, { target: thread, props: { store, message, turn: undefined, progress } }));
  flushSync();
  const shots = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=image-open]')];
  shots[1]!.click(); flushSync();
  expect(position()).toBe('2 of 2');
  const image = query<HTMLImageElement>('[data-testid=image-viewer] img');
  expect([image.alt, image.getAttribute('src')]).toEqual(['image-2.jpg', `data:image/jpeg;base64,${btoa('two')}`]);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); flushSync();
  expect(query<HTMLImageElement>('[data-testid=image-viewer] img').alt).toBe('IMG_0001.jpg');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); flushSync();
  expect(document.querySelector('[data-testid=image-viewer]')).toBeNull();
});
