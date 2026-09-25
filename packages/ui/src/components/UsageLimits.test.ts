import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AccountQuota } from '@boite/contracts';
import { setLocaleSetting } from '../lib/i18n.svelte';
import EffortSlider from './EffortSlider.svelte';
import UsageLimits from './UsageLimits.svelte';

let component: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  setLocaleSetting('en');
});

const friday = new Date(2026, 8, 25, 3, 30).getTime();
const quota: AccountQuota = {
  accountId: 'claude-default', providerId: 'claude', providerName: 'Claude', label: 'Work', enabled: true, status: 'ready',
  windows: [
    { id: 'five_hour', label: '5 hours', usedPercent: 13.5, resetsAt: friday },
    { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: friday }
  ],
  checkedAt: friday, error: null
} as AccountQuota;

test('the limits and the effort chip read in French when the app speaks French, whatever the system', () => {
  setLocaleSetting('fr');
  component = mount(UsageLimits, { target: document.body, props: { rows: [quota] } });
  flushSync();
  const limits = document.body.textContent ?? '';
  expect(limits).toContain('5 heures');
  expect(limits).toContain('Hebdomadaire');
  expect(limits).toContain('86,5 % restants');
  expect(limits).not.toMatch(/Weekly|5 hours|Fri|AM|PM/);
  unmount(component);

  document.body.innerHTML = '';
  component = mount(EffortSlider, { target: document.body, props: {
    levels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], active: 'high', onpick: () => {},
    speeds: [{ id: 'fast', label: 'Fast' }], speed: 'fast', onspeed: () => {}
  } });
  flushSync();
  const chip = document.body.textContent ?? '';
  expect(chip).toContain('Élevé');
  expect(chip).toContain('Rapide');
  expect(chip).not.toMatch(/High|Fast/);
});
