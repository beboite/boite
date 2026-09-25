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

/**
 * The stored choice, `acrylic` when nothing is stored or storage is refused.
 * What the window wears is this choice checked against what the shell offers:
 * see `effectiveGlass`.
 */
export function readGlass(): Glass {
  try {
    const raw = window.localStorage.getItem(GLASS_STORAGE_KEY);
    return raw !== null && KINDS.includes(raw as Glass) ? (raw as Glass) : 'acrylic';
  } catch {
    return 'acrylic';
  }
}

/**
 * The material a choice becomes on a shell offering `supported`: the choice
 * itself when offered, solid otherwise. Windows 10 offers solid alone, and a
 * Windows 11 build before 22523 offers mica but not acrylic, whose only path
 * there lags on every drag and resize.
 */
export function effectiveGlass(kind: Glass, supported: readonly Glass[]): Glass {
  return supported.includes(kind) ? kind : 'solid';
}

/** Whether the setting has anything to choose between. */
export function hasMaterialChoice(supported: readonly Glass[]): boolean {
  return supported.some((kind) => kind !== 'solid');
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
    const supported = await supportedGlass();
    if (!hasMaterialChoice(supported)) {
      if (revision === materialRevision) delete root.dataset.glass;
      return;
    }
    const material = effectiveGlass(kind, supported);
    try {
      await ask('window_material', { kind: material });
      if (revision !== materialRevision || !insideShell()) return;
      if (material === 'solid') delete root.dataset.glass;
      else root.dataset.glass = material;
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
 * The materials this window can wear: the shell answers from the Windows build
 * and answers nothing off Windows. A shell from before that list answered a
 * boolean, true meaning every kind.
 */
export async function supportedGlass(): Promise<Glass[]> {
  if (!insideShell()) return [];
  try {
    const answer = await ask('window_material_supported');
    if (answer === true) return [...KINDS];
    return Array.isArray(answer) ? KINDS.filter((kind) => answer.includes(kind)) : [];
  } catch {
    return [];
  }
}
