import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { applyGlass, GLASS_STORAGE_KEY, readGlass, setGlass } from './glass';

type Shell = { __TAURI_INTERNALS__?: unknown };

function enterShell(): void {
  (window as Shell).__TAURI_INTERNALS__ = { invoke: () => undefined };
}

function leaveShell(): void {
  delete (window as Shell).__TAURI_INTERNALS__;
}

describe('the window material', () => {
  beforeEach(() => {
    invoke.mockClear();
    window.localStorage.clear();
    delete document.documentElement.dataset.glass;
  });

  afterEach(leaveShell);

  test('off the shell nothing is stamped and no command goes out', async () => {
    applyGlass('acrylic');
    applyGlass('mica');

    expect(document.documentElement.dataset.glass).toBeUndefined();
    // The invoke is behind a dynamic import, so give the microtasks a turn.
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('in the shell the kind is stamped, cleared by solid, and sent to the window', async () => {
    enterShell();

    applyGlass('mica');
    expect(document.documentElement.dataset.glass).toBe('mica');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('window_material', { kind: 'mica' }));

    applyGlass('solid');
    expect(document.documentElement.dataset.glass).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('window_material', { kind: 'solid' }));
  });

  test('acrylic is what an empty storage means, and a choice is remembered', () => {
    expect(readGlass()).toBe('acrylic');

    setGlass('mica');

    expect(window.localStorage.getItem(GLASS_STORAGE_KEY)).toBe('mica');
    expect(readGlass()).toBe('mica');
  });
});
