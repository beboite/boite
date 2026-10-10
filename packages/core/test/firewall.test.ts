import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { FirewallAccess, judge, parseReading, type FirewallReading } from '../src/firewall.ts';
import { removeDir, startTestCore, type TestCore } from './harness.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-firewall.ts');
const ethernet = (category: string) => ({ adapter: 'Ethernet0', category });
const tailnet = { adapter: 'Tailscale', category: 'Private' };

describe('judge', () => {
  test('a dismissed prompt leaves block rules on the network it was raised on', () => {
    const reading: FirewallReading = { rules: [{ action: 0, profiles: 4 }, { action: 0, profiles: 4 }], networks: [ethernet('Public')], off: 0 };
    expect(judge(reading)).toEqual({ state: 'blocked', networks: ['public'], allowed: [], blocked: ['public'] });
  });

  test('a prompt allowed on a public network does not cover the same network once it is private', () => {
    const reading: FirewallReading = { rules: [{ action: 1, profiles: 4 }], networks: [ethernet('Private'), tailnet], off: 0 };
    expect(judge(reading)).toEqual({ state: 'unset', networks: ['private'], allowed: [], blocked: [] });
  });

  test('a block wins over an allow, and a profile with the firewall off lets everything in', () => {
    expect(judge({ rules: [{ action: 1, profiles: 0x7fffffff }, { action: 0, profiles: 2 }], networks: [ethernet('Private')], off: 0 }).state).toBe('blocked');
    expect(judge({ rules: [{ action: 0, profiles: 2 }], networks: [ethernet('Private')], off: 2 }).state).toBe('ready');
  });

  test('the rule Boite adds covers every network, and Tailscale alone needs none', () => {
    expect(judge({ rules: [{ action: 1, profiles: 0x7fffffff }], networks: [ethernet('Public'), { adapter: 'Wi-Fi', category: 'DomainAuthenticated' }], off: 0 }))
      .toEqual({ state: 'ready', networks: ['public', 'domain'], allowed: ['public', 'domain'], blocked: [] });
    expect(judge({ rules: [], networks: [tailnet], off: 0 }).state).toBe('ready');
  });
});

test('parseReading takes the single objects ConvertTo-Json writes for one-element arrays', () => {
  expect(parseReading('{"rules":{"action":0,"profiles":4},"networks":{"adapter":"Ethernet0","category":"Public"},"off":0}\r\n'))
    .toEqual({ rules: [{ action: 0, profiles: 4 }], networks: [{ adapter: 'Ethernet0', category: 'Public' }], off: 0 });
  expect(parseReading('{"rules":[],"networks":[],"off":0}')).toEqual({ rules: [], networks: [], off: 0 });
  expect(parseReading('Get-NetConnectionProfile : access denied')).toBeNull();
});

describe('the firewall methods', () => {
  let harness: TestCore;
  let dir: string;
  let state: string;

  beforeEach(async () => {
    harness = await startTestCore();
    dir = mkdtempSync(join(tmpdir(), 'boite-firewall-'));
    state = join(dir, 'reading.json');
  });

  afterEach(async () => {
    await harness.stop();
    removeDir(dir);
  });

  const access = () => new FirewallAccess(harness.core, {
    program: 'C:\\Users\\someone\\AppData\\Local\\Boite\\boite-core.exe',
    commands: {
      query: () => [process.execPath, FAKE, state, 'query'],
      allow: () => [process.execPath, FAKE, state, 'allow'],
    },
  });

  test('allow turns a blocked network ready, and says when the administrator prompt was refused', async () => {
    writeFileSync(state, JSON.stringify({ rules: [{ action: 0, profiles: 4 }], networks: [ethernet('Public')], off: 0 }));
    writeFileSync(`${state}.refuse`, '');
    expect(await access().allow()).toEqual({ state: 'blocked', networks: ['public'], allowed: [], blocked: ['public'], detail: 'cancelled' });
    removeDir(`${state}.refuse`);
    expect((await access().allow()).state).toBe('ready');
    expect((await access().status()).state).toBe('ready');
  });

  test('an unreadable answer is an error, not a verdict', async () => {
    writeFileSync(state, 'not json');
    expect(await access().status()).toEqual({ state: 'error', networks: [], allowed: [], blocked: [], detail: 'unknown' });
  });

  test('the owner reads it, unsupported off Windows; a paired phone is refused both', async () => {
    const owner = await harness.connect();
    if (process.platform !== 'win32') expect((await owner.call('firewall.status', {})).state).toBe('unsupported');
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant });
    for (const method of ['firewall.status', 'firewall.allow'] as const) {
      let refused = 'none';
      try {
        await phone.call(method, {});
      } catch (error) {
        refused = (error as Error).message;
      }
      expect(refused).toBe(`${method} is for the owner only`);
    }
  });
});
