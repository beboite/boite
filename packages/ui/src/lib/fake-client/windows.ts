import {
  RpcErrorCode, WINDOW_CAPTURE_EXCLUDED, WINDOW_CLIP_LIMITS, WINDOW_CONSENT_ANSWERS, WINDOW_CONSENT_TIMEOUT_MS, WINDOW_POINT_LABEL_MAX, WINDOW_POINT_SECONDS,
  WINDOW_READ_LIMIT, WINDOW_SHOT_MAX, WINDOW_THUMBNAIL_MAX,
  windowCropError, windowIdError, windowTargetError,
  type AllowedWindowApp, type DesktopWindow, type Message, type MessagePart, type Thread, type WindowConsentAnswer, type WindowConsentKind,
  type WindowControl, type WindowPointer, type WindowTarget, type WindowWatch
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeWindowPicture } from './window-screen';
import { DATA_DIR, refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'windows.list' | 'windows.screenshot' | 'windows.clip' | 'windows.watch' | 'windows.frame' | 'windows.close' | 'windows.consent' | 'windows.allowlist' | 'windows.revoke'
  | 'windows.read' | 'windows.point' | 'windows.waitClick' | 'windows.unpoint';

/** A fake desktop window and what only the core knows about it: its executable's path and the hue its picture draws. */
interface FakeWindow {
  id: string;
  process: string;
  pid: number;
  path: string;
  width: number;
  height: number;
  minimized: boolean;
  title: string;
  hue: number;
}

const WINDOWS: FakeWindow[] = [
  { id: '132456', process: 'Unity.exe', pid: 18244, path: 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.32f1\\Editor\\Unity.exe', width: 1920, height: 1080, minimized: false, title: 'Garden - SampleScene - Windows, Mac, Linux - Unity 6', hue: 210 },
  { id: '198722', process: 'blender.exe', pid: 20916, path: 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe', width: 1600, height: 900, minimized: false, title: 'Blender [C:\\art\\garden.blend]', hue: 28 },
  { id: '204188', process: 'Notepad.exe', pid: 9120, path: 'C:\\Windows\\System32\\Notepad.exe', width: 1100, height: 700, minimized: true, title: 'notes.txt - Notepad', hue: 0 },
  { id: '220514', process: 'KeePassXC.exe', pid: 7716, path: 'C:\\Program Files\\KeePassXC\\KeePassXC.exe', width: 1200, height: 800, minimized: false, title: 'Passwords.kdbx - KeePassXC', hue: 130 }
];

/** What `windows.read` finds in each fake window: Unity's menu bar and toolbar, Blender's header. */
const CONTROLS: Record<string, Omit<WindowControl, 'id'>[]> = {
  '132456': [
    ...['File', 'Edit', 'Assets', 'GameObject', 'Component', 'Window', 'Help'].map((name, index) => ({ type: 'MenuItem', name, x: 8 + index * 72, y: 30, width: 68, height: 22 })),
    { type: 'Button', name: 'Play', automationId: 'PlayButton', x: 912, y: 58, width: 32, height: 24 },
    { type: 'Button', name: 'Pause', automationId: 'PauseButton', x: 946, y: 58, width: 32, height: 24 },
    { type: 'TabItem', name: 'Scene', x: 4, y: 92, width: 70, height: 22 },
    { type: 'TabItem', name: 'Game', x: 76, y: 92, width: 70, height: 22 }
  ],
  '198722': [
    ...['File', 'Edit', 'Render', 'Window', 'Help'].map((name, index) => ({ type: 'MenuItem', name, x: 40 + index * 60, y: 2, width: 56, height: 22 })),
    { type: 'TabItem', name: 'Layout', x: 360, y: 2, width: 64, height: 22 }
  ]
};

interface Consent {
  threadId: string;
  message: Message;
  partIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (answer: WindowConsentAnswer | 'expired') => void;
}

const demos = new WeakMap<FakeContext, () => void>();

/** Seeds `?fake=1&windows=1`: captures, consent cards in each state and a watched Unity window on the trace thread. */
export function seedWindowsDemo(ctx: FakeContext): void {
  demos.get(ctx)?.();
}

/** The core's `invalidParams`: a bad field, refused before anything is looked up. */
const invalid = (message: string, field: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message, data: { field } });

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bare = (process: string) => process.toLowerCase().replace(/\.exe$/, '');

/** The picture's size once its longest side fits `max`; 0 keeps the window's size. */
function fit(width: number, height: number, max: number): { width: number; height: number } {
  const side = Math.max(width, height);
  if (max === 0 || side <= max) return { width, height };
  const scale = max / side;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Mirrors packages/core/src/windows/ on a Windows machine with Unity, Blender,
 * a minimized Notepad and KeePassXC open. Captures write nothing: they answer
 * the paths a real one would, and post the same consent and capture parts to
 * the conversation. Frames change once a second, so a viewer polling faster
 * sees `unchanged` in between.
 */
export function windowsMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  const allowed = new Map<string, AllowedWindowApp[]>([
    ['p-boite', [{ path: WINDOWS[0]!.path, process: WINDOWS[0]!.process, addedAt: Date.now() - 86_400_000 }]]
  ]);
  const watches = new Map<string, WindowWatch>();
  /** Each conversation's last read and its box: a fake person clicks the box a second after a wait starts. */
  const reads = new Map<string, { window: FakeWindow; controls: WindowControl[] }>();
  const pointers = new Map<string, { pointer: WindowPointer; timer: ReturnType<typeof setTimeout>; end: Set<(reason: 'clicked' | 'timeout' | 'cleared') => void> }>();
  const unpoint = (threadId: string, reason: 'clicked' | 'timeout' | 'cleared') => {
    const shown = pointers.get(threadId);
    if (!shown) return false;
    pointers.delete(threadId);
    clearTimeout(shown.timer);
    for (const end of [...shown.end]) end(reason);
    return true;
  };
  const streamed = new Set<string>();
  const consents = new Map<string, Consent>();

  const changed = (threadId: string) => ctx.emitToThread(threadId, 'windows.changed', { threadId, watch: watches.get(threadId) ?? null });
  const release = (threadId: string) => {
    for (const consent of consents.values()) if (consent.threadId === threadId) consent.settle('expired');
    streamed.delete(threadId);
    unpoint(threadId, 'cleared');
    reads.delete(threadId);
    if (watches.delete(threadId)) changed(threadId);
  };
  ctx.bus.observe('thread.updated', thread => { if (thread.archived) release(thread.id); });
  ctx.bus.observe('thread.removed', ({ threadId }) => release(threadId));

  const active = (threadId: string): Thread => {
    const thread = ctx.thread(threadId);
    if (thread.archived) throw refusal('window capture needs an active conversation', { threadId });
    return thread;
  };
  const apps = (projectId: string | null | undefined) => (projectId ? allowed.get(projectId) ?? [] : []);
  const isAllowed = (thread: Thread, window: FakeWindow) => apps(thread.projectId).some(app => sameText(app.path, window.path));
  const excluded = (window: FakeWindow) => {
    const listed = [...WINDOW_CAPTURE_EXCLUDED, ...(ctx.settings.windowCaptureExclusions ?? [])];
    return listed.some(entry => sameText(entry, window.process) || sameText(entry, window.path) || sameText(entry, bare(window.process)));
  };
  const describe = (thread: Thread, window: FakeWindow): DesktopWindow => {
    const ok = isAllowed(thread, window);
    return {
      id: window.id, process: window.process, pid: window.pid, width: window.width, height: window.height, minimized: window.minimized,
      ...(ok ? { title: window.title } : {}), allowed: ok, ...(excluded(window) ? { excluded: true as const } : {})
    };
  };

  /** The one window a target names, as the core's resolver does. */
  const resolve = (thread: Thread, target: WindowTarget): FakeWindow => {
    const problem = windowTargetError(target);
    if (problem) throw refusal(problem, { target });
    const found = target.id !== undefined ? WINDOWS.filter(window => window.id === target.id)
      : target.process !== undefined ? WINDOWS.filter(window => bare(window.process) === bare(target.process!))
      : WINDOWS.filter(window => isAllowed(thread, window) && window.title.toLowerCase().includes(target.title!.toLowerCase()));
    if (found.length === 0) throw refusal(target.title !== undefined ? `no window of an allowed app has "${target.title.slice(0, 80)}" in its title` : 'no open window matches', { target });
    if (found.length > 1) throw refusal(`several windows match; name one by id: ${found.map(window => `${window.id} (${window.process})`).join(', ')}`, { target });
    const window = found[0]!;
    if (excluded(window)) throw refusal(`${window.process} is never captured: it is a password manager, a sign-in screen or listed in Settings`, { process: window.process });
    return window;
  };

  /** The assistant message parts go to: the running one, else a new one on the thread's last turn. */
  const host = (thread: Thread): Message => {
    const turn = thread.turns.at(-1);
    const last = thread.messages.at(-1);
    if (last && last.role === 'assistant' && (turn === undefined || last.turnId === turn.id)) return last;
    const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn?.id ?? `turn-${++ctx.seq}`, role: 'assistant', parts: [], state: 'complete', createdAt: ctx.now() };
    thread.messages.push(message);
    ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
    return message;
  };
  const post = (thread: Thread, part: MessagePart): { message: Message; partIndex: number } => {
    const message = host(thread);
    const partIndex = message.parts.length;
    message.parts.push(part);
    ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part: structuredClone(part) });
    return { message, partIndex };
  };
  const repost = (threadId: string, message: Message, partIndex: number) => {
    const part = message.parts[partIndex];
    if (part) ctx.emitToThread(threadId, 'message.part', { threadId, messageId: message.id, partIndex, part: structuredClone(part) });
  };

  const allow = (projectId: string, window: FakeWindow) => {
    const list = allowed.get(projectId) ?? [];
    if (!list.some(app => sameText(app.path, window.path))) allowed.set(projectId, [...list, { path: window.path, process: window.process, addedAt: Date.now() }]);
  };

  /** Posts a consent card and waits for its answer; `wait` false leaves it open, for the demo. */
  const ask = (thread: Thread, window: FakeWindow, kind: WindowConsentKind, timeoutMs = WINDOW_CONSENT_TIMEOUT_MS): Promise<WindowConsentAnswer | 'expired'> => {
    const requestId = `wcr-${++ctx.seq}`;
    const { message, partIndex } = post(thread, { type: 'window_consent', requestId, kind, process: window.process, path: window.path, expiresAt: Date.now() + timeoutMs, answer: null });
    return new Promise(resolve => {
      const consent: Consent = {
        threadId: thread.id, message, partIndex, timer: null,
        settle: answer => {
          if (!consents.delete(requestId)) return;
          if (consent.timer !== null) clearTimeout(consent.timer);
          const part = message.parts[partIndex];
          if (part?.type === 'window_consent') part.answer = answer;
          if (answer === 'always' && thread.projectId) allow(thread.projectId, window);
          repost(thread.id, message, partIndex);
          resolve(answer);
        }
      };
      consent.timer = setTimeout(() => consent.settle('expired'), timeoutMs);
      consents.set(requestId, consent);
    });
  };
  /** An allowed app goes ahead; another asks the owner first. */
  const consent = async (thread: Thread, window: FakeWindow, kind: WindowConsentKind) => {
    if (isAllowed(thread, window)) return;
    const answer = await ask(thread, window, kind);
    if (answer === 'refuse') throw refusal(`the owner refused to let this conversation capture ${window.process}`, { process: window.process });
    if (answer === 'expired') throw refusal(`nobody answered the request to capture ${window.process} within 10 minutes`, { process: window.process });
  };
  const capture = (thread: Thread, window: FakeWindow, kind: 'screenshot' | 'clip' | 'stream', extra: { path?: string; frames?: number }) => {
    const thumb = fit(window.width, window.height, WINDOW_THUMBNAIL_MAX);
    post(thread, {
      type: 'window_capture', kind, windowId: window.id, process: window.process, width: window.width, height: window.height, at: Date.now(),
      thumbnail: { data: fakeWindowPicture(thumb.width, thumb.height, Math.floor(Date.now() / 1000), window.hue), ...thumb }, ...extra
    });
  };
  const shotSize = (window: FakeWindow, max: number | undefined) => {
    if (max !== undefined && !(Number.isInteger(max) && max >= 0 && max <= 7680)) throw refusal('max must be 0 (full size) or a longest side in pixels up to 7680');
    if (window.minimized) throw refusal(`${window.process} is minimized; restore it to capture it`, { windowId: window.id });
    return fit(window.width, window.height, max ?? WINDOW_SHOT_MAX);
  };
  const output = (path: string | undefined, window: FakeWindow, suffix: string) => path ?? `${DATA_DIR}\\captures\\${bare(window.process)}-${Date.now()}${suffix}.png`;

  demos.set(ctx, () => {
    const thread = ctx.thread('t-trace');
    const [unity, blender, notepad] = [WINDOWS[0]!, WINDOWS[1]!, WINDOWS[2]!];
    capture(thread, unity, 'screenshot', { path: `${DATA_DIR}\\captures\\unity-garden.png` });
    capture(thread, unity, 'clip', { path: `${DATA_DIR}\\captures\\unity-garden-clip.png`, frames: 8 });
    post(thread, { type: 'window_consent', requestId: `wcr-${++ctx.seq}`, kind: 'screenshot', process: notepad.process, path: notepad.path, expiresAt: Date.now() - 60_000, answer: 'expired' });
    post(thread, { type: 'window_consent', requestId: `wcr-${++ctx.seq}`, kind: 'clip', process: unity.process, path: unity.path, expiresAt: Date.now() + 300_000, answer: 'always' });
    void ask(thread, blender, 'screenshot').catch(() => undefined);
    // The agent opens the watch once someone looks at the conversation, so the Window tab comes forward as it would.
    const opening = setInterval(() => {
      if (!ctx.bus.subscribed.has(thread.id)) return;
      clearInterval(opening);
      setTimeout(() => {
        watches.set(thread.id, { windowId: unity.id, process: unity.process, title: unity.title, openedAt: Date.now() });
        changed(thread.id);
      }, 800);
    }, 200);
  });

  const methods: ReturnType<typeof windowsMethods> = {
    'windows.list': async ({ threadId }) => {
      const thread = active(threadId);
      return { windows: WINDOWS.map(window => describe(thread, window)), support: { available: true }, watch: watches.get(threadId) ?? null };
    },
    'windows.screenshot': async ({ threadId, target, output: path, max, crop }) => {
      const thread = active(threadId);
      if (crop !== undefined) {
        const problem = windowCropError(crop);
        if (problem) throw refusal(problem, { crop });
      }
      const window = resolve(thread, target);
      let size = shotSize(window, max);
      await consent(thread, window, 'screenshot');
      if (crop !== undefined) {
        const scale = crop.unit === 'fraction' ? { x: window.width, y: window.height } : { x: 1, y: 1 };
        size = fit(Math.max(1, Math.round(crop.width * scale.x)), Math.max(1, Math.round(crop.height * scale.y)), max ?? WINDOW_SHOT_MAX);
      }
      const written = output(path, window, '');
      capture(thread, window, 'screenshot', { path: written });
      return { windowId: window.id, process: window.process, path: written, ...size, source: { width: window.width, height: window.height } };
    },
    'windows.clip': async ({ threadId, target, seconds, fps = 2, output: path, max }) => {
      const thread = active(threadId);
      if (!(typeof seconds === 'number' && seconds > 0 && seconds <= WINDOW_CLIP_LIMITS.seconds)) throw refusal(`seconds must be more than 0 and at most ${WINDOW_CLIP_LIMITS.seconds}`, { seconds });
      if (!(typeof fps === 'number' && fps > 0 && fps <= WINDOW_CLIP_LIMITS.fps)) throw refusal(`fps must be more than 0 and at most ${WINDOW_CLIP_LIMITS.fps}`, { fps });
      const window = resolve(thread, target);
      const size = shotSize(window, max);
      await consent(thread, window, 'clip');
      const frames = Math.max(1, Math.round(seconds * fps));
      const written = output(path, window, '-clip');
      capture(thread, window, 'clip', { path: written, frames });
      return { windowId: window.id, process: window.process, path: written, ...size, source: { width: window.width, height: window.height }, frames, seconds, fps };
    },
    'windows.watch': async ({ threadId, target }) => {
      const thread = active(threadId);
      const window = resolve(thread, target);
      await consent(thread, window, 'stream');
      const watch: WindowWatch = { windowId: window.id, process: window.process, ...(isAllowed(thread, window) ? { title: window.title } : {}), openedAt: Date.now() };
      watches.set(threadId, watch);
      streamed.delete(threadId);
      changed(threadId);
      return { watch };
    },
    'windows.frame': async ({ threadId, windowId, maxWidth, quality = 60, previous }) => {
      if (maxWidth !== undefined && !(Number.isInteger(maxWidth) && maxWidth >= 160 && maxWidth <= 3840)) throw refusal('window frame maxWidth must be an integer from 160 to 3840');
      if (!(Number.isInteger(quality) && quality >= 20 && quality <= 90)) throw refusal('window frame quality must be an integer from 20 to 90');
      if (previous !== undefined && !(typeof previous === 'string' && previous.length <= 100)) throw refusal('window frame previous must be the id of a frame this window sent');
      const problem = windowIdError(windowId);
      if (problem) throw refusal(problem, { windowId });
      const thread = active(threadId);
      const watch = watches.get(threadId);
      if (!watch || watch.windowId !== windowId) throw refusal(`window ${windowId} is not open in this conversation's Window panel`, { windowId });
      const window = WINDOWS.find(one => one.id === windowId);
      if (!window) throw refusal('the window closed', { windowId });
      if (window.minimized) throw refusal(`${window.process} is minimized; restore it to see it`, { windowId });
      // The core's default: 1280 on the longest side.
      const size = fit(window.width, window.height, maxWidth ?? 1280);
      const tick = Math.floor(Date.now() / 1000);
      const id = `wf-${windowId}-${tick}-${size.width}-${quality}`;
      if (!streamed.has(threadId)) {
        streamed.add(threadId);
        capture(thread, window, 'stream', {});
      }
      if (previous === id) return { id, windowId, ...size, unchanged: true, at: Date.now() };
      return { id, windowId, ...size, base64: fakeWindowPicture(size.width, size.height, tick, window.hue), at: Date.now() };
    },
    'windows.close': async ({ threadId }) => {
      active(threadId);
      const closed = watches.delete(threadId);
      streamed.delete(threadId);
      if (closed) changed(threadId);
      return { closed };
    },
    'windows.consent': async ({ threadId, requestId, answer }) => {
      active(threadId);
      if (!WINDOW_CONSENT_ANSWERS.includes(answer)) throw refusal(`answer must be one of ${WINDOW_CONSENT_ANSWERS.join(', ')}`, { answer });
      const pending = consents.get(requestId);
      if (!pending || pending.threadId !== threadId) throw refusal('this capture request is no longer waiting: it was answered, expired or the core restarted', { requestId });
      pending.settle(answer);
      return { ok: true };
    },
    'windows.read': async ({ threadId, target, filter, limit }) => {
      const thread = active(threadId);
      const max = limit ?? WINDOW_READ_LIMIT.default;
      if (!(Number.isInteger(max) && max >= 1 && max <= WINDOW_READ_LIMIT.max)) throw invalid(`limit must be a whole number from 1 to ${WINDOW_READ_LIMIT.max}`, 'limit');
      const window = resolve(thread, target);
      if (window.minimized) throw refusal('window minimized: restore it first', { windowId: window.id });
      await consent(thread, window, 'read');
      const controls = (CONTROLS[window.id] ?? []).map((control, index) => ({ id: index + 1, ...control }));
      reads.set(threadId, { window, controls });
      const wanted = filter?.trim().toLowerCase();
      const matching = wanted ? controls.filter(control => control.name.toLowerCase().includes(wanted)) : controls;
      return { windowId: window.id, process: window.process, controls: structuredClone(matching.slice(0, max)), total: matching.length };
    },
    'windows.point': async ({ threadId, control: id, target, name, at, label = '', seconds = WINDOW_POINT_SECONDS.default }) => {
      const thread = active(threadId);
      if ([id, name, at].filter(value => value !== undefined).length !== 1) throw invalid('point needs exactly one of control, name or at', 'control');
      if (label.length > WINDOW_POINT_LABEL_MAX) throw invalid(`label must be at most ${WINDOW_POINT_LABEL_MAX} characters with no control characters`, 'label');
      if (!(seconds >= 1 && seconds <= WINDOW_POINT_SECONDS.max)) throw invalid(`seconds must lie between 1 and ${WINDOW_POINT_SECONDS.max}`, 'seconds');
      let window: FakeWindow;
      let box: { x: number; y: number; width: number; height: number };
      let control: WindowControl | undefined;
      if (id !== undefined) {
        const read = reads.get(threadId);
        if (!read) throw refusal('nothing was read in this conversation yet: run `boite window read` first', { field: 'control' });
        control = read.controls.find(candidate => candidate.id === id);
        if (!control) throw refusal(`#${id} is not among the ${read.controls.length} controls of the last read: read the window again`, { field: 'control' });
        window = read.window;
        box = control;
      } else if (name !== undefined) {
        if (!target) throw refusal('point by name needs the window\'s target', { field: 'target' });
        window = resolve(thread, target);
        await consent(thread, window, 'read');
        const controls = (CONTROLS[window.id] ?? []).map((one, index) => ({ id: index + 1, ...one }));
        reads.set(threadId, { window, controls });
        const exact = controls.filter(one => one.name.toLowerCase() === name.trim().toLowerCase());
        const found = exact.length > 0 ? exact : controls.filter(one => one.name.toLowerCase().includes(name.trim().toLowerCase()));
        if (found.length !== 1) throw refusal(found.length === 0 ? `no control of ${window.process} is named "${name}"` : `${found.length} controls of ${window.process} match "${name}"; point at one by id`, { field: 'name' });
        control = found[0]!;
        box = control;
      } else {
        if (!target) throw refusal('point at a rectangle needs the window\'s target', { field: 'target' });
        const problem = windowCropError(at);
        if (problem) throw refusal(problem, { field: 'at' });
        window = resolve(thread, target);
        const scale = at!.unit === 'fraction' ? { x: window.width, y: window.height } : { x: 1, y: 1 };
        box = { x: Math.round(at!.x * scale.x), y: Math.round(at!.y * scale.y), width: Math.round(at!.width * scale.x), height: Math.round(at!.height * scale.y) };
      }
      if (window.minimized) throw refusal('window minimized: restore it first', { windowId: window.id });
      unpoint(threadId, 'cleared');
      const pointer: WindowPointer = {
        windowId: window.id, process: window.process, label: label === '' && control ? control.name : label,
        x: box.x, y: box.y, width: box.width, height: box.height, expiresAt: Date.now() + seconds * 1000,
        ...(control ? { control: { type: control.type, name: control.name } } : {})
      };
      pointers.set(threadId, { pointer, timer: setTimeout(() => unpoint(threadId, 'timeout'), seconds * 1000), end: new Set() });
      return { pointer: structuredClone(pointer) };
    },
    'windows.waitClick': async ({ threadId, timeoutSeconds = WINDOW_POINT_SECONDS.default }) => {
      active(threadId);
      const shown = pointers.get(threadId);
      if (!shown) throw refusal('nothing is pointed at in this conversation: run `boite window point` first', { threadId });
      const pointer = structuredClone(shown.pointer);
      const reason = await new Promise<'clicked' | 'timeout' | 'cleared'>(done => {
        const click = setTimeout(() => unpoint(threadId, 'clicked'), Math.min(1000, timeoutSeconds * 1000));
        shown.end.add(reason => { clearTimeout(click); done(reason); });
      });
      return reason === 'clicked' ? { clicked: true, pointer } : { clicked: false, reason };
    },
    'windows.unpoint': async ({ threadId }) => {
      active(threadId);
      return { cleared: unpoint(threadId, 'cleared') };
    },
    'windows.allowlist': async ({ projectId }) => {
      if (!ctx.projects.some(project => project.id === projectId)) throw ctx.notFound('project', projectId);
      return { apps: structuredClone(apps(projectId)) };
    },
    'windows.revoke': async ({ projectId, path }) => {
      if (!ctx.projects.some(project => project.id === projectId)) throw ctx.notFound('project', projectId);
      const list = apps(projectId);
      if (!list.some(app => sameText(app.path, path))) throw refusal(`${fileName(path)} is not on this project's list of allowed apps`, { path });
      allowed.set(projectId, list.filter(app => !sameText(app.path, path)));
      return { apps: structuredClone(apps(projectId)) };
    }
  };
  return methods;
}
