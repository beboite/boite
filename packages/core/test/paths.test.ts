import { expect, test } from 'bun:test';
import { posix } from 'node:path';
import { defaultDataDir } from '../src/paths.ts';

test('Linux uses an absolute XDG data home, preserving spaces and both channels', () => {
  const env = { XDG_DATA_HOME: "/tmp/Boite's données" };
  expect(defaultDataDir('stable', 'linux', env, '/home/test', () => false)).toBe("/tmp/Boite's données/boite2");
  expect(defaultDataDir('dev', 'linux', env, '/home/test', () => false)).toBe("/tmp/Boite's données/boite2-dev");
});

test('Linux ignores unset, empty and relative XDG data homes', () => {
  for (const value of [undefined, '', 'relative/data']) {
    expect(defaultDataDir('stable', 'linux', { XDG_DATA_HOME: value }, '/home/test'))
      .toBe(posix.join('/home/test', '.local', 'share', 'boite2'));
  }
});

test('macOS keeps Application Support regardless of the XDG environment', () => {
  expect(defaultDataDir('dev', 'macos', { XDG_DATA_HOME: '/tmp/xdg' }, '/Users/test'))
    .toBe('/Users/test/Library/Application Support/boite2-dev');
});

test('Linux keeps an existing legacy journal until the XDG directory has a journal', () => {
  const legacy = '/home/test/.local/share/boite2';
  const xdg = '/tmp/xdg/boite2';
  const env = { XDG_DATA_HOME: '/tmp/xdg' };
  expect(defaultDataDir('stable', 'linux', env, '/home/test', path => path === `${legacy}/journal.db`)).toBe(legacy);
  expect(defaultDataDir('stable', 'linux', env, '/home/test', () => true)).toBe(xdg);
  expect(defaultDataDir('stable', 'linux', env, '/home/test', () => false)).toBe(xdg);
});
