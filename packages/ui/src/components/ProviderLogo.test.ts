import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProviderLogo from './ProviderLogo.svelte';
import { providerLogos } from '../lib/provider-logos';

/**
 * The rail draws providers and nothing else, so a mark that fails to draw has to
 * fall back to something readable rather than to an empty tile.
 */

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

function draw(providerId: string, size = 18): void {
  running = mount(ProviderLogo, { target: document.body, props: { providerId, size } });
  flushSync();
}

test('a provider with a mark draws its path at the size it was given', () => {
  draw('claude', 20);

  const svg = document.querySelector('svg[data-logo=claude]');
  expect(svg).not.toBeNull();
  expect(svg?.getAttribute('width')).toBe('20');
  expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  expect(svg?.getAttribute('fill')).toBe('currentColor');
  expect(svg?.querySelector('path')?.getAttribute('d')).toBe(providerLogos['claude']?.path);
  expect(document.querySelector('[data-initial]')).toBeNull();
});

test('a mark drawn as a line is stroked in currentColor rather than filled', () => {
  draw('codex');

  const svg = document.querySelector('svg[data-logo=codex]');
  expect(svg?.getAttribute('fill')).toBe('none');
  expect(svg?.getAttribute('stroke')).toBe('currentColor');
  expect(svg?.getAttribute('stroke-width')).toBe('1.6');
});

test('a provider nobody drew falls back to its initial', () => {
  draw('echo');

  expect(document.querySelector('svg')).toBeNull();
  const initial = document.querySelector('[data-initial=echo]');
  expect(initial?.textContent?.trim()).toBe('E');
});
