import type { ProjectId } from './ids';

/**
 * Native desktop windows of the machine that runs the core: an editor, a game,
 * an installer. An agent captures them with `boite window`, the owner watches
 * one in a conversation's Window panel (docs/windows.md). Read-only: no input
 * ever reaches a window, and none is restored, raised or focused.
 */
export interface DesktopWindow {
  /** The window's handle on its machine (an HWND, an X11 window id) in decimal. Valid until the window closes. */
  id: string;
  /** The executable's file name: `Unity.exe`, `blender`. */
  process: string;
  pid: number;
  /** The window's physical pixels. */
  width: number;
  height: number;
  minimized: boolean;
  /** Only for an app the project allows: another app's title can name a document, a mail or an account. */
  title?: string;
  /** The app is on this project's list of allowed apps. */
  allowed: boolean;
  /** Never captured, even on request: a password manager, the sign-in screen or an app listed in `windowCaptureExclusions`. */
  excluded?: true;
}

/**
 * Exactly one of the three. `process` is the executable's name, `.exe`
 * optional, case-insensitive. `title` is a case-insensitive part of the title
 * and matches only windows of allowed apps, since other titles are hidden.
 * More than one window answering is refused with the candidates.
 */
export interface WindowTarget {
  id?: string;
  process?: string;
  title?: string;
}

/** A rectangle of the window, in its pixels or, with `unit: 'fraction'`, in fractions of its size from 0 to 1. */
export interface WindowCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'px' | 'fraction';
}

/** Whether this machine can capture windows, and why not. */
export interface WindowSupport {
  available: boolean;
  reason?: string;
}

/** What the capture wrote. `source` is the window's size before `max` and `crop`. */
export interface WindowShot {
  windowId: string;
  process: string;
  /** The PNG's absolute path. */
  path: string;
  width: number;
  height: number;
  source: { width: number; height: number };
}

/** A contact sheet: `frames` pictures taken `1 / fps` seconds apart, each labelled with its number and time. */
export interface WindowClip extends WindowShot {
  frames: number;
  seconds: number;
  fps: number;
}

/** The window a conversation's Window panel shows. Nothing is captured until a viewer presses Show. */
export interface WindowWatch {
  windowId: string;
  process: string;
  /** Only for an allowed app, as in `DesktopWindow`. */
  title?: string;
  openedAt: number;
}

/** One JPEG of the watched window. `id` names that picture at one size and quality, as `MobileDeviceFrame` does. */
export interface WindowFrame {
  id: string;
  windowId: string;
  width: number;
  height: number;
  base64: string;
  at: number;
  unchanged?: never;
}

/** The answer to a `windows.frame` whose `previous` is still what the window shows: no picture is sent. */
export interface WindowFrameUnchanged {
  id: string;
  windowId: string;
  width: number;
  height: number;
  unchanged: true;
  at: number;
}

/** An app a project lets agents capture, named by its executable's path. */
export interface AllowedWindowApp {
  path: string;
  process: string;
  addedAt: number;
}

export type WindowConsentAnswer = 'once' | 'always' | 'refuse';
export const WINDOW_CONSENT_ANSWERS: readonly WindowConsentAnswer[] = ['once', 'always', 'refuse'];
export type WindowCaptureKind = 'screenshot' | 'clip' | 'stream';
/** What a consent card asks for: a capture, or `read`, the names of a window's controls for `boite window read` and `point`. */
export type WindowConsentKind = WindowCaptureKind | 'read';

/**
 * One control of a window a person can act on, as `boite window read` lists
 * it from the system's accessibility tree: a button, a menu item, a field.
 */
export interface WindowControl {
  /** `#3` in the CLI: names the control to `windows.point` until the conversation's next `windows.read`. */
  id: number;
  /** UI Automation's control type in English: `Button`, `MenuItem`, `Edit`. */
  type: string;
  name: string;
  /** The app's own identifier for the control, when it gives one. */
  automationId?: string;
  /** Where it lies in the window, in the window's physical pixels: the coordinates of a full-size screenshot. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `windows.read` found. `total` counts every control that matched before `limit`. */
export interface WindowControls {
  windowId: string;
  process: string;
  controls: WindowControl[];
  total: number;
}

/** The box a conversation draws on the screen with `windows.point`; one at a time. */
export interface WindowPointer {
  windowId: string;
  process: string;
  label: string;
  /** The box in the window's physical pixels. It follows the window when the window moves. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** When the box goes away by itself. */
  expiresAt: number;
  /** The control it shows, when it was named by id or by name. */
  control?: { type: string; name: string };
  /**
   * The system draws this window above every app's window, as it does the
   * Start menu: the box stays behind it, so the agent says where to click.
   */
  behind?: true;
}

/** Why `windows.waitClick` ended without a click. */
export type WindowWaitEnd = 'timeout' | 'cleared' | 'gone';

/** How long a capture waits for the owner's answer on a consent card. */
export const WINDOW_CONSENT_TIMEOUT_MS = 10 * 60_000;
/** `--max` when none is given: the longest side, in pixels. 0 asks for the full size. */
export const WINDOW_SHOT_MAX = 1280;
export const WINDOW_CLIP_LIMITS = { seconds: 10, fps: 4 } as const;
/** Controls `windows.read` returns: a line costs about 10 tokens, so the default stays near 600. */
export const WINDOW_READ_LIMIT = { default: 60, max: 400 } as const;
/** How long a box stays drawn, and how long `windows.waitClick` waits, in seconds. */
export const WINDOW_POINT_SECONDS = { default: 120, max: 600 } as const;
export const WINDOW_POINT_LABEL_MAX = 80;
/** The longest side of a capture card's thumbnail. */
export const WINDOW_THUMBNAIL_MAX = 320;

/**
 * Executables never captured, matched on the file name without case: password
 * managers, the Windows sign-in, lock and elevation screens. The owner adds
 * more in Settings (`windowCaptureExclusions`).
 */
export const WINDOW_CAPTURE_EXCLUDED = [
  '1password.exe', '1password', 'bitwarden.exe', 'bitwarden', 'keepass.exe', 'keepassxc.exe', 'keepassxc', 'keepass2',
  'dashlane.exe', 'dashlane', 'logonui.exe', 'lockapp.exe', 'credentialuibroker.exe', 'consent.exe',
] as const;

export interface WindowsRpcMethods {
  /** The machine's top-level windows a person sees, minimized ones included, and what the Window panel shows. */
  'windows.list': { params: { threadId: string }; result: { windows: DesktopWindow[]; support: WindowSupport; watch: WindowWatch | null } };
  /**
   * One PNG of the window, written to `output`: inside the conversation's
   * folder or project, or its temporary folder, which is also where it goes
   * without `output`. `max` is the longest side, `WINDOW_SHOT_MAX` by default,
   * 0 for the full size. An app the project does not allow waits for the
   * owner's answer on a consent card, up to `WINDOW_CONSENT_TIMEOUT_MS`.
   */
  'windows.screenshot': {
    params: { threadId: string; target: WindowTarget; output?: string; max?: number; crop?: WindowCrop };
    result: WindowShot;
  };
  /** A labelled contact sheet of `seconds` (at most 10) at `fps` (at most 4, 2 by default), as one PNG. */
  'windows.clip': {
    params: { threadId: string; target: WindowTarget; seconds: number; fps?: number; output?: string; max?: number };
    result: WindowClip;
  };
  /** Shows the window in the conversation's Window panel, after the same consent as a capture. */
  'windows.watch': { params: { threadId: string; target: WindowTarget }; result: { watch: WindowWatch } };
  /** The watched window as a JPEG; with `previous`, `unchanged` while it shows the same picture. */
  'windows.frame': {
    params: { threadId: string; windowId: string; maxWidth?: number; quality?: number; previous?: string };
    result: WindowFrame | WindowFrameUnchanged;
  };
  /** Empties the conversation's Window panel. */
  'windows.close': { params: { threadId: string }; result: { closed: boolean } };
  /** The owner's answer to a `window_consent` card. */
  'windows.consent': { params: { threadId: string; requestId: string; answer: WindowConsentAnswer }; result: { ok: true } };
  'windows.allowlist': { params: { projectId: ProjectId }; result: { apps: AllowedWindowApp[] } };
  /** Takes an app off the project's list; its next capture asks again. */
  'windows.revoke': { params: { projectId: ProjectId; path: string }; result: { apps: AllowedWindowApp[] } };
  /**
   * The enabled controls on screen of the window, from its accessibility tree,
   * numbered for `windows.point`. `filter` keeps the names that contain it,
   * without case. Needs the same consent as a capture, asked as `read`.
   */
  'windows.read': { params: { threadId: string; target: WindowTarget; filter?: string; limit?: number }; result: WindowControls };
  /**
   * Draws a box with a label above every window, click-through, until a click
   * inside it ends a `windows.waitClick`, `windows.unpoint` or `seconds`.
   * Exactly one of: `control`, an id from the conversation's last
   * `windows.read`; `name`, the one control of `target` with that name, read
   * as `windows.read` does; `at`, a rectangle of `target` in its pixels or
   * fractions, for an app with no accessibility tree. Replaces the
   * conversation's previous box.
   */
  'windows.point': {
    params: { threadId: string; control?: number; target?: WindowTarget; name?: string; at?: WindowCrop; label?: string; seconds?: number };
    result: { pointer: WindowPointer };
  };
  /** Waits until the person presses the primary button inside the conversation's box, then takes the box away. */
  'windows.waitClick': {
    params: { threadId: string; timeoutSeconds?: number };
    result: { clicked: true; pointer: WindowPointer } | { clicked: false; reason: WindowWaitEnd };
  };
  /** Takes the conversation's box off the screen. */
  'windows.unpoint': { params: { threadId: string }; result: { cleared: boolean } };
}

export interface WindowsRpcEvents {
  /** For the clients subscribed to the conversation: what its Window panel shows now. */
  'windows.changed': { threadId: string; watch: WindowWatch | null };
}

/** A window id as `windows.list` gives it. The core still acts only on a window it lists. */
export function windowIdError(id: unknown): string | null {
  return typeof id === 'string' && /^\d{1,20}$/.test(id) ? null : 'windowId must be an id from `boite window list`';
}

/** The one problem with a target, or null. */
export function windowTargetError(target: unknown): string | null {
  if (!target || typeof target !== 'object') return 'target must name a window by id, process or title';
  const { id, process, title } = target as WindowTarget;
  const given = [id, process, title].filter((value) => value !== undefined);
  if (given.length !== 1) return 'target must name exactly one of id, process or title';
  if (id !== undefined) return windowIdError(id);
  const value = process ?? title;
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 260 && !/\p{Cc}/u.test(value)
    ? null : `target ${process !== undefined ? 'process' : 'title'} must be 1 to 260 characters with no control characters`;
}

/** The one problem with a crop, or null. Pixels are integers; fractions lie in [0, 1] with a size above 0. */
export function windowCropError(crop: unknown): string | null {
  if (!crop || typeof crop !== 'object') return 'crop must be x,y,width,height';
  const { x, y, width, height, unit } = crop as WindowCrop;
  const values = [x, y, width, height];
  if (unit === 'px') {
    return values.every((value) => Number.isInteger(value) && value >= 0 && value <= 32768) && width > 0 && height > 0
      ? null : 'a crop in pixels needs integers from 0 with a width and height above 0';
  }
  if (unit === 'fraction') {
    return values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) && width > 0 && height > 0 && x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9
      ? null : 'a crop in fractions needs values from 0 to 1, a width and height above 0, and x + width and y + height at most 1';
  }
  return 'crop unit must be px or fraction';
}

/** `x,y,w,h` as the CLI takes it: pixels, or fractions when every value is at most 1 and one has a decimal point. */
export function parseWindowCrop(text: string): WindowCrop | null {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^\d+(\.\d+)?$|^\.\d+$/.test(part))) return null;
  const [x, y, width, height] = parts.map(Number) as [number, number, number, number];
  const fraction = parts.some((part) => part.includes('.')) && [x, y, width, height].every((value) => value <= 1);
  return { x, y, width, height, unit: fraction ? 'fraction' : 'px' };
}
