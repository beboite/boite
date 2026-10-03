import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { describeTailscale, tailscale } from '../src/main.ts';
import { findTailscaleCli } from '../src/platform/tailscale.ts';
import { classifyFailure, normalizeDnsName, proxiesTo, servedOn443, TAILSCALE_DNS_ADMIN, TailscaleAccess, tailscaleUrl } from '../src/tailscale.ts';
import { removeDir, startTestCore, type TestCore } from './harness.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-tailscale.ts');
const DNS = 'skoll-test.tail0000.ts.net';
const URL_ = `https://${DNS}`;

let harness: TestCore;
let dir: string;
let statePath: string;

const running = (extra: Record<string, unknown> = {}) => ({
  BackendState: 'Running',
  Self: { DNSName: `${DNS}.` },
  CertDomains: [DNS],
  CurrentTailnet: { MagicDNSEnabled: true },
  ...extra,
});

function writeState(state: Record<string, unknown>): void {
  writeFileSync(statePath, JSON.stringify({ serve: {}, ...state }));
}

function calls(): string[] {
  const log = `${statePath}.log`;
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function access(): TailscaleAccess {
  return new TailscaleAccess(harness.core, { cli: () => [process.execPath, FAKE, statePath] });
}

function port(): string {
  return new URL(harness.url).port;
}

beforeEach(async () => {
  harness = await startTestCore();
  dir = mkdtempSync(join(tmpdir(), 'boite-tailscale-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  await harness.stop();
  await removeDir(dir);
});

describe('reading the tailscale CLI', () => {
  test('no CLI is missing', async () => {
    const status = await new TailscaleAccess(harness.core, { cli: () => null }).status();
    expect(status.state).toBe('missing');
    expect(status.target).toBe(`http://127.0.0.1:${port()}`);
  });

  test('a daemon that does not answer is stopped; a refused one is a permission error, with no CLI text', async () => {
    writeState({ status: null });
    expect((await access().status()).state).toBe('stopped');
    writeState({ status: null, statusStderr: 'Access denied: status denied, auth key tskey-auth-SECRET' });
    const denied = await access().status();
    expect(denied).toMatchObject({ state: 'error', detail: 'permission-denied' });
    expect(JSON.stringify(denied)).not.toContain('tskey');
  });

  test('signed out gives the sign-in page, and only a Tailscale one', async () => {
    writeState({ status: { BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc123' } });
    expect(await access().status()).toMatchObject({ state: 'needs-login', actionUrl: 'https://login.tailscale.com/a/abc123' });
    writeState({ status: { BackendState: 'NeedsLogin', AuthURL: 'https://evil.example/a' } });
    expect((await access().status()).actionUrl).toBeUndefined();
    writeState({ status: { BackendState: 'Stopped' } });
    expect((await access().status()).state).toBe('stopped');
  });

  test('no certificate for the name, or MagicDNS off, is https-disabled with the admin page', async () => {
    writeState({ status: running({ CertDomains: null }) });
    expect(await access().status()).toMatchObject({ state: 'https-disabled', dnsName: DNS, actionUrl: TAILSCALE_DNS_ADMIN });
    writeState({ status: running({ CurrentTailnet: { MagicDNSEnabled: false } }) });
    expect((await access().status()).state).toBe('https-disabled');
  });

  test('443 serving another target is a conflict that names it', async () => {
    writeState({ status: running(), serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:17338' } } } } } });
    expect(await access().status()).toMatchObject({ state: 'conflict', url: URL_, servedTarget: 'http://127.0.0.1:17338' });
    expect(calls()).toEqual(['status --json', 'serve status --json']);
  });
});

describe('turning it on and off', () => {
  test('on serves this core on 443 and makes its URL the public one; off undoes both', async () => {
    writeState({ status: running() });
    expect((await access().status()).state).toBe('off');
    const on = await access().enable();
    expect(on).toMatchObject({ state: 'on', url: URL_, servedTarget: `http://127.0.0.1:${port()}`, publicUrlMatches: true });
    expect(harness.core.settings.get().publicUrl).toBe(URL_);
    expect(harness.core.sessions.grant().url.startsWith(`${URL_}/?grant=`)).toBe(true);
    expect(calls()).toContain(`serve --bg --https=443 http://127.0.0.1:${port()}`);

    // Again: nothing to do, nothing run.
    const writes = () => calls().filter((call) => call.startsWith('serve --')).length;
    expect(writes()).toBe(1);
    expect((await access().enable()).state).toBe('on');
    expect(writes()).toBe(1);

    const off = await access().disable();
    expect(off).toMatchObject({ state: 'off', publicUrlMatches: false });
    expect(harness.core.settings.get().publicUrl).toBeNull();
    expect(calls()).toContain('serve --https=443 off');
  });

  test('a conflict is left alone without replace, and taken over with it', async () => {
    const other = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:17338' } } } } };
    writeState({ status: running(), serve: other });
    expect((await access().enable()).state).toBe('conflict');
    expect((await access().disable()).state).toBe('conflict');
    expect(calls().filter((call) => call.startsWith('serve --'))).toEqual([]);
    expect(harness.core.settings.get().publicUrl ?? null).toBeNull();

    const replaced = await access().enable(true);
    expect(replaced.state).toBe('on');
    expect(calls().filter((call) => call.startsWith('serve --'))).toEqual(['serve --https=443 off', `serve --bg --https=443 http://127.0.0.1:${port()}`]);
  });

  test('a tailnet that never allowed Serve hands back its consent page, and the public URL stays', async () => {
    harness.core.settings.set({ publicUrl: 'https://kept.example' });
    writeState({ status: running(), consent: 'https://login.tailscale.com/f/serve?node=n1' });
    const status = await access().enable();
    expect(status).toMatchObject({ state: 'off', detail: 'serve-consent', actionUrl: 'https://login.tailscale.com/f/serve?node=n1' });
    expect(harness.core.settings.get().publicUrl).toBe('https://kept.example');
  });

  test('a refused serve is a permission error with no CLI text', async () => {
    writeState({ status: running(), denied: true });
    const status = await access().enable();
    expect(status).toMatchObject({ state: 'off', detail: 'permission-denied' });
    expect(JSON.stringify(status)).not.toContain('tskey');
  });

  test('off leaves a public URL that is not the tailnet one', async () => {
    writeState({ status: running() });
    await access().enable();
    harness.core.settings.set({ publicUrl: 'https://other.example' });
    await access().disable();
    expect(harness.core.settings.get().publicUrl).toBe('https://other.example');
  });
});

describe('through the RPC and the command line', () => {
  let saved: { cli?: string; state?: string };
  beforeEach(() => {
    saved = { cli: process.env['BOITE_TAILSCALE_CLI'], state: process.env['FAKE_TAILSCALE_STATE'] };
    process.env['BOITE_TAILSCALE_CLI'] = FAKE;
    process.env['FAKE_TAILSCALE_STATE'] = statePath;
  });
  afterEach(() => {
    if (saved.cli === undefined) delete process.env['BOITE_TAILSCALE_CLI'];
    else process.env['BOITE_TAILSCALE_CLI'] = saved.cli;
    if (saved.state === undefined) delete process.env['FAKE_TAILSCALE_STATE'];
    else process.env['FAKE_TAILSCALE_STATE'] = saved.state;
  });

  test('the owner reads and switches it; a paired phone is refused all three', async () => {
    writeState({ status: running() });
    const owner = await harness.connect();
    expect((await owner.call('tailscale.status', {})).state).toBe('off');
    expect((await owner.call('tailscale.enable', {})).state).toBe('on');

    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant });
    for (const method of ['tailscale.status', 'tailscale.enable', 'tailscale.disable'] as const) {
      let refused = 'none';
      try {
        await phone.call(method, {});
      } catch (error) {
        refused = (error as Error).message;
      }
      expect(refused).toBe(`${method} is for the owner only`);
    }
    expect((await owner.call('tailscale.disable', {})).state).toBe('off');
  });

  test('boite-core tailscale reads core.json and says what it did', async () => {
    writeState({ status: running() });
    const state = { port: Number(port()), host: '127.0.0.1', token: harness.token, pid: process.pid, startedAt: Date.now(), version: 'test' };
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify(state));
    const status = await tailscale(['status', '--data-dir', harness.dataDir]);
    expect(describeTailscale(status)).toBe(`Ready: ${URL_} is not served. Run "boite-core tailscale on".`);
    const on = await tailscale(['on', '--data-dir', harness.dataDir]);
    expect(describeTailscale(on)).toBe(`Serving ${URL_} -> http://127.0.0.1:${port()}. Pairing links use it.`);
    expect((await tailscale(['off', '--data-dir', harness.dataDir])).state).toBe('off');
    let wrong = 'none';
    try {
      await tailscale(['up', '--data-dir', harness.dataDir]);
    } catch (error) {
      wrong = (error as Error).message;
    }
    expect(wrong).toBe('tailscale takes status, on or off, got up');
    expect(describeTailscale({ state: 'https-disabled', dnsName: DNS, url: null, servedTarget: null, target: 'x', publicUrlMatches: false, actionUrl: TAILSCALE_DNS_ADMIN }))
      .toContain(`\nOpen ${TAILSCALE_DNS_ADMIN}`);
  });
});

describe('pure helpers', () => {
  test('failures reduce to labels', () => {
    expect(classifyFailure('Serve is not enabled on your tailnet. https://login.tailscale.com/f/serve?node=x')).toBe('serve-consent');
    expect(classifyFailure('Logged out.')).toBe('not-logged-in');
    expect(classifyFailure("Access denied: use 'sudo tailscale serve'")).toBe('permission-denied');
    expect(classifyFailure('something odd')).toBe('unknown');
    expect(tailscaleUrl('visit https://login.tailscale.com/f/serve?node=abc now')).toBe('https://login.tailscale.com/f/serve?node=abc');
    expect(tailscaleUrl('visit https://example.com/f/serve')).toBeUndefined();
  });

  test('names, served targets and loopback proxies', () => {
    expect(normalizeDnsName('Skoll-3.tail0d6070.ts.net.')).toBe('skoll-3.tail0d6070.ts.net');
    expect(normalizeDnsName('')).toBeNull();
    expect(normalizeDnsName(42)).toBeNull();
    const host = `${DNS}:443`;
    expect(servedOn443({}, DNS)).toBeNull();
    expect(servedOn443({ Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }, DNS)).toBe('http://127.0.0.1:1');
    expect(servedOn443({ Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' }, '/x': { Path: '/srv' } } } } }, DNS)).toBe('/ → http://127.0.0.1:1, /x → /srv');
    expect(servedOn443({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }, DNS)).toBe('tcp://127.0.0.1:22');
    expect(proxiesTo('http://127.0.0.1:8777', '8777')).toBe(true);
    expect(proxiesTo('localhost:8777', '8777')).toBe(true);
    expect(proxiesTo('http://127.0.0.1:17338', '8777')).toBe(false);
    expect(proxiesTo('https://127.0.0.1:8777', '8777')).toBe(false);
  });

  test('the platform finds the CLI on PATH, then where installers put it', () => {
    expect(findTailscaleCli('linux', (name) => (name === 'tailscale' ? '/usr/bin/tailscale' : null))).toBe('/usr/bin/tailscale');
    expect(findTailscaleCli('windows', (name) => (name === 'tailscale.exe' ? 'C:\\T\\tailscale.exe' : null))).toBe('C:\\T\\tailscale.exe');
  });
});
