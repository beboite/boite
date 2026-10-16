import { expect, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from '../src/client.ts';
import { Cdp } from '../src/browser/cdp.ts';
import { waitForEndpoint } from '../src/browser/chromium.ts';
import { createBrowserFixture, jpegSize } from './browser/fixture.ts';

const browserFixture = createBrowserFixture();
const { real, url, evaluate, fakeHost } = browserFixture;

real('a viewer watching while the agent changes the page size never puts the old size back', async () => {
  const { owner, agent, threadId } = browserFixture;
  const { tabId } = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  await owner.call('threads.subscribe', { threadId });
  // The panel on the browser's own machine pulls shrunken frames the whole time.
  let watching = true, frames = 0;
  const watch = (async () => {
    while (watching) {
      await owner.call('browser.remoteFrame', { threadId, tabId, maxWidth: 300, quality: 40 }).then(() => { frames++; }, () => {});
      await Bun.sleep(125);
    }
  })();
  try {
    for (let round = 0; round < 6; round++) {
      await agent.call('browser.command', { threadId, tabId, action: { kind: 'preset', preset: 'iphone-15-pro' } });
      expect(await evaluate('[innerWidth, innerHeight]', tabId)).toEqual([393, 852]);
      await agent.call('browser.command', { threadId, tabId, action: { kind: 'preset', preset: 'iphone-15-pro', orientation: 'landscape' } });
      expect(await evaluate('[innerWidth, innerHeight]', tabId)).toEqual([852, 393]);
    }
  } finally { watching = false; await watch; }
  // The race needs frames actually taken while the sizes changed.
  expect(frames).toBeGreaterThan(5);
}, 150_000);

real('the desktop app on this machine hosts the agent tabs: the core drives them through it, and they close with it', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  // Only the owner's desktop app may host: not a script, not another client.
  await expect(owner.call('browser.hostAttach', {})).rejects.toThrow('only the desktop app on this machine');
  await expect(agent.call('browser.hostAttach', {})).rejects.toThrow();
  const host = await fakeHost();
  // A sign-in the core kept while the app was closed.
  const file = join(harness.core.dataDir, 'browser', 'default', 'boite-cookies.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([{ name: 'kept', value: 'by-core', domain: '127.0.0.1', path: '/' }]));
  try {
    await host.app.call('browser.hostAttach', {});
    expect((await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value).toMatchObject({ hosted: true });
    const open = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
    expect(open.title).toBe('Fixture');
    // The app's webviews get it, and a sign-in made in them is on the core's disk too.
    expect(await evaluate('document.cookie')).toContain('kept=by-core');
    await agent.call('browser.command', { threadId, action: { kind: 'evaluate', expression: "document.cookie = 'login=hosted; max-age=3600'" } });
    await agent.call('browser.command', { threadId, action: { kind: 'navigate', url: url() } });
    const names = () => { try { return (JSON.parse(readFileSync(file, 'utf8')) as { name: string; value: string }[]).map(cookie => `${cookie.name}=${cookie.value}`); } catch { return []; } };
    for (let i = 0; i < 100 && !names().includes('login=hosted'); i++) await Bun.sleep(50);
    expect(names()).toContain('login=hosted');
    expect(host.relayed.length).toBeGreaterThan(0);
    expect(new Set(host.relayed)).toEqual(new Set(['default']));
    // The tab names the host's view, so the app shows that page itself.
    await owner.call('threads.subscribe', { threadId });
    const [tab] = (await owner.call('browser.remoteStatus', { threadId })).tabs;
    expect(tab).toMatchObject({ tabId: open.tabId, view: expect.any(String) });
    await agent.call('browser.command', { threadId, action: { kind: 'click', selector: '#go' } });
    expect(await evaluate('document.title')).toBe('clicked');
    // A viewer elsewhere still gets frames, taken through the host.
    const frame = await owner.call('browser.remoteFrame', { threadId });
    expect(jpegSize(frame.base64)).toEqual({ width: frame.width, height: frame.height });
    // A reply from a connection that does not host is refused.
    await expect(owner.call('browser.hostReply', { profile: 'default', messages: ['{}'] })).rejects.toThrow('does not host');
  } finally {
    await Promise.all([host.close(), host.close()]);
  }
  // The app is gone: its tabs went with it, and the next one opens in the core's own browser.
  for (let i = 0; i < 50 && (await owner.call('browser.remoteStatus', { threadId })).tabs.length; i++) await Bun.sleep(50);
  expect((await owner.call('browser.remoteStatus', { threadId })).tabs).toEqual([]);
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  expect((await owner.call('browser.remoteStatus', { threadId })).tabs[0]!.view).toBeUndefined();
}, 150_000);

real('a desktop host that cannot connect to the core removes its browser and temporary profile', async () => {
  await browserFixture.harness.server.stop();
  let host: { process: Bun.Subprocess; dir: string } | undefined;
  const spawn = Bun.spawn;
  const capture = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
    const process = Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
    const command = args[0];
    if (Array.isArray(command)) {
      const profile = command.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('--user-data-dir=') && arg.includes('boite-host-')) as string | undefined;
      if (profile) host = { process, dir: profile.slice('--user-data-dir='.length) };
    }
    return process;
  }) as typeof Bun.spawn);
  try {
    await expect(fakeHost()).rejects.toThrow();
    expect(host).toBeDefined();
    expect(host!.process.exitCode).not.toBeNull();
    expect(existsSync(host!.dir)).toBe(false);
  } finally {
    capture.mockRestore();
    // The regression also cleans up the browser when run against the leaking fixture.
    if (host) {
      let socket: Cdp | undefined;
      const stuck = setTimeout(() => host!.process.kill(), 10_000);
      try {
        if (host.process.exitCode === null) {
          socket = await Cdp.connect(await waitForEndpoint(host.dir, host.process.exited));
          await socket.send('Browser.close').catch(() => {});
        }
      } catch { /* the captured process still has its kill fallback */ }
      finally { await host.process.exited; clearTimeout(stuck); socket?.close(); }
      rmSync(host.dir, { recursive: true, force: true });
    }
  }
}, 150_000);

real('a viewer on another device watches and drives the tab, and hears it come and go', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await expect(phone.call('browser.remoteStatus', { threadId })).rejects.toThrow('subscribe');
    await phone.call('threads.subscribe', { threadId });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: false, tabs: [], available: true });
    // A cold browser start can take longer than the default wait on a slow runner.
    const shown = phone.next('browser.remoteChanged', event => event.threadId === threadId && event.live, 30_000);
    const { tabId } = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
    expect((await shown).tabs[0]).toMatchObject({ tabId, profile: 'default', active: true });
    const frame = await phone.call('browser.remoteFrame', { threadId });
    expect(frame).toMatchObject({ tabId, title: 'Fixture', url: url() });
    expect(jpegSize(frame.base64)).toEqual({ width: frame.width, height: frame.height });
    await Bun.sleep(150);
    // A narrow viewer gets a frame no wider than it shows, of the same page.
    const small = await phone.call('browser.remoteFrame', { threadId, tabId, maxWidth: 400, quality: 40 });
    expect(jpegSize(small.base64).width).toBe(400);
    expect([small.width, small.height]).toEqual([frame.width, frame.height]);
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'unknown', input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('refresh');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'tap', x: .5, y: .5, width: small.width + 1, height: small.height } })).rejects.toThrow('viewport');
    // The button spans 100..300 × 100..180 CSS pixels.
    await phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'tap', x: 200 / small.width, y: 140 / small.height, width: small.width, height: small.height } });
    expect(await evaluate('document.title')).toBe('clicked');
    // A computer's keyboard, mouse and clipboard: keys as key events, a paste, a selection read back.
    await Bun.sleep(150);
    let live = await phone.call('browser.remoteFrame', { threadId, tabId });
    // A frame takes input for 5 s; a viewer shows a newer one long before that, so this one does too.
    const current = async () => {
      if (Date.now() - live.at > 1500) { await Bun.sleep(150); live = await phone.call('browser.remoteFrame', { threadId, tabId }); }
      return live.id;
    };
    const act = async (input: Parameters<typeof phone.call<'browser.remoteInput'>>[1]['input']) => phone.call('browser.remoteInput', { threadId, frameId: await current(), input });
    const selection = async () => phone.call('browser.remoteSelection', { threadId, frameId: await current() });
    const at = (x: number, y: number) => ({ x: x / live.width, y: y / live.height, width: live.width, height: live.height });
    await evaluate('window.keys = []; addEventListener("keydown", e => keys.push(e.key))');
    await act({ kind: 'tap', ...at(150, 230) });
    await act({ kind: 'press', keys: ['h', 'i', 'Space', 'A', 'x', 'Backspace'] });
    expect(await evaluate('document.querySelector("#name").value')).toBe('hi A');
    expect(await evaluate('keys.join(",")')).toBe('h,i, ,A,x,Backspace');
    await act({ kind: 'text', text: ' é\u{1F600} pasted' });
    expect(await evaluate('document.querySelector("#name").value')).toBe('hi A é\u{1F600} pasted');
    expect(await selection()).toEqual({ text: '', truncated: false });
    await act({ kind: 'select-all' });
    expect(await selection()).toEqual({ text: 'hi A é\u{1F600} pasted', truncated: false });
    // A double click selects the word under it, and a key replaces the selection.
    await act({ kind: 'tap', ...at(104, 230) });
    await act({ kind: 'tap', ...at(104, 230), count: 2 });
    expect((await selection()).text.trim()).toBe('hi');
    await act({ kind: 'press', keys: ['Delete'] });
    expect(String(await evaluate('document.querySelector("#name").value')).trim()).toBe('A é\u{1F600} pasted');
    // A drag selects page text; a password field's selection is never read.
    await act({ kind: 'drag', from: { x: 100 / live.width, y: 369 / live.height }, to: { x: 480 / live.width, y: 369 / live.height }, width: live.width, height: live.height });
    expect((await selection()).text).toBe('Select these words');
    await evaluate('document.querySelector("#name").type = "password"');
    await act({ kind: 'tap', ...at(150, 230) });
    await act({ kind: 'select-all' });
    expect(await evaluate('document.querySelector("#name").selectionEnd > 0')).toBe(true);
    expect(await selection()).toEqual({ text: '', truncated: false });
    await expect(act({ kind: 'press', keys: ['Hyper+a'] })).rejects.toThrow('remote press');
    await expect(phone.call('browser.remoteSelection', { threadId, frameId: 'unknown' })).rejects.toThrow('refresh');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'navigate', url: 'javascript:alert(1)' } })).rejects.toThrow('HTTP');
    // A viewer never gets the agent's own command, which can run scripts.
    await expect(phone.call('browser.command', { threadId, action: { kind: 'evaluate', expression: '1' } })).rejects.toThrow();
    const gone = phone.next('browser.remoteChanged', event => event.threadId === threadId && !event.live, 30_000);
    await owner.call('threads.archive', { threadId });
    expect((await gone).tabs).toEqual([]);
  } finally { phone.close(); }
}, 150_000);

real('a recording is an MP4 made in the browser itself, and one left running when the turn ends is thrown away', async () => {
  const { owner, agent, threadId } = browserFixture;
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/moving') } });
  await agent.call('browser.command', { threadId, action: { kind: 'recording-start' } });
  await expect(agent.call('browser.command', { threadId, action: { kind: 'recording-start' } })).rejects.toThrow('already running');
  // A slow encoder drops frames by design: an Intel macOS runner keeps 3 to 5 a second, so 4 s still clears 10.
  await Bun.sleep(4000);
  const { recording, tabId } = await agent.call('browser.command', { threadId, action: { kind: 'recording-stop' } });
  expect(recording).toMatchObject({ mime: 'video/mp4', codec: 'h264', reason: 'stopped', frameRate: 30 });
  expect(recording!.bytes).toBeGreaterThan(1000);
  expect(recording!.frames).toBeGreaterThan(10);
  const chunk = (await agent.call('browser.command', { threadId, tabId, action: { kind: 'recording-read', recordingId: recording!.id, offset: 0, maxBytes: 1024 } })).value as { base64: string; nextOffset: number; done: boolean };
  expect(Buffer.from(chunk.base64, 'base64').subarray(4, 8).toString()).toBe('ftyp');
  expect(chunk).toMatchObject({ nextOffset: 1024, done: false });
  await agent.call('browser.command', { threadId, tabId, action: { kind: 'recording-discard', recordingId: recording!.id } });
  await agent.call('browser.command', { threadId, action: { kind: 'recording-start' } });
  const finished = owner.next('turn.finished', row => row.threadId === threadId, 10_000);
  await owner.call('turns.start', { threadId, prompt: 'hello' });
  await finished; await Bun.sleep(300);
  await expect(agent.call('browser.command', { threadId, action: { kind: 'recording-stop' } })).rejects.toThrow('discarded');
}, 150_000);
