import { expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an abandoned session expires under the busy guard and shutdown removes its private control file', async () => {
  const output = mkdtempSync(join(tmpdir(), 'boite-session-test-'));
  const previousOutput = process.env.BOITE_BENCH_SESSION_OUTPUT;
  const previousBinary = process.env.BOITE_BROWSER_TEST_BINARY;
  process.env.BOITE_BENCH_SESSION_OUTPUT = output;
  process.env.BOITE_BROWSER_TEST_BINARY = 'test-daemon';
  let now = 0; let closes = 0; let stopped = false; let exited = false;
  let tick!: () => Promise<void>;
  let releaseClose = () => {};
  let closeGate: Promise<void> | undefined;
  const commands: string[] = [];
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      commands.push(action === 'evaluate' ? String(args.script) : action);
      if (action === 'evaluate') return { result: args.script === 'location.href' ? 'https://example.test/' : { url: 'https://example.test/', title: 'Fixture', text: 'Waiting' } };
      return {};
    },
    async close() { closes++; await closeGate; },
  };
  mock.module('../packages/core/test/harness.ts', () => ({ startTestCore: async () => ({ core: { procs: { liveCount: () => 0 } }, stop: async () => { stopped = true; } }) }));
  mock.module('../packages/core/src/browser/daemon.ts', () => ({ BrowserDaemon: { launch: async () => daemon } }));
  mock.module('../tests/e2e/lib/cdp.ts', () => ({ findBrowser: () => 'test-browser' }));
  mock.module('./browser-real.ts', () => ({ tasks: [{ id: 'wikipedia', url: 'https://example.test/', goal: 'Wait for completion', values: {}, completion: { url: 'https://example.test/done', text: 'Done' } }] }));
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const originalInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => Promise<void>) => {
    tick = callback;
    const timer = originalInterval(() => {}, 3_600_000);
    timer.unref();
    return timer;
  }) as typeof setInterval);
  const exit = spyOn(process, 'exit').mockImplementation(() => { exited = true; return undefined as never; });
  let control: { url: string; token: string } | undefined;
  const call = (path: string, body = {}) => fetch(`${control!.url}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${control!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await import('./browser-session.ts');
    control = JSON.parse(readFileSync(join(output, 'control.json'), 'utf8'));
    if (process.platform !== 'win32') expect(statSync(join(output, 'control.json')).mode & 0o777).toBe(0o600);
    expect((await call('start', { arm: 'visual', task: 'wikipedia', run: 1 })).status).toBe(200);
    now = 119_999;
    await tick();
    expect(commands.at(-1)).toBe('0');
    expect(closes).toBe(0);
    now = 120_000;
    const keepalives = commands.filter(command => command === '0').length;
    closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const expiring = tick();
    await Bun.sleep(0);
    expect((await call('status')).status).toBe(409);
    releaseClose();
    await expiring;
    expect(closes).toBe(1);
    expect(commands.filter(command => command === '0').length).toBe(keepalives);
    const result = JSON.parse(readFileSync(join(output, 'visual-wikipedia-1.json'), 'utf8'));
    expect(result.note).toBe('120 second execution limit');
    expect(result.verified).toBe(false);
    expect(result.processesAfter).toBe(0);
    expect(await (await call('status')).json()).toEqual({ active: null });
    await tick();
    expect(closes).toBe(1);
    expect((await call('start', { arm: 'visual', task: 'wikipedia', run: 2 })).status).toBe(200);
    expect((await call('shutdown')).status).toBe(200);
    expect(existsSync(join(output, 'control.json'))).toBe(false);
    expect(stopped).toBe(true);
    await Bun.sleep(150);
    expect(exited).toBe(true);
    writeFileSync(join(output, 'control.json'), 'existing owner');
    stopped = false;
    const entry = './browser-session.ts?existing-control';
    await expect(import(entry)).rejects.toThrow('EEXIST');
    expect(readFileSync(join(output, 'control.json'), 'utf8')).toBe('existing owner');
    expect(stopped).toBe(true);
  } finally {
    releaseClose();
    if (control && !stopped) { await call('shutdown').catch(() => {}); await Bun.sleep(150); }
    clock.mockRestore(); interval.mockRestore(); exit.mockRestore();
    if (previousOutput === undefined) delete process.env.BOITE_BENCH_SESSION_OUTPUT; else process.env.BOITE_BENCH_SESSION_OUTPUT = previousOutput;
    if (previousBinary === undefined) delete process.env.BOITE_BROWSER_TEST_BINARY; else process.env.BOITE_BROWSER_TEST_BINARY = previousBinary;
    rmSync(output, { recursive: true, force: true });
  }
}, 5000);
