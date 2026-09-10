import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>() }));
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
    invoke.mockReset();
    invoke.mockImplementation(async (command) => command === 'window_material_supported' ? true : undefined);
    window.localStorage.clear();
    delete document.documentElement.dataset.glass;
  });

  afterEach(leaveShell);

  test('off the shell nothing is stamped and no command goes out', async () => {
    applyGlass('acrylic');
    await applyGlass('mica');

    expect(document.documentElement.dataset.glass).toBeUndefined();
    // The invoke is behind a dynamic import, so give the microtasks a turn.
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('in the shell the kind is stamped, cleared by solid, and sent to the window', async () => {
    enterShell();

    await applyGlass('mica');
    expect(document.documentElement.dataset.glass).toBe('mica');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('window_material', { kind: 'mica' }));

    await applyGlass('solid');
    expect(document.documentElement.dataset.glass).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('window_material', { kind: 'solid' }));
  });

  test('acrylic is what an empty storage means, and a choice is remembered', () => {
    expect(readGlass()).toBe('acrylic');

    setGlass('mica');

    expect(window.localStorage.getItem(GLASS_STORAGE_KEY)).toBe('mica');
    expect(readGlass()).toBe('mica');
  });

  test('unsupported shells stay opaque and never receive a material command', async () => {
    enterShell();
    invoke.mockResolvedValue(false);
    await applyGlass('acrylic');
    await Promise.resolve();
    expect(document.documentElement.dataset.glass).toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith('window_material', expect.anything());
  });

  test('material refusal keeps the document opaque', async () => {
    enterShell();
    invoke.mockImplementation(async (command) => {
      if (command === 'window_material_supported') return true;
      throw new Error('material unavailable');
    });
    await applyGlass('mica');
    await Promise.resolve();
    expect(document.documentElement.dataset.glass).toBeUndefined();
  });

  test('a slow material change completes before the latest one and cannot repaint it', async () => {
    enterShell();
    let finishMica!: () => void;
    const micaGate = new Promise<void>((resolve) => { finishMica = resolve; });
    let nativeMaterial = 'solid';
    const changes: string[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === 'window_material_supported') return true;
      const kind = String(args?.kind);
      changes.push(kind);
      if (kind === 'mica') await micaGate;
      nativeMaterial = kind;
    });
    const first = applyGlass('mica');
    await vi.waitFor(() => expect(changes).toEqual(['mica']));
    const second = applyGlass('solid');
    await Promise.resolve();
    expect(changes).toEqual(['mica']);
    expect(document.documentElement.dataset.glass).toBeUndefined();
    finishMica();
    await Promise.all([first, second]);
    expect(changes).toEqual(['mica', 'solid']);
    expect(nativeMaterial).toBe('solid');
    expect(document.documentElement.dataset.glass).toBeUndefined();
  });
});
