/*
 * `boite window`'s core half: the machine's desktop windows, captures of one
 * of them to a PNG or a contact sheet, and the conversation's Window panel.
 * The OS half is `ProcessPlatform.windowCapture`, loaded by the first call.
 *
 * Privacy before pixels: an excluded app is never captured, a window's title
 * reaches only an app its project allows, and an app the project does not
 * allow waits for the owner's answer on a consent card. Pictures go only to
 * the file asked for, in the conversation's folder, its project or its
 * temporary folder, and to the card's thumbnail; never to a log. See
 * docs/windows.md.
 */
import {
  WINDOW_CAPTURE_EXCLUDED,
  WINDOW_CLIP_LIMITS,
  WINDOW_CONSENT_ANSWERS,
  WINDOW_CONSENT_TIMEOUT_MS,
  WINDOW_SHOT_MAX,
  WINDOW_THUMBNAIL_MAX,
  windowCropError,
  windowIdError,
  windowTargetError,
  type AgentLetter,
  type AllowedWindowApp,
  type DesktopWindow,
  type Message,
  type MessagePart,
  type ProjectId,
  type RpcParams,
  type RpcResult,
  type ThreadSummary,
  type WindowCaptureKind,
  type WindowConsentAnswer,
  type WindowConsentKind,
  type WindowFrame,
  type WindowFrameUnchanged,
  type WindowTarget,
  type WindowWatch,
} from '@boite/contracts';
import { lstatSync, mkdirSync, realpathSync, type Stats, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { processPlatform } from '../platform/index.ts';
import type { NativeWindow, WindowCapture, WindowFrames, WindowGuide, WindowPixels } from '../platform/types.ts';
import { isBlank, WindowCaptureError } from '../platform/window-pixels.ts';
import type { Connection } from '../router.ts';
import { WindowGuides, type WindowGuidesOptions } from './guide.ts';
import { contactSheet, cropPixels, cropRect, encode, fit, shrink, sheetTile, type SheetFrame } from './image.ts';

/** A picture is shared by every viewer that asks within this long, as the Device panel does. */
const CAPTURE_REUSE_MS = 200;
/** A Window panel nobody asked a frame of for this long lets the OS capture go. */
const STREAM_IDLE_MS = 10_000;
/** How often a stream checks that its window id still names the same app. */
const STREAM_RECHECK_MS = 2_000;
const FRAME_WIDTH = { min: 160, max: 3840, default: 1280 } as const;
const FRAME_QUALITY = { min: 30, max: 90, default: 70 } as const;

type Grant = 'allowed' | 'once' | 'always';

interface Watch extends WindowWatch {
  pid: number;
  path: string;
  grant: Grant;
}

interface Stream {
  threadId: string;
  windowId: string;
  frames: WindowFrames;
  idle: ReturnType<typeof setTimeout>;
  checkedAt: number;
  last?: { at: number; picture: Promise<{ pixels: WindowPixels; hash: string }> };
}

interface Consent {
  threadId: string;
  path: string;
  messageId: string;
  part: Extract<MessagePart, { type: 'window_consent' }>;
  promise: Promise<Grant>;
  settle(answer: WindowConsentAnswer | 'expired'): void;
}

export interface DesktopWindowsOptions {
  /** A backend in place of the OS's, for tests. */
  backend?: () => Promise<WindowCapture | { unavailable: string }>;
  consentTimeoutMs?: number;
  /** Where captures without `output` go, one folder per conversation. */
  tempRoot?: string;
  /** The OS half of `boite window read` and `point` in place of the OS's, for tests. */
  guide?: () => Promise<WindowGuide | { unavailable: string }>;
  /** How often a box follows its window and a wait reads the mouse, for tests. */
  guideTiming?: WindowGuidesOptions;
}

/** The executable's name as targets and exclusions compare it: lower case, `.exe` dropped. */
const appName = (name: string) => name.toLowerCase().replace(/\.exe$/, '');
/** An executable's path as the allowlist compares it: case only folds where the file system does. */
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

export class DesktopWindows {
  readonly #core: Core;
  readonly #backendLoader: () => Promise<WindowCapture | { unavailable: string }>;
  readonly #consentTimeoutMs: number;
  readonly #tempRoot: string;
  #backend?: Promise<WindowCapture | { unavailable: string }>;
  readonly #watches = new Map<string, Watch>();
  readonly #streams = new Map<string, Stream>();
  /** By request id, and by `threadId\nkind\npath` so two captures of one kind of one app share one card. */
  readonly #consents = new Map<string, Consent>();
  #tableReady = false;
  #closed = false;
  readonly #guide: WindowGuides;

  constructor(core: Core, options: DesktopWindowsOptions = {}) {
    this.#core = core;
    this.#backendLoader = options.backend ?? (async () => processPlatform.windowCapture?.() ?? { unavailable: 'window capture is not available on this platform' });
    this.#consentTimeoutMs = options.consentTimeoutMs ?? WINDOW_CONSENT_TIMEOUT_MS;
    this.#tempRoot = options.tempRoot ?? join(tmpdir(), 'boite-windows');
    const guide = options.guide ?? (async () => processPlatform.windowGuide?.() ?? { unavailable: 'the on-screen guide is only available on Windows' });
    this.#guide = new WindowGuides(core, this, guide, options.guideTiming);
  }

  async list({ threadId }: RpcParams<'windows.list'>, connection?: Connection): Promise<RpcResult<'windows.list'>> {
    const thread = this.#thread(threadId, connection);
    const watch = this.#publicWatch(threadId);
    const backend = await this.#load();
    if ('unavailable' in backend) return { windows: [], support: { available: false, reason: backend.unavailable }, watch };
    const allowed = this.#allowedPaths(thread.projectId);
    const windows = (await backend.list()).map(window => this.#describe(window, allowed));
    return { windows, support: { available: true }, watch };
  }

  async screenshot(params: RpcParams<'windows.screenshot'>, connection?: Connection): Promise<RpcResult<'windows.screenshot'>> {
    const thread = this.#thread(params.threadId, connection);
    const max = this.#max(params.max);
    if (params.crop !== undefined) {
      const problem = windowCropError(params.crop);
      if (problem) throw invalidParams(problem, { field: 'crop' });
    }
    const output = this.#output(thread, params.output);
    const { backend, window } = await this.#granted(thread, params.target, 'screenshot', connection);
    let pixels = await this.#capture(backend, window);
    const source = { width: pixels.width, height: pixels.height };
    if (params.crop) {
      const rect = cropRect(params.crop, pixels.width, pixels.height);
      if (rect.width <= 0 || rect.height <= 0) throw refused(`crop lies outside the ${pixels.width}x${pixels.height} window`, { field: 'crop' });
      pixels = cropPixels(pixels, rect);
    }
    const png = await encode(pixels, 'png', max);
    this.#write(output, png.bytes);
    const shot = { windowId: window.id, process: window.process, path: output, width: png.width, height: png.height, source };
    this.#core.logs.info(`Captured window ${window.id} of ${window.process} to a ${png.width}x${png.height} PNG`, { source: 'windows', event: 'window.screenshot', threadId: thread.id, data: { windowId: window.id, process: window.process, width: png.width, height: png.height, via: pixels.via } });
    await this.#card(thread, 'screenshot', window, pixels, png, { path: output });
    return shot;
  }

  async clip(params: RpcParams<'windows.clip'>, connection?: Connection): Promise<RpcResult<'windows.clip'>> {
    const thread = this.#thread(params.threadId, connection);
    const max = this.#max(params.max);
    const seconds = params.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0.5 || seconds > WINDOW_CLIP_LIMITS.seconds) {
      throw invalidParams(`seconds must lie between 0.5 and ${WINDOW_CLIP_LIMITS.seconds}`, { field: 'seconds' });
    }
    const fps = params.fps ?? 2;
    if (!Number.isInteger(fps) || fps < 1 || fps > WINDOW_CLIP_LIMITS.fps) throw invalidParams(`fps must be a whole number from 1 to ${WINDOW_CLIP_LIMITS.fps}`, { field: 'fps' });
    const output = this.#output(thread, params.output);
    const { backend, window } = await this.#granted(thread, params.target, 'clip', connection);
    const count = Math.max(1, Math.round(seconds * fps));
    const frames: SheetFrame[] = [];
    const stream = backend.frames(window.id);
    let source: { width: number; height: number } | null = null;
    let tile: { width: number; height: number } | null = null;
    let first: WindowPixels | null = null;
    const start = performance.now();
    try {
      for (let index = 0; index < count; index++) {
        const due = start + index * 1000 / fps;
        const wait = due - performance.now();
        if (wait > 0) await Bun.sleep(wait);
        const at = performance.now();
        const pixels = await this.#pixels(() => stream.next(), window);
        source ??= { width: pixels.width, height: pixels.height };
        tile ??= sheetTile(count, source, max);
        first ??= shrink(pixels, ...fitArgs(pixels, WINDOW_THUMBNAIL_MAX));
        frames.push({ pixels: shrink(pixels, tile.width, tile.height), at: (at - start) / 1000 });
      }
    } finally {
      stream.close();
    }
    const sheet = contactSheet(frames, source!, max);
    const png = await encode(sheet, 'png', 0);
    this.#write(output, png.bytes);
    this.#core.logs.info(`Captured ${count} frames of window ${window.id} of ${window.process} to a ${png.width}x${png.height} contact sheet`, { source: 'windows', event: 'window.clip', threadId: thread.id, data: { windowId: window.id, process: window.process, frames: count, fps, width: png.width, height: png.height } });
    await this.#card(thread, 'clip', window, first!, png, { path: output, frames: count });
    return { windowId: window.id, process: window.process, path: output, width: png.width, height: png.height, source: source!, frames: count, seconds, fps };
  }

  async watch({ threadId, target }: RpcParams<'windows.watch'>, connection?: Connection): Promise<RpcResult<'windows.watch'>> {
    const thread = this.#thread(threadId, connection);
    const { window, grant } = await this.#granted(thread, target, 'stream', connection);
    this.#stopStream(threadId);
    const watch: Watch = { windowId: window.id, process: window.process, ...(grant !== 'once' ? { title: window.title } : {}), openedAt: Date.now(), pid: window.pid, path: window.path, grant };
    this.#watches.set(threadId, watch);
    this.#core.logs.info(`Window ${window.id} of ${window.process} opened in the Window panel`, { source: 'windows', event: 'window.watch', threadId, data: { windowId: window.id, process: window.process } });
    this.#changed(threadId);
    return { watch: this.#publicWatch(threadId)! };
  }

  async frame({ threadId, windowId, maxWidth, quality, previous }: RpcParams<'windows.frame'>, connection?: Connection): Promise<WindowFrame | WindowFrameUnchanged> {
    const thread = this.#thread(threadId, connection);
    const problem = windowIdError(windowId);
    if (problem) throw refused(problem, { windowId });
    const watch = this.#watches.get(threadId);
    if (!watch || watch.windowId !== windowId) throw refused(`window ${windowId} is not open in this conversation's Window panel`, { windowId });
    const width = bounded(maxWidth, FRAME_WIDTH, 'maxWidth');
    const jpegQuality = bounded(quality, FRAME_QUALITY, 'quality');
    if ((watch.grant === 'always' || watch.grant === 'allowed') && !this.#allowedPaths(thread.projectId).has(pathKey(watch.path))) {
      this.#close(threadId, 'its app was taken off the project\'s list');
      throw refused(`${watch.process} is no longer allowed in this project`, { windowId });
    }
    if (this.#excluded(watch)) {
      this.#close(threadId, 'its app was added to Never capture');
      throw refused(`${watch.process} is excluded from capture`, { windowId });
    }
    const backend = await this.#load();
    if ('unavailable' in backend) throw refused(backend.unavailable);
    const stream = await this.#stream(thread, backend, watch);
    const now = Date.now();
    if (!stream.last || now - stream.last.at > CAPTURE_REUSE_MS) {
      const picture = this.#pixels(() => stream.frames.next(), watch).then(pixels => ({ pixels, hash: Bun.hash(pixels.bgra).toString(36) }));
      stream.last = { at: now, picture };
      picture.catch(() => { if (stream.last?.picture === picture) stream.last = undefined; });
    }
    let picture: { pixels: WindowPixels; hash: string };
    try {
      picture = await stream.last.picture;
    } catch (error) {
      if (failureCode(error) === 'gone') this.#close(threadId, 'the window closed');
      throw error;
    }
    const size = fit(picture.pixels.width, picture.pixels.height, width);
    const id = `${picture.hash}.${size.width}.${jpegQuality}`;
    if (previous === id) return { id, windowId, width: size.width, height: size.height, unchanged: true, at: now };
    const jpeg = await encode(picture.pixels, 'jpeg', width, jpegQuality);
    return { id, windowId, width: jpeg.width, height: jpeg.height, base64: Buffer.from(jpeg.bytes).toString('base64'), at: now };
  }

  close({ threadId }: RpcParams<'windows.close'>, connection?: Connection): RpcResult<'windows.close'> {
    this.#thread(threadId, connection, true);
    return { closed: this.#close(threadId, 'closed') };
  }

  consent({ threadId, requestId, answer }: RpcParams<'windows.consent'>, connection?: Connection): RpcResult<'windows.consent'> {
    this.#thread(threadId, connection);
    if (!WINDOW_CONSENT_ANSWERS.includes(answer)) throw invalidParams(`answer must be one of ${WINDOW_CONSENT_ANSWERS.join(', ')}`, { field: 'answer' });
    const consent = typeof requestId === 'string' ? this.#consents.get(requestId) : undefined;
    if (!consent || consent.threadId !== threadId) throw refused('this capture request is no longer waiting: the agent asks again if it still needs it', { requestId });
    consent.settle(answer);
    return { ok: true };
  }

  allowlist({ projectId }: RpcParams<'windows.allowlist'>): RpcResult<'windows.allowlist'> {
    this.#core.projects.require(projectId);
    return { apps: this.#apps(projectId) };
  }

  revoke({ projectId, path }: RpcParams<'windows.revoke'>): RpcResult<'windows.revoke'> {
    this.#core.projects.require(projectId);
    if (typeof path !== 'string' || path.length === 0 || path.length > 1024) throw invalidParams('path must be an allowed app\'s path from windows.allowlist', { field: 'path' });
    const removed = this.#apps(projectId).filter(app => pathKey(app.path) === pathKey(path));
    for (const app of removed) this.#core.journal.db.query('DELETE FROM window_allowlist WHERE project_id = ? AND path = ?').run(projectId, app.path);
    if (removed.length > 0) this.#core.logs.info(`${removed[0]!.process} taken off a project's allowed windows`, { source: 'windows', event: 'window.revoked', data: { projectId, process: removed[0]!.process } });
    // A panel showing that app under the old grant closes on its next frame.
    return { apps: this.#apps(projectId) };
  }

  read(params: RpcParams<'windows.read'>, connection?: Connection): Promise<RpcResult<'windows.read'>> {
    return this.#guide.read(params, connection);
  }

  point(params: RpcParams<'windows.point'>, connection?: Connection): Promise<RpcResult<'windows.point'>> {
    return this.#guide.point(params, connection);
  }

  waitClick(params: RpcParams<'windows.waitClick'>, connection?: Connection): Promise<RpcResult<'windows.waitClick'>> {
    return this.#guide.waitClick(params, connection);
  }

  unpoint(params: RpcParams<'windows.unpoint'>, connection?: Connection): RpcResult<'windows.unpoint'> {
    return this.#guide.unpoint(params, connection);
  }

  /** What an archived or deleted conversation leaves: its panel, its box and the captures it waits on. */
  release(threadId: string): void {
    this.#guide.release(threadId);
    this.#close(threadId, 'released');
    for (const consent of new Set(this.#consents.values())) if (consent.threadId === threadId) consent.settle('expired');
  }

  stop(): void {
    if (this.#closed) return;
    for (const consent of new Set(this.#consents.values())) consent.settle('expired');
    this.#closed = true;
    this.#guide.stop();
    for (const threadId of [...this.#streams.keys()]) this.#stopStream(threadId);
    this.#watches.clear();
  }

  // --- access -------------------------------------------------------------

  /** The conversation `WindowGuides` acts for, refused as a capture's would be. */
  activeThread(threadId: string, connection?: Connection): ThreadSummary {
    return this.#thread(threadId, connection);
  }

  /**
   * For `WindowGuides`: the one window a target names once its controls may be
   * read (`read`, with a card for an app the project does not allow) or a box
   * drawn over it (null: no card, since nothing of the window is read).
   */
  async grantedWindow(thread: ThreadSummary, target: WindowTarget, kind: 'read' | null, connection?: Connection): Promise<NativeWindow> {
    return (await this.#granted(thread, target, kind, connection)).window;
  }

  #thread(threadId: string, connection?: Connection, allowArchived = false): ThreadSummary {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived && !allowArchived) throw refused('window capture needs an active conversation', { threadId });
    if (connection?.identity.principal === 'session' && !connection.subscriptions.has(threadId)) {
      throw refused('subscribe to the conversation before using its Window panel', { threadId });
    }
    return thread;
  }

  async #load(): Promise<WindowCapture | { unavailable: string }> {
    this.#backend ??= this.#backendLoader().catch(error => ({ unavailable: `window capture failed to load: ${messageOf(error)}` }));
    return this.#backend;
  }

  /**
   * The one window the target names, once it may be captured: not excluded,
   * not minimized, not asked for while a contact's letter drives the turn,
   * and allowed by the project or by the owner on a card.
   */
  async #granted(thread: ThreadSummary, target: WindowTarget, kind: WindowConsentKind | null, connection?: Connection): Promise<{ backend: WindowCapture; window: NativeWindow; grant: Grant }> {
    const problem = windowTargetError(target);
    if (problem) throw invalidParams(problem, { field: 'target' });
    const backend = await this.#load();
    if ('unavailable' in backend) throw refused(backend.unavailable);
    const allowed = this.#allowedPaths(thread.projectId);
    const window = this.#resolve(await backend.list(), target, allowed);
    if (this.#excluded(window)) throw refused(`${window.process} is never captured: password managers, the sign-in screen and the apps in Settings > Window capture are excluded`, { windowId: window.id });
    if (window.minimized) throw refused('window minimized: restore it first', { windowId: window.id });
    if (connection?.identity.principal === 'agent' && this.#contactWroteThisTurn(thread.id)) {
      throw refused('a contact\'s letter is part of this turn: windows are captured only for the owner\'s own requests', { threadId: thread.id });
    }
    // A box drawn over the window reads nothing of it: no card.
    if (kind === null) return { backend, window, grant: 'once' };
    if (window.path === '') throw refused(`the system does not tell which program owns window ${window.id}, so it cannot be allowed`, { windowId: window.id });
    if (allowed.has(pathKey(window.path))) return { backend, window, grant: 'allowed' };
    const grant = await this.#ask(thread, window, kind);
    // The answer can come minutes later: the id may name another program by then, or the app may be excluded or minimized.
    const current = (await backend.list()).find(candidate => candidate.id === window.id);
    if (!current || current.pid !== window.pid || pathKey(current.path) !== pathKey(window.path)) {
      throw refused(`window ${window.id} of ${window.process} is gone`, { windowId: window.id, code: 'gone' });
    }
    if (this.#excluded(current)) throw refused(`${current.process} is never captured: password managers, the sign-in screen and the apps in Settings > Window capture are excluded`, { windowId: current.id });
    if (current.minimized) throw refused('window minimized: restore it first', { windowId: current.id, code: 'minimized' });
    return { backend, window: current, grant };
  }

  /**
   * Whether a contact's letter reached the conversation since its last
   * finished turn: the turn at work may be doing what that contact asked, and
   * the owner's desktop is the owner's alone. Reads coordination.ts's letters.
   */
  #contactWroteThisTurn(threadId: string): boolean {
    const db = this.#core.journal.db;
    const last = db.query('SELECT MAX(finished_at) AS at FROM turns WHERE thread_id = ? AND finished_at IS NOT NULL').get(threadId) as { at: number | null } | null;
    const rows = db.query('SELECT data FROM coordination_letters WHERE thread_id = ? AND direction = ? AND created_at >= ?').all(threadId, 'in', last?.at ?? 0) as { data: string }[];
    return rows.some(row => { const letter = JSON.parse(row.data) as AgentLetter; return letter.contact !== undefined || letter.origin === 'contact'; });
  }

  #resolve(windows: NativeWindow[], target: WindowTarget, allowed: Set<string>): NativeWindow {
    let matches: NativeWindow[];
    let named: string;
    if (target.id !== undefined) {
      matches = windows.filter(window => window.id === target.id);
      named = `window ${target.id}`;
    } else if (target.process !== undefined) {
      const name = appName(target.process.trim());
      matches = windows.filter(window => appName(window.process) === name);
      named = `a window of ${target.process.trim()}`;
    } else {
      const part = target.title!.trim().toLowerCase();
      matches = windows.filter(window => allowed.has(pathKey(window.path)) && !this.#excluded(window) && window.title.toLowerCase().includes(part));
      named = 'an allowed app\'s window with that title';
    }
    if (matches.length === 0) throw refused(`no ${named}: \`boite window list\` shows the windows${target.title !== undefined ? ', and titles only for apps the project allows' : ''}`, { target });
    if (matches.length > 1) {
      const candidates = matches.slice(0, 20).map(window => this.#candidate(window, allowed));
      throw refused(`${matches.length} windows match; name one with --id:\n${candidates.join('\n')}`, { target, candidates: matches.map(window => window.id) });
    }
    return matches[0]!;
  }

  #candidate(window: NativeWindow, allowed: Set<string>): string {
    const shown = this.#describe(window, allowed);
    return `  ${shown.id}  ${shown.process}  ${shown.width}x${shown.height}${shown.minimized ? '  minimized' : ''}${shown.title ? `  "${shown.title}"` : ''}`;
  }

  #describe(window: NativeWindow, allowed: Set<string>): DesktopWindow {
    const excluded = this.#excluded(window);
    const isAllowed = !excluded && window.path !== '' && allowed.has(pathKey(window.path));
    return {
      id: window.id,
      process: window.process,
      pid: window.pid,
      width: window.width,
      height: window.height,
      minimized: window.minimized,
      ...(isAllowed && window.title ? { title: window.title } : {}),
      allowed: isAllowed,
      ...(excluded ? { excluded: true as const } : {}),
    };
  }

  #excluded(window: { process: string; path: string }): boolean {
    const name = appName(window.process);
    // Exclusions fold case on every system: a near match excludes too much, never too little.
    const path = window.path.toLowerCase();
    const extra = this.#core.settings.get().windowCaptureExclusions ?? [];
    return [...WINDOW_CAPTURE_EXCLUDED, ...extra].some(entry => {
      const value = entry.trim().toLowerCase();
      return value.length > 0 && (appName(value) === name || (path !== '' && value === path));
    });
  }

  // --- consent ------------------------------------------------------------

  async #ask(thread: ThreadSummary, window: NativeWindow, kind: WindowConsentKind): Promise<Grant> {
    // Only the same kind shares a card: an answer to "a screenshot" never lets a clip or a live view through.
    const key = `${thread.id}\n${kind}\n${pathKey(window.path)}`;
    const waiting = this.#consents.get(key);
    if (waiting) return waiting.promise;
    const turn = this.#core.journal.runningTurn(thread.id) ?? this.#core.journal.lastTurn(thread.id);
    if (turn === null) throw refused(`${window.process} is not allowed in this project, and the conversation has no turn to ask the owner in`, { threadId: thread.id });
    const requestId = newId('req_');
    const part: Extract<MessagePart, { type: 'window_consent' }> = {
      type: 'window_consent', requestId, kind, process: window.process, path: window.path, expiresAt: Date.now() + this.#consentTimeoutMs, answer: null,
    };
    const message: Message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt: Date.now() };
    let settle!: (answer: WindowConsentAnswer | 'expired') => void;
    const promise = new Promise<WindowConsentAnswer | 'expired'>(resolve => { settle = resolve; });
    const consent: Consent = { threadId: thread.id, path: window.path, messageId: message.id, part, promise: null as unknown as Promise<Grant>, settle: answer => settle(answer) };
    const timer = setTimeout(() => settle('expired'), this.#consentTimeoutMs);
    consent.promise = promise.then(answer => {
      clearTimeout(timer);
      this.#consents.delete(key);
      this.#consents.delete(requestId);
      this.#fold(consent, answer);
      this.#core.logs.info(`Capture of ${window.process} ${answer === 'expired' ? 'not answered in time' : answer === 'refuse' ? 'refused by the owner' : `allowed ${answer === 'once' ? 'once' : 'for the project'}`}`, { source: 'windows', event: 'window.consent', threadId: thread.id, data: { process: window.process, answer } });
      if (answer === 'refuse') throw refused(`the owner refused the capture of ${window.process}`, { process: window.process });
      if (answer === 'expired') throw refused(`nobody answered the capture request for ${window.process} within ${Math.round(this.#consentTimeoutMs / 60_000)} minutes`, { process: window.process });
      if (answer === 'always' && thread.projectId !== null) this.#allow(thread.projectId, window);
      return answer === 'always' && thread.projectId !== null ? 'always' : 'once';
    });
    this.#consents.set(key, consent);
    this.#consents.set(requestId, consent);
    this.#core.journal.append({ type: 'message.started', threadId: thread.id, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    return consent.promise;
  }

  #fold(consent: Consent, answer: WindowConsentAnswer | 'expired'): void {
    // A deleted conversation has no card left to answer.
    if (this.#core.journal.isClosed() || this.#core.journal.getThread(consent.threadId) === null) return;
    const part: MessagePart = { ...consent.part, answer };
    const threadId = consent.threadId;
    this.#core.journal.append(
      { type: 'message.part', threadId, version: 1, payload: { messageId: consent.messageId, partIndex: 0, part } },
      () => this.#core.journal.setMessagePart(consent.messageId, 0, part),
    );
    this.#core.bus.emit('message.part', { threadId, messageId: consent.messageId, partIndex: 0, part });
  }

  // --- allowlist ----------------------------------------------------------

  #table(): void {
    if (this.#tableReady) return;
    this.#core.journal.db.exec(`CREATE TABLE IF NOT EXISTS window_allowlist (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      process TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    )`);
    this.#tableReady = true;
  }

  #apps(projectId: ProjectId | string): AllowedWindowApp[] {
    this.#table();
    return (this.#core.journal.db.query('SELECT path, process, added_at FROM window_allowlist WHERE project_id = ? ORDER BY added_at').all(projectId) as { path: string; process: string; added_at: number }[])
      .map(row => ({ path: row.path, process: row.process, addedAt: row.added_at }));
  }

  /** Lower-cased paths: Windows paths compare without case, and an X11 app's path is its own `/proc` link. */
  #allowedPaths(projectId: ProjectId | string | null): Set<string> {
    if (projectId === null) return new Set();
    return new Set(this.#apps(projectId).map(app => pathKey(app.path)));
  }

  #allow(projectId: ProjectId | string, window: NativeWindow): void {
    this.#table();
    this.#core.journal.db.query('INSERT OR IGNORE INTO window_allowlist (project_id, path, process, added_at) VALUES (?, ?, ?, ?)').run(projectId, window.path, window.process, Date.now());
  }

  // --- pictures -----------------------------------------------------------

  async #capture(backend: WindowCapture, window: NativeWindow): Promise<WindowPixels> {
    return this.#pixels(() => backend.capture(window.id), window);
  }

  /** One picture, with the backend's failures in the words an agent reads. */
  async #pixels(take: () => Promise<WindowPixels>, window: { process: string }): Promise<WindowPixels> {
    let pixels: WindowPixels;
    try {
      pixels = await take();
    } catch (error) {
      if (error instanceof WindowCaptureError) throw refused(error.message, { code: error.code });
      throw refused(`capturing ${window.process} failed: ${messageOf(error)}`);
    }
    if (isBlank(pixels)) throw refused(`the capture of ${window.process} came out black: a window drawn by the GPU in exclusive full screen, or protected content, cannot be captured`, { code: 'black' });
    return pixels;
  }

  /** The capture's card in the conversation, with a small JPEG of what was taken; size is the file's, or the window's for a stream. */
  async #card(thread: ThreadSummary, kind: WindowCaptureKind, window: { id: string; process: string }, pixels: WindowPixels, size: { width: number; height: number }, extra: { path?: string; frames?: number }): Promise<void> {
    const turn = this.#core.journal.runningTurn(thread.id) ?? this.#core.journal.lastTurn(thread.id);
    if (turn === null || this.#core.journal.isClosed()) return;
    const thumb = await encode(pixels, 'jpeg', WINDOW_THUMBNAIL_MAX, 60);
    const part: MessagePart = {
      type: 'window_capture', kind, windowId: window.id, process: window.process, width: size.width, height: size.height, at: Date.now(),
      thumbnail: { data: Buffer.from(thumb.bytes).toString('base64'), width: thumb.width, height: thumb.height },
      ...extra,
    };
    const message: Message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt: Date.now() };
    this.#core.journal.append({ type: 'message.started', threadId: thread.id, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
  }

  #max(max: number | undefined): number {
    if (max === undefined) return WINDOW_SHOT_MAX;
    if (!Number.isInteger(max) || max < 0 || max > 16384) throw invalidParams('max must be a whole number of pixels from 0 (full size) to 16384', { field: 'max' });
    return max;
  }

  /**
   * The PNG's path: absolute, ending in .png, in a folder inside the
   * conversation's folder, its project or its temporary folder, once links are
   * followed. Without one, a new file in the temporary folder.
   */
  #output(thread: ThreadSummary, output: string | undefined): string {
    const temp = join(this.#tempRoot, thread.id);
    if (output === undefined) return join(this.#temp(thread), `window-${new Date().toISOString().replace(/[:.]/g, '-')}-${newId('').slice(-6)}.png`);
    if (typeof output !== 'string' || output.length > 1024 || /\p{Cc}/u.test(output) || !isAbsolute(output) || !output.toLowerCase().endsWith('.png')) {
      throw invalidParams('output must be an absolute path to a new .png file', { field: 'output' });
    }
    const roots = [thread.cwd, temp];
    if (thread.projectId !== null) {
      const project = this.#core.journal.getProject(thread.projectId);
      if (project) roots.push(project.path);
    }
    if (output.startsWith(temp)) this.#temp(thread);
    let folder: string;
    try {
      folder = realpathSync(dirname(resolve(output)));
    } catch {
      throw invalidParams(`output's folder ${dirname(output)} does not exist`, { field: 'output' });
    }
    const inside = roots.some(root => {
      let real: string;
      try { real = realpathSync(root); } catch { return false; }
      const rel = relative(process.platform === 'win32' ? real.toLowerCase() : real, process.platform === 'win32' ? folder.toLowerCase() : folder);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!inside) throw refused(`output must be inside the conversation's folder ${thread.cwd}, its project or ${temp}`, { field: 'output' });
    return join(folder, basename(output));
  }

  /**
   * The conversation's temporary folder, real path. On a shared /tmp another
   * user could create it first, or put a link there: both are refused.
   */
  #temp(thread: ThreadSummary): string {
    const temp = join(this.#tempRoot, thread.id);
    // A file or a link in the way makes mkdir fail: the checks below say which one to remove.
    try { mkdirSync(temp, { recursive: true, mode: 0o700 }); } catch { /* checked below */ }
    for (const folder of [this.#tempRoot, temp]) {
      let stat: Stats | undefined;
      try { stat = lstatSync(folder); } catch { /* missing: refused below */ }
      if (!stat?.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
        throw refused(`${folder} is not a folder of this user's: remove it and capture again`, { field: 'output' });
      }
    }
    return realpathSync(temp);
  }

  #write(path: string, bytes: Uint8Array): void {
    // The folder was checked before the owner answered, up to 10 minutes ago: one swapped for a link since is refused.
    let folder: string | undefined;
    try { folder = realpathSync(dirname(path)); } catch { /* removed since */ }
    if (folder !== dirname(path)) throw refused(`${dirname(path)} changed while the capture waited: capture again`, { field: 'output' });
    try {
      writeFileSync(path, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw refused(`${path} already exists: choose a new file`, { field: 'output' });
      throw refused(`could not write ${path}: ${messageOf(error)}`, { field: 'output' });
    }
  }

  // --- the Window panel ---------------------------------------------------

  async #stream(thread: ThreadSummary, backend: WindowCapture, watch: Watch): Promise<Stream> {
    let stream = this.#currentStream(thread.id, watch);
    const now = Date.now();
    if (!stream || now - stream.checkedAt > STREAM_RECHECK_MS) {
      // A window id can be reused once its window closes: the panel shows only the app it was opened on.
      const window = (await backend.list()).find(candidate => candidate.id === watch.windowId);
      // The panel may have closed or moved to another window during the wait.
      if (this.#watches.get(thread.id) !== watch) throw refused(`window ${watch.windowId} is not open in this conversation's Window panel`, { windowId: watch.windowId });
      if (!window || window.pid !== watch.pid || pathKey(window.path) !== pathKey(watch.path)) {
        this.#close(thread.id, 'the window closed');
        throw refused(`window ${watch.windowId} of ${watch.process} is gone`, { windowId: watch.windowId, code: 'gone' });
      }
      if (window.minimized) throw refused('window minimized: restore it first', { windowId: watch.windowId, code: 'minimized' });
      // Another viewer may have started the stream during the wait: a second one would never be closed.
      stream = this.#currentStream(thread.id, watch);
      if (stream) stream.checkedAt = now;
    }
    if (stream) {
      clearTimeout(stream.idle);
      stream.idle = setTimeout(() => this.#stopStream(thread.id), STREAM_IDLE_MS);
      return stream;
    }
    stream = { threadId: thread.id, windowId: watch.windowId, frames: backend.frames(watch.windowId), checkedAt: now, idle: setTimeout(() => this.#stopStream(thread.id), STREAM_IDLE_MS) };
    this.#streams.set(thread.id, stream);
    this.#core.logs.info(`Window panel started showing ${watch.process}`, { source: 'windows', event: 'window.stream', threadId: thread.id, data: { windowId: watch.windowId, process: watch.process } });
    // The first picture of a viewing goes on a card, so the conversation records that someone looked at the window.
    const started = stream;
    void this.#pixels(() => started.frames.next(), watch)
      .then(pixels => this.#card(thread, 'stream', { id: watch.windowId, process: watch.process }, pixels, pixels, {}))
      .catch(() => undefined);
    return stream;
  }

  /** The thread's stream when it shows the watched window; a stream of another window stops. */
  #currentStream(threadId: string, watch: Watch): Stream | undefined {
    const stream = this.#streams.get(threadId);
    if (stream && stream.windowId !== watch.windowId) { this.#stopStream(threadId); return undefined; }
    return stream;
  }

  #stopStream(threadId: string): void {
    const stream = this.#streams.get(threadId);
    if (!stream) return;
    this.#streams.delete(threadId);
    clearTimeout(stream.idle);
    try { stream.frames.close(); } catch { /* the OS session is already gone */ }
  }

  #close(threadId: string, why: string): boolean {
    this.#stopStream(threadId);
    const watch = this.#watches.get(threadId);
    if (!watch) return false;
    this.#watches.delete(threadId);
    this.#core.logs.info(`Window panel closed: ${why}`, { source: 'windows', event: 'window.closed', threadId, data: { windowId: watch.windowId, process: watch.process } });
    this.#changed(threadId);
    return true;
  }

  #publicWatch(threadId: string): WindowWatch | null {
    const watch = this.#watches.get(threadId);
    if (!watch) return null;
    return { windowId: watch.windowId, process: watch.process, ...(watch.title ? { title: watch.title } : {}), openedAt: watch.openedAt };
  }

  #changed(threadId: string): void {
    if (this.#closed) return;
    this.#core.bus.emit('windows.changed', { threadId, watch: this.#publicWatch(threadId) });
  }
}

/** The code a refusal from #pixels carries: gone, minimized, lack or ailed. */
function failureCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  return data && typeof data === 'object' ? (data as { code?: string }).code : undefined;
}

function fitArgs(pixels: WindowPixels, max: number): [number, number] {
  const size = fit(pixels.width, pixels.height, max);
  return [size.width, size.height];
}

function bounded(value: number | undefined, range: { min: number; max: number; default: number }, field: string): number {
  if (value === undefined) return range.default;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`${field} must be a number`, { field });
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}
