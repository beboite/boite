import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { whip } from '../lib/whip.svelte';
import WhipButton from './WhipButton.svelte';
import WhipOverlay from './WhipOverlay.svelte';

vi.mock('../lib/whip/crack', () => ({ primeCrackSound: vi.fn(), playCrack: vi.fn(), closeCrackAudio: vi.fn() }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  flushSync(() => { whip.held = false; });
  vi.restoreAllMocks();
});

function toy() {
  const target = document.createElement('div');
  target.id = 'app';
  document.body.append(target);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const animate = vi.fn(() => ({ finished, cancel: finish }));
  Object.defineProperty(target, 'animate', { value: animate });
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), bezierCurveTo: vi.fn(), stroke: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const onerror = vi.fn();
  const overlay = flushSync(() => mount(WhipOverlay, { target, props: { onerror } }));
  const control = flushSync(() => mount(WhipButton, { target, props: { onerror } }));
  cleanups.push(async () => { finish(); await unmount(control); await unmount(overlay); target.remove(); });
  const button = target.querySelector('button')!;
  const click = () => flushSync(() => { button.click(); });
  const tick = (now: number) => flushSync(() => { frames.shift()!(now); });
  return { button, click, tick, finish, onerror };
}

test('the footer can drop a held rope during its shake', async () => {
  const { button, click, finish } = toy();
  click();
  expect(whip.held).toBe(true);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBe("true");
  click();
  expect(whip.held).toBe(false);
  finish();
  await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBe("false"));
  expect(button.disabled).toBe(false);
});

test('a throw during a fall replaces the rope and stays held after the old fall would finish', async () => {
  const { click, tick, finish, onerror } = toy();
  click();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  click();
  expect(whip.held).toBe(false);
  click();
  expect(whip.held).toBe(true);
  const start = performance.now();
  for (let frame = 1; frame <= 180; frame++) tick(start + frame * 1000 / 60);
  expect(whip.held).toBe(true);
  expect(document.querySelector('[data-testid=whip-canvas]')).not.toBeNull();
  expect(onerror).not.toHaveBeenCalled();
});
