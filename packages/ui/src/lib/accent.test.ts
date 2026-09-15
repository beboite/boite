import { afterEach, expect, test } from 'vitest';
import { ACCENT_KEY, readAccent, setAccent } from './accent';

afterEach(() => { localStorage.clear(); document.documentElement.style.removeProperty('--accent-hue'); });

test('accent persists and invalid values cannot become CSS', () => {
  setAccent(145);
  expect(readAccent()).toBe(145);
  expect(document.documentElement.style.getPropertyValue('--accent-hue')).toBe('145');
  setAccent(NaN);
  expect(readAccent()).toBe(145);
  localStorage.setItem(ACCENT_KEY, '361');
  expect(readAccent()).toBe(260);
});
