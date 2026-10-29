import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatFile from './ChatFile.svelte';
import { resetFeatures, setFeature } from '../lib/features';
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
  resetFeatures();
  delete window.__TAURI_INTERNALS__;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

const photo = { type: 'file' as const, name: 'capture.png', mimeType: 'image/png', data: btoa('png bytes') };
const archive = { type: 'file' as const, name: 'build.zip', mimeType: 'application/zip', data: btoa('zip bytes') };

test.each(['video/mp4', 'audio/mpeg'])('deferred %s loads a file URL only near the screen without hydrating the message', async mimeType => {
  let seen!: IntersectionObserverCallback;
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) { seen = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  const loadMediaAttachment = vi.fn(async () => 'https://core.example/file/media');
  const loadMessageAttachment = vi.fn();
  const store = { loadMediaAttachment, loadMessageAttachment } as unknown as Store;
  const file = { type: 'file' as const, name: 'recording', mimeType, data: '', dataDeferred: true as const, bytes: 20 * 1024 * 1024 };
  try {
    running = mount(ChatFile, { target: document.body, props: { file, store, threadId: 'thread', messageId: 'message', partIndex: 2 } });
    flushSync();
    expect(loadMediaAttachment).not.toHaveBeenCalled();
    expect(typeof seen).toBe('function');
    seen([{ target: query('[data-testid=chat-file]'), isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(document.querySelector('video, audio')).not.toBeNull());
    expect(loadMediaAttachment).toHaveBeenCalledExactlyOnceWith('thread', 'message', 2, mimeType);
    expect(loadMessageAttachment).not.toHaveBeenCalled();
    const player = query<HTMLMediaElement>('video, audio');
    expect(player.src).toBe('https://core.example/file/media');
    expect(player.preload).toBe('metadata');
    expect(player.autoplay).toBe(false);
    expect(file.data).toBe('');
    expect(file.dataDeferred).toBe(true);
  } finally {
    if (running) { await unmount(running, { outro: false }); running = null; }
    globalThis.IntersectionObserver = previous;
  }
});

test('a deferred video received as base64 through a relay saves its bytes in the shell', async () => {
  const invoke = vi.fn(async () => ({ path: 'C:/Downloads/clip.mp4', opened: false }));
  window.__TAURI_INTERNALS__ = { invoke } as unknown as typeof window.__TAURI_INTERNALS__;
  const loadMediaAttachment = vi.fn(async () => `data:video/mp4;base64,${btoa('original video bytes')}`);
  running = mount(ChatFile, { target: document.body, props: {
    store: { loadMediaAttachment } as unknown as Store, threadId: 'thread', messageId: 'message', partIndex: 0,
    file: { type: 'file', name: 'clip.mp4', mimeType: 'video/mp4', data: '', dataDeferred: true, bytes: 20 },
  } });
  await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  query<HTMLAnchorElement>('[data-testid=artifact-download]').click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const [command, body] = invoke.mock.lastCall as unknown as [string, Uint8Array];
  expect(command).toBe('save_attachment');
  expect(new TextDecoder().decode(body)).toBe('original video bytes');
});

function query<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} is not on the page`);
  return found;
}

test('a picture opens full size from its preview and from its name, and Escape closes it', async () => {
  setFeature('chat-artifacts', false);
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

test("an agent's deferred picture shows its blur, then its light copy near the screen, and its original only when clicked, in one box", async () => {
  const observers: { callback: IntersectionObserverCallback; nodes: Set<Element> }[] = [];
  const native = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    nodes = new Set<Element>();
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, nodes: this.nodes }); }
    observe(node: Element) { this.nodes.add(node); }
    unobserve(node: Element) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  } as unknown as typeof IntersectionObserver;
  try {
    const loadDisplayImage = vi.fn(async () => 'data:image/webp;base64,COPY');
    const loadMessageAttachment = vi.fn(async () => photo.data);
    running = mount(ChatFile, { target: document.body, props: {
      file: { ...photo, data: '', dataDeferred: true, bytes: 1_400_000, width: 1280, height: 720, preview: 'data:image/png;base64,BLUR' },
      store: { loadDisplayImage, loadMessageAttachment } as unknown as Store, threadId: 'thread', messageId: 'message', partIndex: 0
    } });
    flushSync();
    const waiting = query<HTMLElement>('[data-testid=artifact-open-original]');
    // As wide as the picture, or as its height capped at min(480px, 65vh) allows.
    const width = waiting.style.width;
    expect(width).toMatch(/^min\(1280px, calc\(min\(480px, 65vh\) ?\* ?1280 ?\/ ?720\)\)$/);
    expect(waiting.style.aspectRatio).toBe('1280 / 720');
    expect(query('[data-testid=artifact-blur]').getAttribute('src')).toBe('data:image/png;base64,BLUR');
    expect(query('[data-testid=artifact-launch]').textContent).toContain('1280 × 720');
    // Far from the screen, nothing is fetched.
    expect(loadDisplayImage).not.toHaveBeenCalled();

    for (const { callback, nodes } of observers) callback([...nodes].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
    await vi.waitFor(() => expect(document.querySelector('[data-testid=artifact-copy]')?.getAttribute('src')).toBe('data:image/webp;base64,COPY'));
    expect(loadDisplayImage).toHaveBeenCalledWith('thread', 'message', 0, 'image/png');
    expect(loadMessageAttachment).not.toHaveBeenCalled();

    // A click fetches the original, which takes the copy's place in a box of the same size.
    waiting.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid=artifact-enlarge] img:not(.blur)')?.getAttribute('src')).toBe('blob:attachment'));
    expect(loadMessageAttachment).toHaveBeenCalledWith('thread', 'message', 0);
    const shown = query<HTMLElement>('[data-testid=artifact-enlarge]');
    expect(shown.style.width).toBe(width);
    expect(shown.style.aspectRatio).toBe('1280 / 720');
  } finally {
    globalThis.IntersectionObserver = native;
  }
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
  setFeature('chat-artifacts', false);
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
  setFeature('chat-artifacts', rich);
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

test('a video the device cannot play offers its download, and a failed one can also be retried', async () => {
  // An iPhone that plays MP4 but not WebM.
  const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(type => type === 'video/mp4' ? 'maybe' : '');
  try {
    const url = `http://127.0.0.1:4311/file/${'b'.repeat(64)}`;
    const readArtifact = vi.fn(async () => ({ ok: true, value: { name: 'run.webm', mimeType: 'video/webm', bytes: 2048, url } }));
    running = mount(ChatFile, { target: document.body, props: { store: { readArtifact } as unknown as Store, threadId: 'thread', messageId: 'message', file: { type: 'artifact', id: 'artifact', mimeType: 'video/webm', name: 'run.webm', bytes: 2048 } } });
    await vi.waitFor(() => expect(document.querySelector('[data-testid=media-fallback]')).not.toBeNull());
    expect(document.querySelector('video')).toBeNull();
    expect(query('[data-testid=media-fallback]').textContent).toContain('cannot play this video');
    expect(query<HTMLAnchorElement>('[data-testid=media-fallback-download]').href).toBe(url);
    expect(query<HTMLAnchorElement>('[data-testid=media-fallback-download]').download).toBe('run.webm');
    // Retrying would fail the same way, so it is not offered.
    expect(query('[data-testid=media-fallback]').querySelector('button')).toBeNull();
    unmount(running!, { outro: false }); running = null;

    const mp4 = vi.fn(async () => ({ ok: true, value: { name: 'run.mp4', mimeType: 'video/mp4', bytes: 2048, url } }));
    running = mount(ChatFile, { target: document.body, props: { store: { readArtifact: mp4 } as unknown as Store, threadId: 'thread', messageId: 'message', file: { type: 'artifact', id: 'artifact', mimeType: 'video/mp4', name: 'run.mp4', bytes: 2048 } } });
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    query('video').dispatchEvent(new Event('error'));
    flushSync();
    expect(query('[data-testid=media-fallback]').querySelector('button')?.textContent).toContain('Try again');
    expect(query<HTMLAnchorElement>('[data-testid=media-fallback-download]').href).toBe(url);
  } finally { canPlayType.mockRestore(); }
});
test('a video mounted again keeps the size it loaded at while its metadata comes back', async () => {
  // The timeline mounts a row again when it scrolls back over it: a player that
  // starts at the browser's default size moved the rows below, and the window
  // dropped and mounted it again in a loop.
  const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
  try {
    const props = { file: { type: 'file' as const, name: 'demo.mp4', mimeType: 'video/mp4', data: btoa('mp4 bytes') }, threadId: 'thread-video', messageId: 'message-video', partIndex: 0 };
    running = mount(ChatFile, { target: document.body, props }); flushSync();
    expect(query('.clip').classList.contains('boxed')).toBe(false);
    const video = query<HTMLVideoElement>('video');
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    video.dispatchEvent(new Event('loadedmetadata')); flushSync();
    unmount(running!, { outro: false }); running = null;

    running = mount(ChatFile, { target: document.body, props }); flushSync();
    const clip = query<HTMLElement>('.clip');
    expect(clip.classList.contains('boxed')).toBe(true);
    expect(clip.getAttribute('style')).toContain('aspect-ratio: 1280 / 720');
    unmount(running!, { outro: false }); running = null;

    // An artifact whose ticket is still on its way: the reserved box sits in the card the player will,
    // not a full-width one where it stood taller and dropped once loaded.
    const artifact = { type: 'artifact' as const, id: 'clip', name: 'clip.mp4', mimeType: 'video/mp4', bytes: 2048 };
    const loaded = vi.fn(async () => ({ ok: true, value: { name: 'clip.mp4', mimeType: 'video/mp4', bytes: 2048, url: 'blob:clip' } }));
    running = mount(ChatFile, { target: document.body, props: { ...props, file: artifact, store: { readArtifact: loaded } as unknown as Store } });
    await vi.waitFor(() => query('video'));
    const player = query<HTMLVideoElement>('video');
    Object.defineProperties(player, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    player.dispatchEvent(new Event('loadedmetadata')); flushSync();
    const width = query<HTMLElement>('.clip').style.width;
    unmount(running!, { outro: false }); running = null;

    const pending = vi.fn(() => new Promise(() => {}));
    running = mount(ChatFile, { target: document.body, props: { ...props, file: artifact, store: { readArtifact: pending } as unknown as Store } }); flushSync();
    expect(query<HTMLElement>('[data-testid=artifact-reserved] .clip').style.width).toBe(width);
    expect(query('[data-testid=chat-file]').classList.contains('inline-media')).toBe(true);
  } finally { canPlayType.mockRestore(); }
});
