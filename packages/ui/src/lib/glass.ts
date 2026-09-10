/*
 * The window material: what the compositor draws behind the window on Windows.
 * Acrylic, Mica or Solid, stored under `boite.glass` the way the theme is
 * stored under `boite.theme`, and applied at startup like the theme.
 *
 * Two halves have to agree. `data-glass` on `<html>` is what `app.css` reads to
 * let the ground through, and the `window_material` command is what puts the
 * material on the window itself. Unsupported shells keep an opaque document.
 */

export type Glass = 'acrylic' | 'mica' | 'solid';

export const GLASS_STORAGE_KEY = 'boite.glass';

const KINDS: Glass[] = ['acrylic', 'mica', 'solid'];
let materialQueue = Promise.resolve();
let materialRevision = 0;

/** The stored material, `acrylic` when nothing is stored or storage is refused. */
export function readGlass(): Glass {
  try {
    const raw = window.localStorage.getItem(GLASS_STORAGE_KEY);
    return raw !== null && KINDS.includes(raw as Glass) ? (raw as Glass) : 'acrylic';
  } catch {
    return 'acrylic';
  }
}

export function writeGlass(kind: Glass): void {
  try {
    window.localStorage.setItem(GLASS_STORAGE_KEY, kind);
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

function insideShell(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

async function ask(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke(command, args);
}

/**
 * Native changes run in order. Only the latest successful request paints the
 * document, so a slow previous request cannot bring transparency back.
 */
export function applyGlass(kind: Glass): Promise<void> {
  const revision = ++materialRevision;
  const root = document.documentElement;
  if (!insideShell()) {
    delete root.dataset.glass;
    return Promise.resolve();
  }
  materialQueue = materialQueue.then(async () => {
    if (!(await glassSupported())) {
      if (revision === materialRevision) delete root.dataset.glass;
      return;
    }
    try {
      await ask('window_material', { kind });
      if (revision !== materialRevision || !insideShell()) return;
      if (kind === 'solid') delete root.dataset.glass;
      else root.dataset.glass = kind;
    } catch {
      if (revision === materialRevision) delete root.dataset.glass;
    }
  });
  return materialQueue;
}

/** Stores the choice and paints it in one call: what the settings control uses. */
export function setGlass(kind: Glass): void {
  writeGlass(kind);
  void applyGlass(kind);
}

/** The stored material, applied. Called once from the app's mount. */
export function startGlass(): void {
  void applyGlass(readGlass());
}

/**
 * Whether this platform has a window material at all: the shell answers true on
 * Windows and false everywhere else. The setting hides itself on a false, since
 * a control that changes nothing is worse than no control.
 */
export async function glassSupported(): Promise<boolean> {
  if (!insideShell()) return false;
  try {
    return (await ask('window_material_supported')) === true;
  } catch {
    return false;
  }
}
