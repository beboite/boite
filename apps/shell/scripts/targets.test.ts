import { expect, test } from 'bun:test';
import { bunTarget, shellTarget } from './targets.ts';

test('an Apple Silicon runner builds the Intel shell and core it is asked for', () => {
  expect(shellTarget('x86_64-apple-darwin', 'darwin', 'arm64')).toEqual({ triple: 'x86_64-apple-darwin', suffix: '', cross: true, arch: 'x64' });
  expect(bunTarget('darwin', 'x64')).toBe('bun-darwin-x64');
});

test('without a target, or naming its own, a runner builds natively', () => {
  for (const requested of [undefined, '', 'aarch64-apple-darwin']) {
    expect(shellTarget(requested, 'darwin', 'arm64')).toEqual({ triple: 'aarch64-apple-darwin', suffix: '', cross: false, arch: 'arm64' });
  }
  expect(shellTarget(undefined, 'win32', 'x64')).toMatchObject({ triple: 'x86_64-pc-windows-msvc', suffix: '.exe', cross: false });
});

test('a target of another operating system is refused with the ones the runner can build', () => {
  expect(() => shellTarget('x86_64-pc-windows-msvc', 'darwin', 'arm64')).toThrow('expected one of x86_64-apple-darwin, aarch64-apple-darwin on darwin');
  expect(() => shellTarget('x86_64-apple-darwin', 'linux', 'x64')).toThrow('BOITE_TARGET=x86_64-apple-darwin');
});

test('Windows and Linux x64 cores embed the baseline runtime that needs no AVX2', () => {
  expect(bunTarget('win32', 'x64')).toBe('bun-windows-x64-baseline');
  expect(bunTarget('linux', 'x64')).toBe('bun-linux-x64-baseline');
  expect(bunTarget('linux', 'arm64')).toBe('bun-linux-arm64');
  expect(() => bunTarget('win32', 'arm64')).toThrow('Unsupported core target');
});
