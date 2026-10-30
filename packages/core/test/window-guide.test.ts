import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AGENT_ENV, type MessagePart } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import type { NativeControl, NativeWindow, ScreenRect, WindowCapture, WindowGuide } from '../src/platform/types.ts';
import { goneError } from '../src/platform/window-pixels.ts';
import { DesktopWindows } from '../src/windows/service.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const UNITY = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0\\Editor\\Unity.exe';
const FOLLOW_MS = 10;

function win(id: string, overrides: Partial<NativeWindow> = {}): NativeWindow {
  return { id, pid: Number(id), path: UNITY, process: 'Unity.exe', title: `Scene ${id}`, className: 'UnityContainerWndClass', width: 400, height: 300, minimized: false, ...overrides };
}

const control = (type: string, name: string, left: number, top: number, automationId = ''): NativeControl =>
  ({ type, name, automationId, rect: { left, top, width: 40, height: 20 } });

/**
 * A desktop the test edits: windows, where each lies on the screen, their
 * controls in screen pixels, the boxes drawn and the mouse.
 */
function fakeDesktop() {
  const windows = [win('101'), win('202', { path: 'C:\\Tools\\KeePass\\KeePass.exe', process: 'KeePass.exe' })];
  const frames = new Map<string, { rect: ScreenRect; minimized: boolean; above: boolean }>([
    ['101', { rect: { left: 1000, top: 500, width: 400, height: 300 }, minimized: false, above: false }],
    ['202', { rect: { left: 0, top: 0, width: 400, height: 300 }, minimized: false, above: false }],
  ]);
  const controls: NativeControl[] = [
    control('MenuItem', 'File', 1004, 504),
    control('MenuItem', 'Edit', 1048, 504),
    control('Button', 'Play', 1200, 530, 'PlayButton'),
    control('Button', 'Play Mode Options', 1244, 530),
    // Scrolled out of the window, though its provider says it is on screen.
    control('ListItem', 'Hidden asset', 1000, 900),
  ];
  const boxes: { rect: ScreenRect | null; label: string; closed: boolean }[] = [];
  const mouse = { pressed: false, x: 0, y: 0 };
  const capture: WindowCapture = {
    list: async () => windows.map(window => ({ ...window, minimized: frames.get(window.id)?.minimized ?? window.minimized })),
    capture: async id => { throw goneError(id); },
    frames: id => ({ next: async () => { throw goneError(id); }, close: () => {} }),
  };
  const guide: WindowGuide = {
    controls: async (id, limit) => {
      if (!frames.has(id)) throw new Error('the window closed during the read');
      return { controls: id === '101' ? controls.slice(0, limit) : [], total: id === '101' ? controls.length : 0 };
    },
    frame: id => {
      const frame = frames.get(id);
      return frame ? { rect: { ...frame.rect }, minimized: frame.minimized, above: frame.above } : null;
    },
    point: (rect, label) => {
      const box: (typeof boxes)[number] = { rect, label, closed: false };
      boxes.push(box);
      return { move: next => { box.rect = next; }, close: () => { box.closed = true; } };
    },
    mouse: () => ({ ...mouse }),
  };
  return { windows, frames, boxes, mouse, capture, guide };
}

describe('window guide', () => {
  let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string, desk: ReturnType<typeof fakeDesktop>;

  beforeEach(async () => {
    harness = await startTestCore();
    owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
    desk = fakeDesktop();
    const core = harness.core as { windows: DesktopWindows };
    core.windows.stop();
    core.windows = new DesktopWindows(harness.core, {
      backend: async () => desk.capture, guide: async () => desk.guide, consentTimeoutMs: 60_000,
      tempRoot: join(harness.dataDir, 'window-temp'), guideTiming: { followMs: FOLLOW_MS, mouseMs: 5 },
    });
    await owner.call('threads.subscribe', { threadId });
    const finished = owner.next('turn.finished', turn => turn.threadId === threadId, 10_000);
    await owner.call('turns.start', { threadId, prompt: 'hello' });
    await finished;
  });

  afterEach(async () => {
    agent.close();
    owner.close();
    await harness.stop();
  });

  /** Answers the next consent card, which must ask to read Unity. */
  const answer = (choice: 'once' | 'always' | 'refuse') => owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000).then(message => {
    const part = message.parts[0] as Extract<MessagePart, { type: 'window_consent' }>;
    expect(part).toMatchObject({ kind: 'read', process: 'Unity.exe', path: UNITY, answer: null });
    return owner.call('windows.consent', { threadId, requestId: part.requestId, answer: choice });
  });

  test('read asks to read the app, numbers its controls in window pixels and keeps those inside the window', async () => {
    const answered = answer('always');
    const read = await agent.call('windows.read', { threadId, target: { process: 'unity' } });
    await answered;
    expect(read).toEqual({
      windowId: '101', process: 'Unity.exe', total: 4,
      controls: [
        { id: 1, type: 'MenuItem', name: 'File', x: 4, y: 4, width: 40, height: 20 },
        { id: 2, type: 'MenuItem', name: 'Edit', x: 48, y: 4, width: 40, height: 20 },
        { id: 3, type: 'Button', name: 'Play', automationId: 'PlayButton', x: 200, y: 30, width: 40, height: 20 },
        { id: 4, type: 'Button', name: 'Play Mode Options', x: 244, y: 30, width: 40, height: 20 },
      ],
    });
    // The app is allowed now: a filtered, limited read asks nothing more.
    expect(await agent.call('windows.read', { threadId, target: { id: '101' }, filter: 'PLAY', limit: 1 }))
      .toMatchObject({ total: 2, controls: [{ id: 3, name: 'Play' }] });
    expect(await thrown(agent.call('windows.read', { threadId, target: { id: '101' }, limit: 0 }))).toThrow('limit must be a whole number from 1 to 400');
    expect(await thrown(agent.call('windows.read', { threadId, target: { id: '202' } }))).toThrow('KeePass.exe is never captured');
  });

  test('point draws over a control of the last read, by id or by name, and replaces the previous box', async () => {
    expect(await thrown(agent.call('windows.point', { threadId, control: 1 }))).toThrow('nothing was read in this conversation yet');
    const answered = answer('once');
    await agent.call('windows.read', { threadId, target: { id: '101' } });
    await answered;
    const { pointer } = await agent.call('windows.point', { threadId, control: 3 });
    expect(pointer).toMatchObject({ windowId: '101', label: 'Play', x: 200, y: 30, width: 40, height: 20, control: { type: 'Button', name: 'Play' } });
    expect(desk.boxes[0]).toMatchObject({ rect: { left: 1200, top: 530, width: 40, height: 20 }, label: 'Play', closed: false });
    expect(await thrown(agent.call('windows.point', { threadId, control: 9 }))).toThrow('#9 is not among the 4 controls of the last read');

    // "Play" is exact and wins over "Play Mode Options"; "pla" matches both and is refused with their ids.
    const again = answer('once');
    const named = await agent.call('windows.point', { threadId, target: { id: '101' }, name: 'play', label: 'Press Play' });
    await again;
    expect(named.pointer).toMatchObject({ label: 'Press Play', control: { name: 'Play' } });
    expect(desk.boxes.map(box => box.closed)).toEqual([true, false]);
    const ambiguous = answer('once');
    expect(await thrown(agent.call('windows.point', { threadId, target: { id: '101' }, name: 'pla' }))).toThrow('2 controls of Unity.exe match "pla"; point at one by id:\n  #3 Button "Play"\n  #4 Button "Play Mode Options"');
    await ambiguous;
    expect(await thrown(agent.call('windows.point', { threadId, control: 3, name: 'Play' }))).toThrow('exactly one of control, name or at');

    expect(await agent.call('windows.unpoint', { threadId })).toEqual({ cleared: true });
    expect(desk.boxes.every(box => box.closed)).toBe(true);
    expect(await agent.call('windows.unpoint', { threadId })).toEqual({ cleared: false });
  });

  test('a rectangle reads nothing, so it asks nothing; the box follows its window and goes with it', async () => {
    const cards = () => harness.core.journal.listMessages(threadId).flatMap(message => message.parts).filter(part => part.type === 'window_consent');
    const { pointer } = await agent.call('windows.point', { threadId, target: { id: '101' }, at: { x: 0.5, y: 0, width: 0.25, height: 0.1, unit: 'fraction' }, label: 'Scene view' });
    expect(cards()).toEqual([]);
    expect(pointer).toMatchObject({ x: 200, y: 0, width: 100, height: 30, label: 'Scene view' });
    expect(pointer.control).toBeUndefined();
    expect(desk.boxes[0]!.rect).toEqual({ left: 1200, top: 500, width: 100, height: 30 });
    expect(await thrown(agent.call('windows.point', { threadId, target: { id: '202' }, at: { x: 0, y: 0, width: 10, height: 10, unit: 'px' } }))).toThrow('KeePass.exe is never captured');

    desk.frames.get('101')!.rect = { left: 10, top: 20, width: 400, height: 300 };
    await Bun.sleep(FOLLOW_MS * 6);
    expect(desk.boxes[0]!.rect).toEqual({ left: 210, top: 20, width: 100, height: 30 });
    desk.frames.get('101')!.minimized = true;
    await Bun.sleep(FOLLOW_MS * 6);
    expect(desk.boxes[0]!.rect).toBeNull();
    desk.frames.get('101')!.minimized = false;
    await Bun.sleep(FOLLOW_MS * 6);
    expect(desk.boxes[0]!.rect).toEqual({ left: 210, top: 20, width: 100, height: 30 });

    const waiting = agent.call('windows.waitClick', { threadId, timeoutSeconds: 5 });
    await Bun.sleep(20);
    desk.frames.delete('101');
    expect(await waiting).toEqual({ clicked: false, reason: 'gone' });
    expect(desk.boxes[0]!.closed).toBe(true);
  });

  test('wait-click ends on a press inside the box, not on one outside or a button already held', async () => {
    await agent.call('windows.point', { threadId, target: { id: '101' }, at: { x: 100, y: 100, width: 50, height: 50, unit: 'px' } });
    // Held since before the wait: a drag that started elsewhere, not this click.
    Object.assign(desk.mouse, { pressed: true, x: 1120, y: 620 });
    const waiting = agent.call('windows.waitClick', { threadId, timeoutSeconds: 5 });
    await Bun.sleep(80);
    expect(desk.boxes[0]!.closed).toBe(false);
    Object.assign(desk.mouse, { pressed: false });
    await Bun.sleep(80);
    Object.assign(desk.mouse, { pressed: true, x: 900, y: 620 });
    await Bun.sleep(80);
    Object.assign(desk.mouse, { pressed: false });
    await Bun.sleep(80);
    expect(desk.boxes[0]!.closed).toBe(false);
    Object.assign(desk.mouse, { pressed: true, x: 1149, y: 649 });
    expect(await waiting).toMatchObject({ clicked: true, pointer: { windowId: '101', x: 100, y: 100 } });
    expect(desk.boxes[0]!.closed).toBe(true);
    expect(await thrown(agent.call('windows.waitClick', { threadId }))).toThrow('nothing is pointed at in this conversation');

    // No click in time leaves the box up for the next try, even past the time it was drawn for; unpoint ends a wait.
    Object.assign(desk.mouse, { pressed: false });
    await agent.call('windows.point', { threadId, target: { id: '101' }, at: { x: 0, y: 0, width: 10, height: 10, unit: 'px' }, seconds: 1 });
    expect(await agent.call('windows.waitClick', { threadId, timeoutSeconds: 1 })).toEqual({ clicked: false, reason: 'timeout' });
    expect(desk.boxes[1]!.closed).toBe(false);
    const cleared = agent.call('windows.waitClick', { threadId, timeoutSeconds: 5 });
    await Bun.sleep(20);
    await agent.call('windows.unpoint', { threadId });
    expect(await cleared).toEqual({ clicked: false, reason: 'cleared' });
  });

  test('an archived conversation takes its box away', async () => {
    await agent.call('windows.point', { threadId, target: { id: '101' }, at: { x: 0, y: 0, width: 10, height: 10, unit: 'px' } });
    await owner.call('threads.archive', { threadId });
    expect(desk.boxes[0]!.closed).toBe(true);
  });

  test('boite window read, point, wait-click and unpoint', async () => {
    const run = async (...args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['window', ...args], { cwd: harness.core.threads.require(threadId).cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => { out += text; }, err: text => { error += text; } });
      return { code, out, error };
    };
    const answered = answer('always');
    const read = await run('read', '--id', '101', '--limit', '2');
    await answered;
    expect(read.out).toBe('window: 101 (Unity.exe)\n#1 MenuItem "File" 4,4 40x20\n#2 MenuItem "Edit" 48,4 40x20\n2 more: narrow with --filter or raise --limit\n');
    expect((await run('point', '2', '--label', 'Open Edit')).out).toMatch(/^pointing at MenuItem "Edit" of window 101 \(Unity.exe\) with "Open Edit" for 120 s\n$/);
    expect((await run('point', '--id', '101', '--at', '0,0,0.5,0.5', '--seconds', '30')).out).toMatch(/^pointing at 0,0 200x150 of window 101 \(Unity.exe\) for 30 s\n$/);
    expect((await run('point', '--id', '101')).error).toContain('needs an id from window read (3 for #3), or a target with exactly one of --name or --at');
    Object.assign(desk.mouse, { pressed: false });
    setTimeout(() => Object.assign(desk.mouse, { pressed: true, x: 1010, y: 510 }), 50);
    expect((await run('wait-click', '--timeout', '5')).out).toBe('clicked: the user pressed inside the box, which is gone now\n');
    expect((await run('unpoint')).out).toBe('no box was shown\n');
  });
});
