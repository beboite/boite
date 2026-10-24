import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { MessagePart } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import { watchWindows } from '../lib/window-watch';
import { liveViews } from '../lib/live-view.svelte';
import { confirm } from '../lib/confirm.svelte';
import WindowSurface from './WindowSurface.svelte';
import WindowConsentCard from './WindowConsentCard.svelte';
import WindowAllowlistCard from './WindowAllowlistCard.svelte';

let apps: ReturnType<typeof mount>[] = [], client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const thread = 't-trace';
const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`);

beforeEach(async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  liveViews.reset();
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  await client.call('threads.subscribe', { threadId: thread });
});
afterEach(async () => {
  for (const app of apps) await unmount(app);
  apps = [];
  confirm.answer(false);
  store?.detach(); client?.close(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ''; localStorage.clear();
});

test('the panel stays covered until Show, polls naming the last frame, and Hide and Close stop it', async () => {
  vi.useFakeTimers();
  const calls = vi.spyOn(client, 'call');
  const frames = () => calls.mock.calls.filter(([method]) => method === 'windows.frame');
  apps.push(mount(WindowSurface, { target: document.body, props: { store, threadId: thread } })); await settle();
  expect($('window-empty')).not.toBeNull();

  await client.call('windows.watch', { threadId: thread, target: { process: 'Unity.exe' } }); await settle();
  expect($('window-process')!.textContent).toBe('Unity.exe');
  expect($('window-cover-text')!.textContent).toContain('An agent opened a window of');
  await vi.advanceTimersByTimeAsync(1000); await settle();
  expect(frames()).toHaveLength(0);

  $<HTMLButtonElement>('window-show')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(300); await settle();
  const image = $<HTMLImageElement>('window-frame')!;
  expect(image.src).toMatch(/^data:image\/jpeg;base64,/);
  expect($('window-read-only')).not.toBeNull();
  // Within the same second the window is still: the next poll names the frame shown and gets no picture back.
  await vi.advanceTimersByTimeAsync(400); await settle();
  const polls = frames();
  expect(polls.length).toBeGreaterThanOrEqual(2);
  expect(polls.at(-1)![1]).toMatchObject({ previous: expect.stringMatching(/^wf-132456-/) });
  // Two to four frames a second, never more.
  const before = polls.length;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(frames().length - before).toBeGreaterThanOrEqual(4);
  expect(frames().length - before).toBeLessThanOrEqual(9);

  // A tab put in the background stops asking.
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange')); await settle();
  const hidden = frames().length;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(frames().length).toBe(hidden);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await settle();
  await vi.advanceTimersByTimeAsync(600); await settle();
  expect(frames().length).toBeGreaterThan(hidden);

  $<HTMLButtonElement>('window-hide')!.click(); await settle();
  expect($('window-cover')).not.toBeNull();
  const covered = frames().length;
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(frames().length).toBe(covered);

  $<HTMLButtonElement>('window-close')!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('windows.close', { threadId: thread });
  expect($('window-empty')).not.toBeNull();
});

test('a minimized window says so in the panel instead of a picture', async () => {
  vi.useFakeTimers();
  // Notepad is not allowed: the watch waits for an answer, given here as soon as the card is posted.
  const off = client.on('message.part', ({ part }) => {
    if (part?.type === 'window_consent' && part.answer === null) void client.call('windows.consent', { threadId: thread, requestId: part.requestId, answer: 'once' });
  });
  apps.push(mount(WindowSurface, { target: document.body, props: { store, threadId: thread } })); await settle();
  const watching = client.call('windows.watch', { threadId: thread, target: { process: 'Notepad.exe' } });
  await vi.advanceTimersByTimeAsync(50); await watching; await settle();
  off();
  $<HTMLButtonElement>('window-show')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(300); await settle();
  expect($('window-error')!.textContent).toContain('minimized');
  expect($('window-frame')).toBeNull();
});

test('a window the agent watches brings the Window tab forward', async () => {
  const panel = rightPanel.for(store.threadKey(thread));
  const stop = watchWindows(store, thread); await settle();
  expect(panel.surfaces.some(surface => surface.kind === 'window')).toBe(false);
  await client.call('windows.watch', { threadId: thread, target: { process: 'Unity.exe' } }); await settle();
  expect(panel.isOpen).toBe(true);
  expect(panel.active?.kind).toBe('window');
  stop();
});

test('the consent card answers the waiting capture, shows a refusal and turns over when answered or expired', async () => {
  let posted: Extract<MessagePart, { type: 'window_consent' }> | undefined;
  const off = client.on('message.part', ({ part }) => {
    if (part?.type === 'window_consent') posted = part;
  });
  const watching = client.call('windows.watch', { threadId: thread, target: { process: 'blender.exe' } });
  await settle();
  off();
  expect(posted).toMatchObject({ process: 'blender.exe', kind: 'stream', answer: null });
  const calls = vi.spyOn(client, 'call');
  apps.push(mount(WindowConsentCard, { target: document.body, props: { store, threadId: thread, agent: 'Claude', part: posted! } })); await settle();
  expect($('window-consent-asks')!.textContent).toBe('Claude wants to capture blender.exe');
  $<HTMLButtonElement>('window-consent-always')!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('windows.consent', { threadId: thread, requestId: posted!.requestId, answer: 'always' });
  expect((await watching).watch.process).toBe('blender.exe');
  await unmount(apps.pop()!);

  // The same request again: the core no longer waits for it, and the card says why.
  apps.push(mount(WindowConsentCard, { target: document.body, props: { store, threadId: thread, agent: 'Claude', part: posted! } })); await settle();
  $<HTMLButtonElement>('window-consent-once')!.click(); await settle();
  expect($('window-consent-error')!.textContent).toContain('no longer waiting');
  expect($<HTMLButtonElement>('window-consent-once')!.disabled).toBe(false);
  await unmount(apps.pop()!);

  apps.push(mount(WindowConsentCard, { target: document.body, props: { store, threadId: thread, agent: 'Claude', part: { ...posted!, answer: 'always' } } })); await settle();
  expect($('window-consent')!.dataset.state).toBe('answered');
  expect($('window-consent-verdict')!.textContent).toBe('Always allowed in this project: blender.exe');
  await unmount(apps.pop()!);

  apps.push(mount(WindowConsentCard, { target: document.body, props: { store, threadId: thread, agent: 'Claude', part: { ...posted!, expiresAt: Date.now() - 1 } } })); await settle();
  expect($('window-consent-verdict')!.textContent).toBe('Not answered in time: blender.exe');
});

test('the allowed apps list removes an app only after the confirmation', async () => {
  apps.push(mount(WindowAllowlistCard, { target: document.body, props: { store } })); await settle();
  const project = document.querySelector<HTMLElement>('[data-testid=window-allowlist-project][data-project-id=p-boite]')!;
  expect(project.textContent).toContain('Unity.exe');
  // A Refresh that read the list before the revoke, and answers after it.
  const call = client.call.bind(client);
  let holding = false, release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = vi.spyOn(client, 'call').mockImplementation((async (method: string, params: unknown) => {
    const answer = call(method as never, params as never);
    if (method === 'windows.allowlist' && holding) await held;
    return answer;
  }) as typeof client.call);
  holding = true;
  $<HTMLButtonElement>('window-allowlist-refresh')!.click(); await settle();
  holding = false;
  project.querySelector<HTMLButtonElement>('[data-testid=window-allowlist-remove]')!.click(); await settle();
  expect(confirm.current?.title).toBe('Stop allowing Unity.exe?');
  confirm.answer(false); await settle();
  expect(calls.mock.calls.some(([method]) => method === 'windows.revoke')).toBe(false);
  project.querySelector<HTMLButtonElement>('[data-testid=window-allowlist-remove]')!.click(); await settle();
  confirm.answer(true); await settle();
  expect(calls).toHaveBeenCalledWith('windows.revoke', { projectId: 'p-boite', path: expect.stringMatching(/Unity\.exe$/i) });
  expect($('window-allowlist-empty')).not.toBeNull();
  release(); await settle();
  expect($('window-allowlist-empty')).not.toBeNull();
});

test('the allowed apps list reads again when a project is added, and on Refresh after an Always answered elsewhere', async () => {
  apps.push(mount(WindowAllowlistCard, { target: document.body, props: { store } })); await settle();
  const calls = vi.spyOn(client, 'call');
  const project = await store.addProject('C:/Dev/Fresh', { navigate: false }); await settle();
  expect(calls).toHaveBeenCalledWith('windows.allowlist', { projectId: project!.id });

  let posted: Extract<MessagePart, { type: 'window_consent' }> | undefined;
  const off = client.on('message.part', ({ part }) => { if (part?.type === 'window_consent') posted = part; });
  const watching = client.call('windows.watch', { threadId: thread, target: { process: 'blender.exe' } });
  await settle();
  off();
  await client.call('windows.consent', { threadId: thread, requestId: posted!.requestId, answer: 'always' });
  await watching;
  expect(document.body.textContent).not.toContain('blender.exe');
  $<HTMLButtonElement>('window-allowlist-refresh')!.click(); await settle();
  expect(document.body.textContent).toContain('blender.exe');
});