/*
 * `boite window read`, `point`, `wait-click` and `unpoint`: an agent guides
 * the person at the machine instead of acting for them. It reads the controls
 * of a window as a few lines of text, draws a click-through box with a label
 * over the one to press, and waits for the person's click there. The OS half
 * is `ProcessPlatform.windowGuide`, loaded by the first call. The box is the
 * desktop app's to draw: the core sends it `windows.pointer` events with where
 * the control is, and refuses when no desktop app of this machine is open.
 *
 * Reading a window's controls is consented like a capture of it (`read` on the
 * card); a box drawn over a rectangle of a window reads nothing and asks
 * nothing. Excluded apps, minimized windows and a turn a contact wrote into
 * are refused as `DesktopWindows` refuses them. The box never focuses the
 * window and sends it nothing: the person clicks the control under it. Control
 * names never go to the log. See docs/windows.md.
 */
import {
  WINDOW_POINT_LABEL_MAX,
  WINDOW_POINT_SECONDS,
  WINDOW_READ_LIMIT,
  windowCropError,
  type RpcParams,
  type RpcResult,
  type ThreadSummary,
  type WindowControl,
  type WindowCrop,
  type WindowPointer,
  type WindowTarget,
  type WindowWaitEnd,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { NativeWindow, ScreenRect, WindowGuide } from '../platform/types.ts';
import type { Connection } from '../router.ts';
import { cropRect } from './image.ts';

/** How many controls a read asks the OS for before `filter` and `limit` keep some. */
const READ_SCAN = 2_000;
const FILTER_MAX = 100;
/** How long a box stays after a wait on it ends without a click, at least. */
const WAIT_GRACE_MS = 30_000;

export interface WindowGuidesOptions {
  /** How often a box follows its window. */
  followMs?: number;
  /** How often a wait reads the mouse: a click holds the button down for 50 ms or more. */
  mouseMs?: number;
}

/** What `DesktopWindows` lends the guide: its conversation and window checks. */
export interface WindowGuideHost {
  activeThread(threadId: string, connection?: Connection): ThreadSummary;
  grantedWindow(thread: ThreadSummary, target: WindowTarget, kind: 'read' | null, connection?: Connection): Promise<NativeWindow>;
}

/** The controls a conversation last read, numbered from 1, with the window they belong to. */
interface Snapshot {
  window: NativeWindow;
  controls: WindowControl[];
}

/** The box a conversation shows: where it is in its window, and who waits for a click in it. */
interface Shown {
  pointer: WindowPointer;
  window: NativeWindow;
  /** The id of its `windows.pointer` events. */
  boxId: string;
  /** On the screen now; null while the window is minimized. */
  screen: ScreenRect | null;
  follow: ReturnType<typeof setInterval>;
  expiry: ReturnType<typeof setTimeout>;
  waiters: Set<(end: WindowWaitEnd | 'clicked') => void>;
}

const sameRect = (a: ScreenRect | null, b: ScreenRect | null) =>
  a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
const controlLine = (control: WindowControl) => `  #${control.id} ${control.type} "${control.name}"`;

export class WindowGuides {
  readonly #core: Core;
  readonly #host: WindowGuideHost;
  readonly #loader: () => Promise<WindowGuide | { unavailable: string }>;
  readonly #followMs: number;
  readonly #mouseMs: number;
  #backend?: Promise<WindowGuide | { unavailable: string }>;
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #shown = new Map<string, Shown>();

  constructor(core: Core, host: WindowGuideHost, loader: () => Promise<WindowGuide | { unavailable: string }>, options: WindowGuidesOptions = {}) {
    this.#core = core;
    this.#host = host;
    this.#loader = loader;
    this.#followMs = options.followMs ?? 250;
    this.#mouseMs = options.mouseMs ?? 25;
  }

  async read({ threadId, target, filter, limit }: RpcParams<'windows.read'>, connection?: Connection): Promise<RpcResult<'windows.read'>> {
    const thread = this.#host.activeThread(threadId, connection);
    if (filter !== undefined && (typeof filter !== 'string' || filter.trim() === '' || filter.length > FILTER_MAX || /\p{Cc}/u.test(filter))) {
      throw invalidParams(`filter must be 1 to ${FILTER_MAX} characters with no control characters`, { field: 'filter' });
    }
    const max = limit ?? WINDOW_READ_LIMIT.default;
    if (!Number.isInteger(max) || max < 1 || max > WINDOW_READ_LIMIT.max) throw invalidParams(`limit must be a whole number from 1 to ${WINDOW_READ_LIMIT.max}`, { field: 'limit' });
    const guide = await this.#load();
    const window = await this.#host.grantedWindow(thread, target, 'read', connection);
    const snapshot = await this.#read(thread, guide, window);
    const wanted = filter?.trim().toLowerCase();
    const matching = wanted === undefined ? snapshot.controls : snapshot.controls.filter(control => control.name.toLowerCase().includes(wanted));
    return { windowId: window.id, process: window.process, controls: matching.slice(0, max), total: matching.length };
  }

  async point(params: RpcParams<'windows.point'>, connection?: Connection): Promise<RpcResult<'windows.point'>> {
    const thread = this.#host.activeThread(params.threadId, connection);
    const { control: id, target, name, at } = params;
    const given = [id, name, at].filter(value => value !== undefined).length;
    if (given !== 1) throw invalidParams('point needs exactly one of control, name or at', { field: 'control' });
    const label = params.label ?? '';
    if (typeof label !== 'string' || label.length > WINDOW_POINT_LABEL_MAX || /\p{Cc}/u.test(label)) {
      throw invalidParams(`label must be at most ${WINDOW_POINT_LABEL_MAX} characters with no control characters`, { field: 'label' });
    }
    const seconds = this.#seconds(params.seconds, 'seconds');

    // Every check that needs no OS comes first: a machine without the guide refuses the same bad call the same way.
    let window: NativeWindow;
    let box: { x: number; y: number; width: number; height: number };
    let control: WindowControl | undefined;
    if (id !== undefined) {
      if (target !== undefined) throw invalidParams('a control id already names its window: drop the target', { field: 'target' });
      if (!Number.isInteger(id) || id < 1) throw invalidParams('control must be an id such as 3 from `boite window read`', { field: 'control' });
      const snapshot = this.#snapshots.get(thread.id);
      if (!snapshot) throw refused('nothing was read in this conversation yet: run `boite window read` first', { field: 'control' });
      control = snapshot.controls.find(candidate => candidate.id === id);
      if (!control) throw refused(`#${id} is not among the ${snapshot.controls.length} controls of the last read: read the window again`, { field: 'control' });
      window = await this.#host.grantedWindow(thread, { id: snapshot.window.id }, null, connection);
      if (window.pid !== snapshot.window.pid || window.path !== snapshot.window.path) {
        throw refused(`window ${snapshot.window.id} of ${snapshot.window.process} is gone: read again`, { windowId: snapshot.window.id, code: 'gone' });
      }
      box = control;
    } else if (name !== undefined) {
      if (target === undefined) throw invalidParams('point by name needs the window\'s target', { field: 'target' });
      if (typeof name !== 'string' || name.trim() === '' || name.length > 260 || /\p{Cc}/u.test(name)) {
        throw invalidParams('name must be 1 to 260 characters with no control characters', { field: 'name' });
      }
      const guide = await this.#load();
      window = await this.#host.grantedWindow(thread, target, 'read', connection);
      const snapshot = await this.#read(thread, guide, window);
      control = this.#named(snapshot, name.trim());
      box = control;
    } else {
      if (target === undefined) throw invalidParams('point at a rectangle needs the window\'s target', { field: 'target' });
      const problem = windowCropError(at);
      if (problem) throw invalidParams(problem.replace(/^crop/, 'at').replace(/a crop/, 'a rectangle'), { field: 'at' });
      window = await this.#host.grantedWindow(thread, target, null, connection);
      box = this.#rectangle(window, at!);
    }

    const guide = await this.#load();
    const frame = guide.frame(window.id);
    if (frame === null) throw refused(`window ${window.id} of ${window.process} is gone`, { windowId: window.id, code: 'gone' });
    const screen = { left: frame.rect.left + box.x, top: frame.rect.top + box.y, width: box.width, height: box.height };
    // Without a label, a control's box says its name.
    const shownLabel = label === '' && control ? control.name.slice(0, WINDOW_POINT_LABEL_MAX) : label;
    const boxId = newId('box_');
    if (this.#core.subscribers.pointer({ id: boxId, rect: frame.minimized ? null : screen, label: shownLabel }) === 0) {
      throw refused('the box is drawn by the Boite desktop app of this computer, and none is open: ask the user to open Boite', { code: 'no-app' });
    }
    this.#remove(thread.id, 'cleared');
    const pointer: WindowPointer = {
      windowId: window.id, process: window.process, label: shownLabel,
      x: box.x, y: box.y, width: box.width, height: box.height, expiresAt: Date.now() + seconds * 1000,
      ...(control ? { control: { type: control.type, name: control.name } } : {}),
      ...(frame.above ? { behind: true as const } : {}),
    };
    const shown: Shown = {
      pointer, window, boxId, screen: frame.minimized ? null : screen, waiters: new Set(),
      follow: setInterval(() => this.#follow(thread.id, shown, guide), this.#followMs),
      expiry: setTimeout(() => this.#remove(thread.id, 'timeout', shown), seconds * 1000),
    };
    shown.follow.unref?.();
    shown.expiry.unref?.();
    this.#shown.set(thread.id, shown);
    this.#core.logs.info(`Pointed at a ${control?.type ?? 'rectangle'} of window ${window.id} of ${window.process}`, { source: 'windows', event: 'window.point', threadId: thread.id, data: { windowId: window.id, process: window.process, width: box.width, height: box.height } });
    return { pointer: { ...pointer } };
  }

  async waitClick({ threadId, timeoutSeconds }: RpcParams<'windows.waitClick'>, connection?: Connection): Promise<RpcResult<'windows.waitClick'>> {
    const thread = this.#host.activeThread(threadId, connection);
    const seconds = this.#seconds(timeoutSeconds, 'timeoutSeconds');
    const shown = this.#shown.get(thread.id);
    if (!shown) throw refused('nothing is pointed at in this conversation: run `boite window point` first', { threadId });
    const guide = await this.#load();
    // The box outlives the wait, even when it was drawn for less, so a wait that times out can be followed by another.
    const until = Date.now() + seconds * 1000 + WAIT_GRACE_MS;
    if (until > shown.pointer.expiresAt) {
      clearTimeout(shown.expiry);
      shown.pointer.expiresAt = until;
      shown.expiry = setTimeout(() => this.#remove(thread.id, 'timeout', shown), until - Date.now());
      shown.expiry.unref?.();
    }
    const end = await new Promise<WindowWaitEnd | 'clicked'>(resolve => {
      // A button already held when the wait starts is not this click.
      let held = true;
      const poll = setInterval(() => {
        let mouse: { pressed: boolean; x: number; y: number };
        try { mouse = guide.mouse(); } catch { return; }
        const at = shown.screen;
        if (mouse.pressed && !held && at !== null && mouse.x >= at.left && mouse.x < at.left + at.width && mouse.y >= at.top && mouse.y < at.top + at.height) {
          finish('clicked');
          return;
        }
        held = mouse.pressed;
      }, this.#mouseMs);
      const timer = setTimeout(() => finish('timeout'), seconds * 1000);
      const finish = (reason: WindowWaitEnd | 'clicked') => {
        clearInterval(poll);
        clearTimeout(timer);
        shown.waiters.delete(finish);
        resolve(reason);
      };
      shown.waiters.add(finish);
    });
    if (end !== 'clicked') return { clicked: false, reason: end };
    this.#core.logs.info(`The person clicked the box over window ${shown.window.id} of ${shown.window.process}`, { source: 'windows', event: 'window.click', threadId: thread.id, data: { windowId: shown.window.id, process: shown.window.process } });
    this.#remove(thread.id, 'cleared', shown);
    return { clicked: true, pointer: { ...shown.pointer } };
  }

  unpoint({ threadId }: RpcParams<'windows.unpoint'>, connection?: Connection): RpcResult<'windows.unpoint'> {
    this.#host.activeThread(threadId, connection);
    return { cleared: this.#remove(threadId, 'cleared') };
  }

  /** An archived or deleted conversation's box and last read. */
  release(threadId: string): void {
    this.#remove(threadId, 'cleared');
    this.#snapshots.delete(threadId);
  }

  stop(): void {
    for (const threadId of [...this.#shown.keys()]) this.#remove(threadId, 'cleared');
    this.#snapshots.clear();
  }

  async #load(): Promise<WindowGuide> {
    this.#backend ??= this.#loader().catch(error => ({ unavailable: `the on-screen guide failed to load: ${messageOf(error)}` }));
    const backend = await this.#backend;
    if ('unavailable' in backend) throw refused(backend.unavailable);
    return backend;
  }

  /** Reads the window's controls in its own pixels and keeps them as the conversation's last read. */
  async #read(thread: ThreadSummary, guide: WindowGuide, window: NativeWindow): Promise<Snapshot> {
    const frame = guide.frame(window.id);
    if (frame === null) throw refused(`window ${window.id} of ${window.process} is gone`, { windowId: window.id, code: 'gone' });
    let found: Awaited<ReturnType<WindowGuide['controls']>>;
    try {
      found = await guide.controls(window.id, READ_SCAN);
    } catch (error) {
      throw refused(`reading the controls of ${window.process} failed: ${messageOf(error)}`, { windowId: window.id });
    }
    const { left, top, width, height } = frame.rect;
    const controls: WindowControl[] = [];
    for (const control of found.controls) {
      // A control scrolled out of the window can still say it is on screen.
      const x = control.rect.left - left, y = control.rect.top - top;
      if (x + control.rect.width <= 0 || y + control.rect.height <= 0 || x >= width || y >= height) continue;
      controls.push({
        id: controls.length + 1, type: control.type, name: control.name,
        ...(control.automationId ? { automationId: control.automationId } : {}),
        x, y, width: control.rect.width, height: control.rect.height,
      });
    }
    const snapshot = { window, controls };
    this.#snapshots.set(thread.id, snapshot);
    this.#core.logs.info(`Read ${controls.length} controls of window ${window.id} of ${window.process}`, { source: 'windows', event: 'window.read', threadId: thread.id, data: { windowId: window.id, process: window.process, controls: controls.length } });
    return snapshot;
  }

  /** The one control named `name`: an exact match without case first, then the names that contain it. */
  #named(snapshot: Snapshot, name: string): WindowControl {
    const wanted = name.toLowerCase();
    let matches = snapshot.controls.filter(control => control.name.toLowerCase() === wanted);
    if (matches.length === 0) matches = snapshot.controls.filter(control => control.name.toLowerCase().includes(wanted));
    if (matches.length === 1) return matches[0]!;
    const process = snapshot.window.process;
    if (matches.length === 0) throw refused(`no control of ${process} is named "${name}": \`boite window read\` lists them`, { field: 'name' });
    throw refused(`${matches.length} controls of ${process} match "${name}"; point at one by id:\n${matches.slice(0, 10).map(controlLine).join('\n')}`, { field: 'name' });
  }

  /** `at` in the window's pixels, kept inside the window. */
  #rectangle(window: NativeWindow, at: WindowCrop): { x: number; y: number; width: number; height: number } {
    const rect = cropRect(at, window.width, window.height);
    if (rect.width <= 0 || rect.height <= 0) throw refused(`at lies outside the ${window.width}x${window.height} window`, { field: 'at' });
    return rect;
  }

  #seconds(value: number | undefined, field: string): number {
    if (value === undefined) return WINDOW_POINT_SECONDS.default;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > WINDOW_POINT_SECONDS.max) {
      throw invalidParams(`${field} must lie between 1 and ${WINDOW_POINT_SECONDS.max}`, { field });
    }
    return value;
  }

  /** The box goes where its window went, hides while the window is minimized and goes away with it. */
  #follow(threadId: string, shown: Shown, guide: WindowGuide): void {
    if (this.#shown.get(threadId) !== shown) return;
    const frame = guide.frame(shown.window.id);
    if (frame === null) {
      this.#remove(threadId, 'gone', shown);
      return;
    }
    const screen = frame.minimized ? null : { left: frame.rect.left + shown.pointer.x, top: frame.rect.top + shown.pointer.y, width: shown.pointer.width, height: shown.pointer.height };
    if (sameRect(screen, shown.screen)) return;
    shown.screen = screen;
    this.#core.subscribers.pointer({ id: shown.boxId, rect: screen, label: shown.pointer.label });
  }

  /** Takes the conversation's box away, or only `only` when given, and ends the waits on it. */
  #remove(threadId: string, why: WindowWaitEnd, only?: Shown): boolean {
    const shown = this.#shown.get(threadId);
    if (!shown || (only !== undefined && shown !== only)) return false;
    this.#shown.delete(threadId);
    clearInterval(shown.follow);
    clearTimeout(shown.expiry);
    this.#core.subscribers.pointer({ id: shown.boxId, rect: null, label: shown.pointer.label });
    for (const finish of [...shown.waiters]) finish(why);
    this.#core.logs.info(`Box over window ${shown.window.id} of ${shown.window.process} taken away: ${why}`, { source: 'windows', event: 'window.unpoint', threadId, data: { windowId: shown.window.id, process: shown.window.process, why } });
    return true;
  }
}
