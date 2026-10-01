import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { whip } from '../lib/whip.svelte';
import { playCrack } from '../lib/whip/crack';
import WhipButton from './WhipButton.svelte';
import WhipOverlay from './WhipOverlay.svelte';

vi.mock('../lib/whip/crack', () => ({ primeCrackSound: vi.fn(), playCrack: vi.fn(), closeCrackAudio: vi.fn() }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  flushSync(() => { whip.held = false; });
  vi.restoreAllMocks();
  vi.mocked(playCrack).mockClear();
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
  const control = flushSync(() => mount(WhipButton, { target }));
  cleanups.push(async () => { finish(); await unmount(control); await unmount(overlay); target.remove(); });
  const button = target.querySelector('button')!;
  const click = () => flushSync(() => { button.click(); });
  const tick = (now: number) => flushSync(() => { frames.shift()!(now); });
  return { button, click, tick, finish, animate, onerror };
}

test('throwing does not shake; the crack of a flick does, with its sound', async () => {
  const { click, tick, animate, onerror } = toy();
  click();
  expect(whip.held).toBe(true);
  const start = performance.now();
  // A still rope, well past the opening grace: the click alone moves nothing.
  for (let frame = 1; frame <= 40; frame++) tick(start + frame * 1000 / 60);
  await Promise.resolve();
  expect(animate).not.toHaveBeenCalled();
  expect(playCrack).not.toHaveBeenCalled();
  for (let frame = 41; frame <= 280 && !vi.mocked(playCrack).mock.calls.length; frame++) {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 + Math.sin(frame / 1.5) * 200, clientY: 400 }));
    tick(start + frame * 1000 / 60);
  }
  expect(playCrack).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());
  expect(onerror).not.toHaveBeenCalled();
});

test('the footer drops the rope and restores Escape shortcuts', () => {
  const { button, click } = toy();
  click();
  expect(whip.held).toBe(true);
  expect(button.disabled).toBe(false);
  click();
  expect(whip.held).toBe(false);
  const shortcut = vi.fn();
  window.addEventListener('keydown', shortcut);
  try {
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    flushSync(() => { window.dispatchEvent(escape); });
    expect(shortcut).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(false);
  } finally { window.removeEventListener('keydown', shortcut); }
});

test('a throw during a fall replaces the rope and stays held after the old fall would finish', async () => {
  const { click, tick, onerror } = toy();
  click();
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
