import { expect, test } from 'bun:test';
import { checkSettingsPatch } from '@boite/contracts';
import { profileIdentity } from '../src/browser/chromium.ts';

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
