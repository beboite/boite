import { expect, spyOn, test } from 'bun:test';
import { checkSettingsPatch } from '@boite/contracts';
import { profileIdentity } from '../src/browser/chromium.ts';
import { BrowserEngines } from '../src/browser/engines.ts';
import { BrowserHost } from '../src/browser/host.ts';
import { Cdp } from '../src/browser/cdp.ts';
import type { Engine } from '../src/browser/types.ts';
import type { Connection } from '../src/router.ts';
import { startTestCore } from './harness.ts';

test('profile User-Agent preserves the default, appends a suffix or replaces the whole value', () => {
  const native = { userAgent: 'Mozilla/5.0 Chrome/154.0.0.0', metadata: { platform: 'Windows', brands: [{ brand: 'Chromium', version: '154' }] } };
  expect(profileIdentity(native)).toBe(native);
  expect(profileIdentity(native, { mode: 'suffix', value: '' })).toBe(native);
  expect(profileIdentity(native, { mode: 'replace', value: '   ' })).toBe(native);
  expect(profileIdentity(native, { mode: 'suffix', value: ' Bounty/1 ' })).toEqual({ ...native, userAgent: `${native.userAgent} Bounty/1` });
  expect(profileIdentity(native, { mode: 'replace', value: 'Research/1' })).toEqual({ ...native, userAgent: 'Research/1' });
  expect(native.userAgent).toBe('Mozilla/5.0 Chrome/154.0.0.0');
});

test('profile settings keep User-Agent modes, normalize empty to absent and refuse injected headers', () => {
  const profile = { id: 'p-research', name: 'Research' };
  for (const mode of ['suffix', 'replace'] as const) {
    const userAgent = { mode, value: 'Bounty/1' };
    expect(checkSettingsPatch({ browserProfiles: [{ ...profile, userAgent: { ...userAgent, value: ' Bounty/1 ' } }] }))
      .toEqual({ ok: true, patch: { browserProfiles: [{ ...profile, userAgent }] } });
    expect(checkSettingsPatch({ browserProfiles: [{ ...profile, userAgent: { mode, value: '' } }] }))
      .toEqual({ ok: true, patch: { browserProfiles: [profile] } });
  }
  for (const userAgent of [null, 'Bounty/1', {}, { mode: 'other', value: 'ok' }, { mode: 'suffix', value: 1 },
    ...['x\r\nX-Injected: yes', '\t', '\x00', '\x7f', 'é', 'x'.repeat(8193)].map(value => ({ mode: 'suffix', value }))]) {
    expect(checkSettingsPatch({ browserProfiles: [{ ...profile, userAgent } as never] })).toMatchObject({ ok: false, field: 'browserProfiles' });
  }
});

test('User-Agent changes keep one engine owning a profile until its current engine closes', async () => {
  const harness = await startTestCore();
  const host = new BrowserHost();
  host.attach({ identity: { principal: 'owner' }, sentFrom: { client: 'shell' }, remote: false } as Connection);
  const hostedEngines = new BrowserEngines(harness.core, host, () => ({ path: null, reason: 'unused' }), 'fixture', 'system:browser', () => {}, () => {},
    { prepare: () => harness.dataDir, lost: () => {} });
  const created: Engine[] = [];
  // Keep the real acquisition and shutdown paths, without starting a native process.
  const launching = spyOn(hostedEngines, 'launch').mockImplementation(async (profile, _identify, hosted) => {
    const relay = Cdp.relay(() => {}, () => { relay.end(); });
    const { cdp } = relay;
    const engine: Engine = { key: hosted ? `host:${profile}` : profile, profile, hosted: !!hosted, dir: '', cdp,
      kill: () => cdp.close(), exited: cdp.closed, tabs: new Set(['open-tab']), throwaway: false, identity: null };
    created.push(engine);
    return engine;
  });
  let owner: Awaited<ReturnType<typeof harness.connect>> | undefined;
  try {
    owner = await harness.connect();
    await owner.call('settings.set', { browserProfiles: [{ id: 'p-research', name: 'Research' }] });
    const hosted = await hostedEngines.get('p-research');
    await owner.call('settings.set', { browserProfiles: [{ id: 'p-research', name: 'Research', userAgent: { mode: 'suffix', value: 'Bounty/1' } }] });
    expect(await hostedEngines.get('p-research')).toBe(hosted);
    expect(created).toHaveLength(1);
    const stopping = hostedEngines.shut(hosted);
    const opening = hostedEngines.get('p-research');
    await Promise.resolve();
    expect(created).toHaveLength(1);
    hosted.cdp.close();
    await stopping;
    const local = await opening;
    expect(local.hosted).toBe(false);
    await owner.call('settings.set', { browserProfiles: [{ id: 'p-research', name: 'Research' }] });
    expect(await hostedEngines.get('p-research')).toBe(local);
    expect(created).toHaveLength(2);
    local.cdp.close();
    await hostedEngines.shut(local);
    expect((await hostedEngines.get('p-research')).hosted).toBe(true);
  } finally {
    for (const engine of created) { engine.cdp.close(); hostedEngines.lost(engine); }
    launching.mockRestore();
    host.detach();
    owner?.close(); await harness.stop();
  }
});
