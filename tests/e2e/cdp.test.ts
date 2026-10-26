import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';

test('CDP attachment skips startup blank pages unless the caller explicitly asks for one', async () => {
  const app = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>CDP fixture</title><p>Ready</p>', { headers: { 'content-type': 'text/html' } }) });
  const port = await freePort();
  let owner: BrowserPage | undefined;
  let attached: BrowserPage | undefined;
  let blank: BrowserPage | undefined;
  const discovery = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string }[];
    // Discovery order is unspecified. Reproduce a startup target preceding the app.
    targets.sort((a, b) => Number(b.url === 'about:blank') - Number(a.url === 'about:blank'));
    return Response.json(targets);
  } });
  try {
    owner = await BrowserPage.launch({ url: app.url.href, debugPort: port });
    await owner.send('Target.createTarget', { url: 'about:blank' });
    attached = await BrowserPage.attach(discovery.port!);
    expect(await attached.evaluate('location.href')).toBe(app.url.href);
    blank = await BrowserPage.attach(discovery.port!, 'about:blank');
    expect(await blank.evaluate('location.href')).toBe('about:blank');
    expect(owner.errors()).toEqual([]);
    expect(existsSync(join(import.meta.dir, '.artifacts', `browser-${owner.pid}-attempt-1.json`))).toBe(false);
  } finally {
    await blank?.close();
    await attached?.close();
    const profile = owner?.profileDir;
    await owner?.close();
    if (profile) expect(existsSync(profile)).toBe(false);
    discovery.stop(true);
    app.stop(true);
  }
}, 60_000);

// A real captured subprocess, without Chromium or a platform-specific launcher.
// Bun accepts the Chromium switches before --eval; the fixture exits before CDP.
test.each(['captured', 'collection-failure', 'write-failure', 'caller-profile'] as const)('launch preserves a pre-cleanup startup failure (%s)', async mode => {
  const fixture = mkdtempSync(join(tmpdir(), 'boite-cdp-start-test-'));
  const identity = join(fixture, 'identity.json');
  const artifacts = join(import.meta.dir, '.artifacts');
  const port = await freePort();
  const sentinel = 'captured-startup-stderr';
  const endpoint = `ws://127.0.0.1:${port}/devtools/browser/private-cdp-token`;
  const suppliedProfile = mode === 'caller-profile' ? join(fixture, 'caller-profile') : undefined;
  if (suppliedProfile) mkdirSync(suppliedProfile);
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const profile = process.execArgv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    fs.writeFileSync(${JSON.stringify(identity)}, JSON.stringify({ pid: process.pid, profile }));
    fs.writeFileSync(path.join(profile, 'First Run'), 'fixture');
    ${mode === 'collection-failure' ? "fs.mkdirSync(path.join(profile, 'DevToolsActivePort'));" : "fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\\n/secret-websocket');"}
    ${mode === 'write-failure' ? `fs.mkdirSync(${JSON.stringify(artifacts)}, { recursive: true }); fs.mkdirSync(path.join(${JSON.stringify(artifacts)}, 'browser-' + process.pid + '-attempt-1.json'));` : ''}
    fs.writeSync(2, ${JSON.stringify(sentinel + '\nDevTools listening on ' + endpoint + '\nDevTools listening on ' + endpoint.replace('ws:', 'wss:') + '\n')});
    process.exit(23);
  `;
  let captured: { pid: number; profile: string } | undefined;
  try {
    const error = await BrowserPage.launch({
      executable: process.execPath, debugPort: port, userDataDir: suppliedProfile,
      url: 'http://127.0.0.1/?private-query=never-serialize',
      args: ['--eval', script, '--private-argument=never-serialize'],
    }).then(() => { throw new Error('expected startup failure'); }, (error: unknown) => error as Error);
    captured = JSON.parse(readFileSync(identity, 'utf8'));
    expect(error.message).toStartWith('the browser exited before opening CDP with code 23');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('the browser exited before opening CDP with code 23');
    expect(error.message).toContain(sentinel);
    expect(error.message).toContain(endpoint);
    expect(readFileSync(join(artifacts, `browser-${captured!.pid}.log`), 'utf8')).toContain(endpoint);
    expect(existsSync(captured!.profile)).toBe(mode === 'caller-profile');
    expect(() => process.kill(captured!.pid, 0)).toThrow();
    const artifact = join(artifacts, `browser-${captured!.pid}-attempt-1.json`);
    if (mode === 'write-failure') {
      expect(error.message).toMatch(/Startup diagnostic unavailable: (EISDIR|EPERM|EACCES)/);
    } else {
      const raw = readFileSync(artifact, 'utf8');
      const report = JSON.parse(raw);
      expect(report.attempt).toBe(1);
      expect(report.pid).toBe(captured!.pid);
      expect(report.port).toBe(port);
      expect(report.profile).toMatchObject({ path: captured!.profile, owned: mode !== 'caller-profile' });
      expect(report.executable.selected).toBe(process.execPath);
      expect(report.executable.resolved).toBeString();
      expect(report.wrapper.exitCode).toBe(23);
      expect(report.stderr).toContain(sentinel);
      expect(report.stderr).toContain('DevTools listening on [redacted]');
      expect(raw).not.toContain('private-cdp-token');
      expect(report.failedAt).toBeGreaterThanOrEqual(report.startedAt);
      if (mode === 'caller-profile') expect(report.profile.markers).toBeUndefined();
      else expect(report.profile.markers['First Run'].kind).toBe('file');
      expect(report.native.status).toBe(process.platform === 'win32' ? 'not-started' : 'unsupported');
      if (mode === 'collection-failure') expect(report.profile.markers.DevToolsActivePort.error).toBe('EISDIR');
      else if (mode !== 'caller-profile') expect(report.profile.markers.DevToolsActivePort.port).toBe(12345);
      expect(raw).not.toContain('secret-websocket');
      expect(raw).not.toContain('never-serialize');
      expect(raw).not.toContain('CommandLine');
      expect(raw).not.toContain('--eval');
    }
  } finally {
    if (captured) {
      rmSync(join(artifacts, `browser-${captured.pid}-attempt-1.json`), { force: true, recursive: true });
      rmSync(join(artifacts, `browser-${captured.pid}.log`), { force: true });
      rmSync(captured.profile, { recursive: true, force: true });
    }
    rmSync(fixture, { recursive: true, force: true });
  }
}, 10_000);
