import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushSync, tick } from 'svelte';
import { Closing } from './closing.svelte';

/** A node playing its exit: `finished` settles as the browser says, `endTime` is the length in ms. */
function playing(finished: Promise<unknown>, endTime = 150): HTMLElement {
  const node = document.createElement('div');
  void finished.catch(() => undefined);
  node.getAnimations = () => [{ finished, effect: { getComputedTiming: () => ({ endTime }) } } as unknown as Animation];
  return node;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) { await tick(); await Promise.resolve(); }
}

describe('Closing', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('an exit the browser cancels unmounts the node, though no animationend comes', async () => {
    const overlay = new Closing();
    overlay.show();
    overlay.attach(playing(Promise.reject(new DOMException('cancelled', 'AbortError'))));
    overlay.hide();
    await settle();
    flushSync();
    expect(overlay.shown).toBe(false);
  });

  test('an exit on a page the browser draws no frame of unmounts the node once its length is over', async () => {
    vi.useFakeTimers();
    const overlay = new Closing();
    overlay.show();
    overlay.attach(playing(new Promise(() => {}), 150));
    overlay.hide();
    await settle();
    // A slow first frame is not a missing one: the exit still has its time.
    await vi.advanceTimersByTimeAsync(1500);
    expect(overlay.closing).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(overlay.shown).toBe(false);
  });

  test('opening again during the exit keeps the node, even when that exit ends later', async () => {
    vi.useFakeTimers();
    const overlay = new Closing();
    overlay.show();
    overlay.attach(playing(new Promise(() => {}), 150));
    overlay.hide();
    await settle();
    overlay.show();
    await vi.advanceTimersByTimeAsync(2500);
    expect(overlay.open).toBe(true);
  });
});
