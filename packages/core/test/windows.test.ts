import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_ENV, parseWindowCrop, type MessagePart, type RpcEvents } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { pngSize } from '../src/devices/sdk.ts';
import type { NativeWindow, WindowCapture, WindowPixels } from '../src/platform/types.ts';
import { goneError, minimizedError } from '../src/platform/window-pixels.ts';
import { contactSheet, sheetColumns } from '../src/windows/image.ts';
import { DesktopWindows } from '../src/windows/service.ts';
import { echoThread, removeDir, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const UNITY = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0\\Editor\\Unity.exe';

function win(id: string, overrides: Partial<NativeWindow> = {}): NativeWindow {
  return { id, pid: Number(id), path: UNITY, process: 'Unity.exe', title: `Scene ${id} - secret.unity`, className: 'UnityContainerWndClass', width: 64, height: 40, minimized: false, ...overrides };
}

function solid(width: number, height: number, [b, g, r]: [number, number, number]): WindowPixels {
  const bgra = new Uint8Array(width * height * 4);
  for (let at = 0; at < bgra.length; at += 4) { bgra[at] = b; bgra[at + 1] = g; bgra[at + 2] = r; bgra[at + 3] = 255; }
  return { width, height, bgra, via: 'fake' };
}

/** A backend over a list the test edits; `pictures` overrides a window's picture or makes it fail. */
function fakeBackend(windows: NativeWindow[], pictures = new Map<string, () => WindowPixels>()) {
  const opened: string[] = [];
  let closed = 0;
  const take = async (id: string) => {
    const window = windows.find(candidate => candidate.id === id);
    if (!window) throw goneError(id);
    if (window.minimized) throw minimizedError();
    return pictures.get(id)?.() ?? solid(window.width, window.height, [40, 120, 200]);
  };
  const backend: WindowCapture = {
    list: async () => windows.map(window => ({ ...window })),
    capture: take,
    frames: id => { opened.push(id); return { next: () => take(id), close: () => { closed += 1; } }; },
  };
  return { backend, opened, closed: () => closed };
}

describe('window capture', () => {
  let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string, cwd: string, projectId: string;
  let windows: NativeWindow[], pictures: Map<string, () => WindowPixels>, fake: ReturnType<typeof fakeBackend>;

  const useService = (consentTimeoutMs = 60_000) => {
    fake = fakeBackend(windows, pictures);
    (harness.core as { windows: DesktopWindows }).windows.stop();
    (harness.core as { windows: DesktopWindows }).windows = new DesktopWindows(harness.core, { backend: async () => fake.backend, consentTimeoutMs, tempRoot: join(harness.dataDir, 'window-temp') });
  };

  beforeEach(async () => {
    harness = await startTestCore();
    owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    const thread = harness.core.threads.require(threadId);
    // The service answers with the file's real path: macOS's temporary folder sits behind /var -> /private/var.
    cwd = realpathSync(thread.cwd);
    projectId = thread.projectId!;
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
    windows = [win('101'), win('202', { path: 'C:\\Tools\\KeePass\\KeePass.exe', process: 'KeePass.exe', title: 'Database.kdbx' })];
    pictures = new Map();
    useService();
    // Cards and panel events reach clients subscribed to the conversation.
    await owner.call('threads.subscribe', { threadId });
    // A turn to draw cards under, as an agent's command always has.
    const finished = owner.next('turn.finished', turn => turn.threadId === threadId, 10_000);
    await owner.call('turns.start', { threadId, prompt: 'hello' });
    await finished;
  });

  afterEach(async () => {
    agent.close();
    owner.close();
    await harness.stop();
  });

  const parts = <T extends MessagePart['type']>(type: T) => harness.core.journal.listMessages(threadId)
    .flatMap(message => message.parts).filter((part): part is Extract<MessagePart, { type: T }> => part.type === type);

  /** The consent card the next capture draws, answered by the owner. */
  const answer = (choice: 'once' | 'always' | 'refuse') => {
    const drawn = owner.next('message.started', message => message.threadId === threadId && message.parts[0]?.type === 'window_consent', 5000);
    return drawn.then(message => {
      const part = message.parts[0] as Extract<MessagePart, { type: 'window_consent' }>;
      expect(part).toMatchObject({ process: 'Unity.exe', path: UNITY, kind: 'screenshot', answer: null });
      return owner.call('windows.consent', { threadId, requestId: part.requestId, answer: choice });
    });
  };

  test('list hides the titles of apps the project has not allowed and flags excluded ones', async () => {
    const list = await agent.call('windows.list', { threadId });
    expect(list.support).toEqual({ available: true });
    expect(list.windows).toEqual([
      { id: '101', process: 'Unity.exe', pid: 101, width: 64, height: 40, minimized: false, allowed: false },
      { id: '202', process: 'KeePass.exe', pid: 202, width: 64, height: 40, minimized: false, allowed: false, excluded: true },
    ]);
    // A title search reaches only allowed apps, so it cannot probe what another window's title says.
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { title: 'secret' } }))).toThrow('no an allowed app\'s window with that title');
  });

  test('once lets one capture through, writes the PNG and leaves a card; the next capture asks again', async () => {
    const answered = answer('once');
    const shot = await agent.call('windows.screenshot', { threadId, target: { process: 'unity' } });
    await answered;
    expect(shot).toMatchObject({ windowId: '101', process: 'Unity.exe', width: 64, height: 40, source: { width: 64, height: 40 } });
    expect(shot.path.startsWith(realpathSync(join(harness.dataDir, 'window-temp', threadId)))).toBe(true);
    expect(pngSize(readFileSync(shot.path))).toEqual({ width: 64, height: 40 });
    expect(parts('window_consent').map(part => part.answer)).toEqual(['once']);
    const [card] = parts('window_capture');
    expect(card).toMatchObject({ kind: 'screenshot', windowId: '101', process: 'Unity.exe', width: 64, height: 40, path: shot.path });
    expect(card!.thumbnail!.data.length).toBeGreaterThan(100);

    const again = answer('refuse');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' } }))).toThrow('the owner refused the capture of Unity.exe');
    await again;
    expect(parts('window_consent').map(part => part.answer)).toEqual(['once', 'refuse']);

    // The window closes while the card waits and its id goes to another program: Allow once lets nothing through.
    const reused = owner.next('message.started', message => message.threadId === threadId && message.parts[0]?.type === 'window_consent', 5000).then(message => {
      windows[0] = win('101', { pid: 303, path: 'C:\\Tools\\KeePass\\KeePass.exe', process: 'KeePass.exe' });
      return owner.call('windows.consent', { threadId, requestId: (message.parts[0] as { requestId: string }).requestId, answer: 'once' });
    });
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' } }))).toThrow('window 101 of Unity.exe is gone');
    await reused;
    expect(parts('window_capture')).toHaveLength(1);
  });

  test('always adds the app to the project, shows its titles, and revoking it asks again', async () => {
    const answered = answer('always');
    const output = join(cwd, 'unity.png');
    const shot = await agent.call('windows.screenshot', { threadId, target: { id: '101' }, output, max: 32, crop: { x: 0, y: 0, width: 0.5, height: 1, unit: 'fraction' } });
    await answered;
    // Half the width is 32x40, then 32 on the longest side.
    expect(shot).toMatchObject({ path: output, width: 26, height: 32, source: { width: 64, height: 40 } });
    expect(pngSize(readFileSync(output))).toEqual({ width: shot.width, height: shot.height });
    const { apps } = await owner.call('windows.allowlist', { projectId });
    expect(apps.map(app => [app.process, app.path])).toEqual([['Unity.exe', UNITY]]);
    const list = await agent.call('windows.list', { threadId });
    expect(list.windows[0]).toMatchObject({ allowed: true, title: 'Scene 101 - secret.unity' });
    // No card this time; a title search now finds it.
    const second = await agent.call('windows.screenshot', { threadId, target: { title: 'SCENE 101' } });
    expect(second.windowId).toBe('101');
    expect(parts('window_consent')).toHaveLength(1);
    // Executable paths fold case only where the file system does.
    if (process.platform !== 'win32') expect((await owner.call('windows.revoke', { projectId, path: UNITY.toUpperCase() })).apps).toHaveLength(1);
    expect((await owner.call('windows.revoke', { projectId, path: process.platform === 'win32' ? UNITY.toUpperCase() : UNITY })).apps).toEqual([]);
    expect((await agent.call('windows.list', { threadId })).windows[0]).toEqual({ id: '101', process: 'Unity.exe', pid: 101, width: 64, height: 40, minimized: false, allowed: false });
  });

  test('a card nobody answers expires and the capture is refused', async () => {
    useService(150);
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' } }))).toThrow('nobody answered the capture request for Unity.exe');
    expect(parts('window_consent').map(part => part.answer)).toEqual(['expired']);
    expect(await thrown(owner.call('windows.consent', { threadId, requestId: parts('window_consent')[0]!.requestId, answer: 'once' }))).toThrow('no longer waiting');
  });

  test('excluded, minimized, black and ambiguous windows are refused before any card', async () => {
    windows.push(win('303', { minimized: true }), win('404', { path: 'D:\\Mail\\mailer.exe', process: 'Mailer.exe' }), win('505', { path: 'C:\\Games\\Dark.exe', process: 'Dark.exe' }));
    pictures.set('505', () => solid(64, 40, [0, 0, 0]));
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '202' } }))).toThrow('KeePass.exe is never captured');
    await owner.call('settings.set', { windowCaptureExclusions: ['d:\\mail\\MAILER.exe'] } as never);
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { process: 'Mailer' } }))).toThrow('Mailer.exe is never captured');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '303' } }))).toThrow('window minimized: restore it first');
    const ambiguous = await thrown(agent.call('windows.screenshot', { threadId, target: { process: 'Unity.exe' } }));
    expect(ambiguous).toThrow('2 windows match; name one with --id');
    // The candidates name no title: Unity is not allowed yet.
    expect(String(ambiguous)).not.toContain('secret');
    expect(parts('window_consent')).toHaveLength(0);
    const answered = owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000)
      .then(message => owner.call('windows.consent', { threadId, requestId: (message.parts[0] as { requestId: string }).requestId, answer: 'once' }));
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '505' } }))).toThrow('came out black');
    await answered;
    expect(parts('window_capture')).toHaveLength(0);
  });

  test('a turn a contact wrote into, another thread and the owner-only methods are refused to the agent', async () => {
    harness.core.journal.db.query('INSERT INTO coordination_letters (id, thread_id, direction, status, created_at, request_id, fingerprint, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('letter_contact', threadId, 'in', 'delivered', Date.now() + 1, null, 'fp', JSON.stringify({ id: 'letter_contact', contact: { coreId: 'core_friend', name: 'Friend' } }));
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' } }))).toThrow('a contact\'s letter is part of this turn');
    const other = await echoThread(harness, owner, 'other');
    expect(await thrown(agent.call('windows.list', { threadId: other.threadId }))).toThrow(`windows.list is for thread ${threadId}`);
    // The gate's own words: an unknown request or a closed panel would refuse too.
    const notAgents = 'is not one of the agent\'s methods';
    expect(await thrown(agent.call('windows.consent', { threadId, requestId: 'req_x', answer: 'always' }))).toThrow(`windows.consent ${notAgents}`);
    expect(await thrown(agent.call('windows.allowlist', { projectId }))).toThrow(`windows.allowlist ${notAgents}`);
    expect(await thrown(agent.call('windows.revoke', { projectId, path: UNITY }))).toThrow(`windows.revoke ${notAgents}`);
    expect(await thrown(agent.call('windows.frame', { threadId, windowId: '101' }))).toThrow(`windows.frame ${notAgents}`);
  });

  test('output must be a new .png inside the conversation, its project or its temporary folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'boite-window-outside-'));
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' }, output: join(outside, 'x.png') }))).toThrow('output must be inside the conversation\'s folder');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' }, output: join(cwd, 'x.jpg') }))).toThrow('output must be an absolute path to a new .png file');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' }, output: 'x.png' }))).toThrow('absolute path');
    writeFileSync(join(cwd, 'taken.png'), 'x');
    const answered = answer('once');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' }, output: join(cwd, 'taken.png') }))).toThrow('already exists');
    await answered;
    expect(readFileSync(join(cwd, 'taken.png'), 'utf8')).toBe('x');
    // A file where the temporary folder goes is named, not an internal mkdir error.
    const temp = join(harness.dataDir, 'window-temp', threadId);
    mkdirSync(dirname(temp), { recursive: true });
    writeFileSync(temp, 'x');
    expect(await thrown(agent.call('windows.screenshot', { threadId, target: { id: '101' } }))).toThrow(`${temp} is not a folder of this user's: remove it and capture again`);
  });

  test('boite window lists, captures, clips a contact sheet and opens the Window panel', async () => {
    // Allowed for the project, as an earlier "Always" leaves it.
    const always = answer('always');
    await agent.call('windows.screenshot', { threadId, target: { id: '101' } });
    await always;
    const run = async (...args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['window', ...args], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => { out += text; }, err: text => { error += text; } });
      return { code, out, error };
    };
    const listed = await run('list');
    expect(listed.out).toContain('101  Unity.exe  pid 101  64x40  "Scene 101 - secret.unity"');
    expect(listed.out).toContain('202  KeePass.exe  pid 202  64x40  excluded');
    const shot = await run('screenshot', '--title', 'scene 101', '--output', 'shot.png', '--crop', '8,8,16,16');
    expect(shot.error).toBe('');
    expect(shot.out).toContain(`path: ${join(cwd, 'shot.png')}`);
    expect(shot.out).toContain('size: 16x16 pixels (window 64x40), about 1 tokens to read');
    const clip = await run('clip', '--id', '101', '--seconds', '1', '--fps', '4', '--json');
    const sheet = JSON.parse(clip.out);
    expect(sheet).toMatchObject({ frames: 4, fps: 4, seconds: 1, windowId: '101' });
    expect(pngSize(readFileSync(sheet.path))).toEqual({ width: sheet.width, height: sheet.height });
    expect(parts('window_capture').map(part => part.kind)).toEqual(['screenshot', 'screenshot', 'clip']);
    // A card gives the size of the file the agent got, not of the window.
    expect(parts('window_capture').slice(1).map(part => [part.width, part.height])).toEqual([[16, 16], [sheet.width, sheet.height]]);
    expect((await run('clip', '--id', '101', '--seconds', '11')).error).toContain('seconds must lie between 0.5 and 10');
    expect((await run('screenshot', '--id', '101', '--process', 'Unity')).code).toBe(2);

    const changed = owner.next('windows.changed', event => event.threadId === threadId, 5000);
    const watched = await run('watch', '--id', '101');
    expect(watched.out).toContain('nothing is captured until the user presses Show');
    expect((await changed).watch).toMatchObject({ windowId: '101', process: 'Unity.exe', title: 'Scene 101 - secret.unity' });
    expect(fake.opened).toEqual(['101']);
    const frame = await owner.call('windows.frame', { threadId, windowId: '101', maxWidth: 200 });
    expect(frame).toMatchObject({ windowId: '101', width: 64, height: 40 });
    await Bun.sleep(250);
    expect(await owner.call('windows.frame', { threadId, windowId: '101', maxWidth: 200, previous: frame.id })).toMatchObject({ unchanged: true, id: frame.id });
    const closed = owner.next('windows.changed', event => event.threadId === threadId && event.watch === null, 5000);
    expect((await run('close')).out).toContain('Window panel closed');
    await closed;
    expect(fake.closed()).toBeGreaterThan(0);
    expect(await thrown(owner.call('windows.frame', { threadId, windowId: '101' }))).toThrow('not open in this conversation');
  });

  test('a watched window that closes empties the panel', async () => {
    const answered = owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000)
      .then(message => owner.call('windows.consent', { threadId, requestId: (message.parts[0] as { requestId: string }).requestId, answer: 'once' }));
    await agent.call('windows.watch', { threadId, target: { id: '101' } });
    await answered;
    await owner.call('windows.frame', { threadId, windowId: '101' });
    windows.splice(0, 1);
    const emptied: Promise<RpcEvents['windows.changed']> = owner.next('windows.changed', event => event.watch === null, 5000);
    await Bun.sleep(2100);
    expect(await thrown(owner.call('windows.frame', { threadId, windowId: '101' }))).toThrow('is gone');
    expect((await emptied).watch).toBeNull();
  });

  test('a clip asked while a screenshot card waits gets a card of its own', async () => {
    type Consent = Extract<MessagePart, { type: 'window_consent' }>;
    const card = () => owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000).then(message => message.parts[0] as Consent);
    const first = card();
    const shot = agent.call('windows.screenshot', { threadId, target: { id: '101' } });
    const screenshotCard = await first;
    const second = card();
    const clip = thrown(agent.call('windows.clip', { threadId, target: { id: '101' }, seconds: 0.5, fps: 2 }));
    const clipCard = await second;
    expect([screenshotCard.kind, clipCard.kind]).toEqual(['screenshot', 'clip']);
    await owner.call('windows.consent', { threadId, requestId: screenshotCard.requestId, answer: 'once' });
    await shot;
    // Allowing the screenshot let nothing else through.
    await owner.call('windows.consent', { threadId, requestId: clipCard.requestId, answer: 'refuse' });
    expect(await clip).toThrow('the owner refused the capture of Unity.exe');
  });

  test('two first frames open one capture session, and the panel stops once its app joins Never capture', async () => {
    const answered = owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000)
      .then(message => owner.call('windows.consent', { threadId, requestId: (message.parts[0] as { requestId: string }).requestId, answer: 'once' }));
    await agent.call('windows.watch', { threadId, target: { id: '101' } });
    await answered;
    // A phone and a desktop asking at once.
    await Promise.all([owner.call('windows.frame', { threadId, windowId: '101' }), owner.call('windows.frame', { threadId, windowId: '101' })]);
    expect(fake.opened).toEqual(['101']);
    await owner.call('settings.set', { windowCaptureExclusions: ['unity'] } as never);
    expect(await thrown(owner.call('windows.frame', { threadId, windowId: '101' }))).toThrow('Unity.exe is excluded from capture');
    expect(fake.closed()).toBe(1);
    expect((await owner.call('windows.list', { threadId })).watch).toBeNull();
  });
});

describe('pictures', () => {
  test('a crop reads pixels or fractions', () => {
    expect(parseWindowCrop('10,20,300,200')).toEqual({ x: 10, y: 20, width: 300, height: 200, unit: 'px' });
    expect(parseWindowCrop('0.5,0,0.5,.5')).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5, unit: 'fraction' });
    expect(parseWindowCrop('1,2,3')).toBeNull();
    expect(parseWindowCrop('-1,0,2,2')).toBeNull();
  });

  test('a contact sheet lays frames out close to square with a label band under each', () => {
    expect([1, 2, 4, 5, 9, 10, 40].map(sheetColumns)).toEqual([1, 2, 2, 3, 3, 4, 7]);
    const frames = [0, 0.25, 0.5].map(at => ({ pixels: solid(100, 50, [0, 200, 0]), at }));
    const sheet = contactSheet(frames, { width: 100, height: 50 }, 0);
    // Two columns, two rows: 2 * 100 + 3 gaps of 8; 2 * (50 + 22) + 3 gaps.
    expect([sheet.width, sheet.height]).toEqual([224, 168]);
    const green = (x: number, y: number) => sheet.bgra[(y * sheet.width + x) * 4 + 1];
    expect(green(8 + 50, 8 + 25)).toBe(200);
    expect(green(2, 2)).toBe(32);
  });
});

test('nothing of a window reaches the logs but its id, app and size', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
  const harness = await startTestCore({ dataDir });
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    await owner.call('threads.subscribe', { threadId });
    const fake = fakeBackend([win('101')]);
    (harness.core as { windows: DesktopWindows }).windows = new DesktopWindows(harness.core, { backend: async () => fake.backend, tempRoot: join(dataDir, 'window-temp') });
    const finished = owner.next('turn.finished', turn => turn.threadId === threadId, 10_000);
    await owner.call('turns.start', { threadId, prompt: 'hello' });
    await finished;
    const card = owner.next('message.started', message => message.parts[0]?.type === 'window_consent', 5000)
      .then(message => owner.call('windows.consent', { threadId, requestId: (message.parts[0] as { requestId: string }).requestId, answer: 'always' }));
    const shot = await owner.call('windows.screenshot', { threadId, target: { id: '101' } });
    await card;
    expect(existsSync(shot.path)).toBe(true);
    const thumbnail = parts(harness, threadId)[0]!.thumbnail!.data;
    await harness.stop();
    const logs = readdirSync(join(dataDir, 'logs')).map(name => readFileSync(join(dataDir, 'logs', name), 'utf8')).join('\n');
    expect(logs).toContain('window.screenshot');
    expect(logs).not.toContain('secret.unity');
    expect(logs).not.toContain(thumbnail.slice(0, 40));
  } finally {
    await harness.stop();
    await removeDir(dataDir);
  }
});

function parts(harness: TestCore, threadId: string) {
  return harness.core.journal.listMessages(threadId).flatMap(message => message.parts)
    .filter((part): part is Extract<MessagePart, { type: 'window_capture' }> => part.type === 'window_capture');
}