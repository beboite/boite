import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mobileOverlay } from './mobile-history';

/** jsdom lands a `history.back()` in a later task, as a browser does. */
const landed = () => new Promise<void>((resolve) => window.addEventListener('popstate', () => setTimeout(resolve, 0), { once: true }));
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const phone = (matches: boolean) => Object.defineProperty(window, 'matchMedia', {
  configurable: true, writable: true,
  value: (media: string) => ({ media, matches, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
});

describe('mobileOverlay', () => {
  let original: typeof window.matchMedia;
  beforeEach(() => { original = window.matchMedia; phone(true); });
  afterEach(async () => { window.matchMedia = original; await settle(); });

  test('Back closes the top overlay only, then the one under it', async () => {
    const closed: string[] = [];
    const start = history.state?.boiteDepth ?? 0;
    const below: () => void = mobileOverlay(() => { closed.push('panel'); below(); });
    const top: () => void = mobileOverlay(() => { closed.push('dialog'); top(); });
    const first = landed();
    history.back();
    await first;
    expect(closed).toEqual(['dialog']);
    const second = landed();
    history.back();
    await second;
    expect(closed).toEqual(['dialog', 'panel']);
    expect(history.state?.boiteDepth ?? 0).toBe(start);
  });

  test('closing by a button pops its own entry, and a push made meanwhile survives the pop', async () => {
    const closed: string[] = [];
    const sheet = mobileOverlay(() => closed.push('sheet'));
    const depth = history.state?.boiteDepth;
    sheet();
    // The list opens a conversation before the sheet's pop has landed.
    const conversation: () => void = mobileOverlay(() => { closed.push('conversation'); conversation(); });
    await settle();
    expect(history.state?.boiteDepth).toBe(depth);
    expect(closed).toEqual([]);
    const back = landed();
    history.back();
    await back;
    expect(closed).toEqual(['conversation']);
  });

  test('an entry buried under a newer one is skipped by the next Back', async () => {
    const closed: string[] = [];
    const buried = mobileOverlay(() => closed.push('buried'));
    const top: () => void = mobileOverlay(() => { closed.push('top'); top(); });
    buried();
    const before = history.state?.boiteDepth as number;
    const back = landed();
    history.back();
    await back;
    await settle();
    expect(closed).toEqual(['top']);
    // Landed on the buried entry, which is dead, so it went one further.
    expect(history.state?.boiteDepth ?? 0).toBe(before - 2);
  });

  test('a desktop width pushes nothing', () => {
    phone(false);
    const length = history.length;
    const close = vi.fn();
    mobileOverlay(close)();
    expect(history.length).toBe(length);
    expect(close).not.toHaveBeenCalled();
  });
});
