import {expect, test} from 'bun:test';
import {windowsScratchParent} from '../src/platform/windows/protected.ts';

test('Windows private copies use the system volume even when TEMP points at a project volume', () => {
  expect(windowsScratchParent('C:\\Windows', 'D:\\runner\\temp', 'C:\\Users\\runner\\AppData\\Local', path => path))
    .toBe('C:\\Users\\runner\\AppData\\Local\\Temp');
  // Preserve a configured temporary directory that already supports Bun's
  // AppContainer directory-name fallback.
  expect(windowsScratchParent('C:\\Windows', 'c:\\custom-temp', 'D:\\profile', path => path)).toBe('c:\\custom-temp');
});

test('Windows refuses a scratch configuration with no user temporary directory on the system volume', () => {
  for (const local of [undefined, 'D:\\profile', 'C:relative-profile']) {
    expect(() => windowsScratchParent('C:\\Windows', 'D:\\runner\\temp', local, path => path)).toThrow('execution.windows.scratch');
  }
});


test('canonical profile targets determine scratch selection and an already compatible TEMP stays independent', () => {
  const canonical = (path: string) => path === 'D:\\profile-link' ? 'C:\\Users\\runner\\AppData\\Local'
    : path === 'C:\\profile-link' ? 'D:\\profile' : path;
  expect(windowsScratchParent('C:\\Windows', 'D:\\runner\\temp', 'D:\\profile-link', canonical))
    .toBe('C:\\Users\\runner\\AppData\\Local\\Temp');
  expect(() => windowsScratchParent('C:\\Windows', 'D:\\runner\\temp', 'C:\\profile-link', canonical))
    .toThrow('execution.windows.scratch');
  expect(windowsScratchParent('C:\\Windows', 'C:\\temp', 'missing-profile', path => {
    if (path === 'missing-profile') throw new Error('unused profile was accessed');
    return path;
  })).toBe('C:\\temp');
});
