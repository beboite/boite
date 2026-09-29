import { expect, test } from 'vitest';
import { normalizeUrl } from './browser-bridge';

test('addresses distinguish local dev servers, public hosts and search queries', () => {
  expect(normalizeUrl(' localhost:5173/page ')).toBe('http://localhost:5173/page');
  expect(normalizeUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  expect(normalizeUrl('[::1]:8080')).toBe('http://[::1]:8080/');
  expect(normalizeUrl('10.0.0.8:5173')).toBe('http://10.0.0.8:5173/');
  expect(normalizeUrl('172.31.0.8:5173')).toBe('http://172.31.0.8:5173/');
  expect(normalizeUrl('192.168.0.8:5173')).toBe('http://192.168.0.8:5173/');
  expect(normalizeUrl('169.254.0.8:5173')).toBe('http://169.254.0.8:5173/');
  expect(normalizeUrl('172.32.0.8:5173')).toBe('https://172.32.0.8:5173/');
  expect(normalizeUrl('https://192.168.0.8:5173')).toBe('https://192.168.0.8:5173/');
  expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
  expect(normalizeUrl('how to write svelte')).toBe('https://www.google.com/search?q=how%20to%20write%20svelte');
  expect(normalizeUrl('error: cannot find module')).toBe('https://www.google.com/search?q=error%3A%20cannot%20find%20module');
  expect(normalizeUrl('https://example.com/a?q=1#test')).toBe('https://example.com/a?q=1#test');
});

test('empty, invalid and non-web addresses do not navigate', () => {
  for (const input of ['', '  ', 'javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'https://', 'http://localhost:99999']) {
    expect(normalizeUrl(input), input).toBeNull();
  }
});
