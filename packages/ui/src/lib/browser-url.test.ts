import { expect, test } from 'vitest';
import { normalizeUrl } from './browser-bridge';

test('addresses distinguish local dev servers, public hosts and search queries', () => {
  expect(normalizeUrl(' localhost:5173/page ')).toBe('http://localhost:5173/page');
  expect(normalizeUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  expect(normalizeUrl('[::1]:8080')).toBe('http://[::1]:8080/');
  expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
  expect(normalizeUrl('how to write svelte')).toBe('https://www.google.com/search?q=how%20to%20write%20svelte');
  expect(normalizeUrl('https://example.com/a?q=1#test')).toBe('https://example.com/a?q=1#test');
});

test('empty, invalid and non-web addresses do not navigate', () => {
  for (const input of ['', '  ', 'javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'https://', 'http://localhost:99999']) {
    expect(normalizeUrl(input), input).toBeNull();
  }
});
