import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
beforeEach(async () => {
  harness = await startTestCore(); owner = await harness.connect();
  ({ threadId } = await echoThread(harness, owner));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  mkdirSync(join(harness.dataDir, 'preview'));
  writeFileSync(join(harness.dataDir, 'preview', 'index.html'), '<link rel="stylesheet" href="style.css"><button onclick="this.textContent=123">Try</button>');
  writeFileSync(join(harness.dataDir, 'preview', 'style.css'), 'button { color: green; }');
});
afterEach(async () => { agent?.close(); await harness?.stop(); });

test('the CLI opens HTML and relative assets on a separate origin, reuses it, reloads edits and closes after deletion', async () => {
  await owner.call('threads.subscribe', { threadId });
  const event = owner.next('panel.requested');
  let output = '', error = '';
  expect(await runCli(['browse', 'preview/index.html', '--json'], {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: text => output += text, err: text => error += text,
  })).toBe(0);
  expect(error).toBe('');
  const opened = JSON.parse(output);
  expect(opened.shown).toBe(true);
  const asked = await event;
  expect(asked.surface).toMatchObject({ kind: 'browser', url: opened.url, artifact: { path: 'preview/index.html' } });
  expect(new URL(opened.url).origin).not.toBe(new URL(harness.core.baseUrl()).origin);
  const page = await fetch(opened.url);
  expect(await page.text()).toContain('<button');
  expect(page.headers.get('content-security-policy')).toContain("frame-src 'none'");
  const css = await fetch(new URL('style.css', opened.url));
  expect(css.headers.get('content-type')).toContain('text/css');
  expect(await css.text()).toContain('green');
  const partial = await fetch(new URL('style.css', opened.url), { headers: { range: 'bytes=0-5' } });
  expect(partial.status).toBe(206); expect(await partial.text()).toBe('button');
  writeFileSync(join(harness.dataDir, 'preview', 'style.css'), 'button { color: blue; }');
  expect(await (await fetch(new URL('style.css', opened.url))).text()).toContain('blue');
  expect((await agent.call('artifacts.preview', { threadId, path: 'preview/index.html' })).url).toBe(opened.url);
  rmSync(join(harness.dataDir, 'preview', 'index.html'));
  await agent.call('artifacts.previewClose', { threadId, path: join(harness.dataDir, 'preview', 'index.html') });
  await expect(fetch(opened.url)).rejects.toThrow();
});

test('preview requests cannot reach other threads, dotfiles, adjacent directories, junctions or the core origin', async () => {
  const other = await echoThread(harness, owner, 'other');
  await expect(agent.call('artifacts.preview', { threadId: other.threadId, path: 'preview/index.html' })).rejects.toThrow('is for thread');
  await expect(agent.call('artifacts.preview', { threadId, path: '../outside.html' })).rejects.toThrow('leaves');
  await expect(agent.call('artifacts.preview', { threadId, path: 'preview/style.css' })).rejects.toThrow('HTML file');
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'phone', version: 'test' } });
  try { await expect(phone.call('artifacts.preview', { threadId, path: 'preview/index.html' })).rejects.toThrow('owner only'); }
  finally { phone.close(); }
  const { url } = await agent.call('artifacts.preview', { threadId, path: 'preview/index.html' });
  writeFileSync(join(harness.dataDir, 'preview', '.private.json'), '{"secret":"test-only"}');
  mkdirSync(join(harness.dataDir, 'outside'));
  writeFileSync(join(harness.dataDir, 'outside', 'private.js'), 'private contents');
  symlinkSync(join(harness.dataDir, 'outside'), join(harness.dataDir, 'preview', 'foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../outside/private.js', '.private.json', 'foreign/private.js', '%2e%2e%2foutside/private.js', '/rpc', '/core.json']) {
    expect((await fetch(new URL(path, url))).status).toBe(404);
  }
  // A page on this origin cannot use even a known owner token to open the core's WebSocket.
  const socket = new WebSocket(harness.url, { headers: { origin: new URL(url).origin } });
  const status = await new Promise<string>(resolve => {
    socket.onopen = () => { socket.close(); resolve('opened'); };
    socket.onerror = () => resolve('refused');
  });
  expect(status).toBe('refused');
  writeFileSync(join(harness.dataDir, 'preview', 'second.html'), '<h1>Second</h1>');
  const second = await agent.call('artifacts.preview', { threadId, path: 'preview/second.html' });
  expect(new URL(second.url).origin).not.toBe(new URL(url).origin);
  await owner.call('threads.archive', { threadId, archived: true });
  await expect(fetch(url)).rejects.toThrow();
  await expect(owner.call('artifacts.preview', { threadId, path: 'preview/index.html' })).rejects.toThrow('active thread');
});

test('previews work in a symlinked project folder and stop serving it when the link is replaced', async () => {
  const alias = join(harness.dataDir, 'linked-project');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(harness.dataDir, 'preview'), alias, linkType);
  const project = await owner.call('projects.add', { path: alias });
  const accountId = harness.core.threads.require(threadId).accountId;
  const linked = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId });
  const { url } = await owner.call('artifacts.preview', { threadId: linked.id, path: 'index.html' });
  expect(await (await fetch(url)).text()).toContain('<button');
  expect(await (await fetch(new URL('style.css', url))).text()).toContain('green');
  mkdirSync(join(harness.dataDir, 'replacement'));
  rmSync(alias);
  symlinkSync(join(harness.dataDir, 'replacement'), alias, linkType);
  expect((await fetch(url)).status).toBe(404);
});

test('a full preview pool evicts the least recently used origin and admits another thread', async () => {
  const opened: { url: string }[] = [];
  for (let index = 0; index < 16; index++) {
    writeFileSync(join(harness.dataDir, 'preview', `${index}.html`), `<h1>Preview ${index}</h1>`);
    opened.push(await agent.call('artifacts.preview', { threadId, path: `preview/${index}.html` }));
  }
  // Both an explicit reopen and a successful asset request count as activity.
  expect((await agent.call('artifacts.preview', { threadId, path: 'preview/0.html' })).url).toBe(opened[0]!.url);
  expect((await fetch(new URL('style.css', opened[1]!.url))).status).toBe(200);
  const other = await echoThread(harness, owner, 'other');
  const admitted = await owner.call('artifacts.preview', { threadId: other.threadId, path: 'preview/index.html' });
  expect(await (await fetch(admitted.url)).text()).toContain('<button');
  expect(await (await fetch(opened[0]!.url)).text()).toContain('Preview 0');
  expect(await (await fetch(opened[1]!.url)).text()).toContain('Preview 1');
  // A recycled port must not make an evicted URL valid on the replacement server.
  expect(await fetch(opened[2]!.url).then(response => response.ok, () => false)).toBe(false);
  const reopened = await agent.call('artifacts.preview', { threadId, path: 'preview/2.html' });
  expect(reopened.url).not.toBe(opened[2]!.url);
  expect(await (await fetch(reopened.url)).text()).toContain('Preview 2');
  expect(await fetch(opened[3]!.url).then(response => response.ok, () => false)).toBe(false);
});
