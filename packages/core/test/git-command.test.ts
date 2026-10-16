import { beforeEach, describe, expect, test } from 'bun:test';
import { forgetGitLaunches, gitLaunch, longPathConfigEnv, realGitForWindows } from '../src/git/command.ts';

const LAUNCHER = 'C:\\Program Files\\Git\\cmd\\git.exe';
const REAL = 'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe';
const OLD_REAL = 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe';

beforeEach(() => forgetGitLaunches());

describe('core.longpaths', () => {
  test('is added on Windows only, after the config entries git already inherits', () => {
    expect(longPathConfigEnv('linux', {})).toEqual({});
    expect(longPathConfigEnv('darwin', {})).toEqual({});
    expect(longPathConfigEnv('win32', {})).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' });
    expect(longPathConfigEnv('win32', { Git_Config_Count: '2' })).toEqual({ Git_Config_Count: '3', GIT_CONFIG_KEY_2: 'core.longpaths', GIT_CONFIG_VALUE_2: 'true' });
  });

  test('leaves a count git would reject alone, so git reports it', () => {
    expect(longPathConfigEnv('win32', { GIT_CONFIG_COUNT: 'two' })).toEqual({});
    expect(longPathConfigEnv('win32', { GIT_CONFIG_COUNT: '2x' })).toEqual({});
  });
});

describe('Git for Windows binary', () => {
  test('swaps the cmd or bin launcher for the real binary of the first build present', () => {
    expect(realGitForWindows(LAUNCHER, {}, (path) => path === REAL || path === OLD_REAL)).toBe(REAL);
    expect(realGitForWindows('C:\\Git\\bin\\git.exe', {}, (path) => path === 'C:\\Git\\mingw64\\bin\\git.exe')).toBe('C:\\Git\\mingw64\\bin\\git.exe');
  });

  test('keeps the launcher without that layout, inside an MSYS shell, and anything that is not a launcher', () => {
    expect(realGitForWindows(LAUNCHER, {}, () => false)).toBe(LAUNCHER);
    expect(realGitForWindows(LAUNCHER, { MSYSTEM: 'MINGW64' }, () => true)).toBe(LAUNCHER);
    expect(realGitForWindows('C:\\scoop\\shims\\git.exe', {}, () => true)).toBe('C:\\scoop\\shims\\git.exe');
    expect(realGitForWindows(REAL, {}, () => true)).toBe(REAL);
  });

  test('looks PATH up once per environment and again once the cached binary is gone', () => {
    let lookups = 0;
    let present = new Set([REAL]);
    const which = (_command: string, path: string | undefined) => { lookups++; expect(path).toBe('C:\\Program Files\\Git\\cmd'); return LAUNCHER; };
    const exists = (path: string) => present.has(path);
    const env = { Path: 'C:\\Program Files\\Git\\cmd' };
    expect(gitLaunch(env, 'win32', which, exists).command).toBe(REAL);
    expect(gitLaunch(env, 'win32', which, exists).command).toBe(REAL);
    expect(lookups).toBe(1);
    present = new Set([OLD_REAL]);
    expect(gitLaunch(env, 'win32', which, exists).command).toBe(OLD_REAL);
    expect(lookups).toBe(2);
  });

  test('a cmd wrapper or nothing on PATH leaves the lookup to the spawn, with long paths still on', () => {
    expect(gitLaunch({ PATH: 'a' }, 'win32', () => 'C:\\tools\\git.cmd', () => true)).toEqual({
      command: 'git', env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' },
    });
    expect(gitLaunch({ PATH: 'b' }, 'win32', () => null, () => true).command).toBe('git');
  });

  test('off Windows git is started as PATH finds it, with nothing added', () => {
    expect(gitLaunch({ PATH: '/usr/bin' }, 'linux', () => { throw new Error('no lookup off Windows'); })).toEqual({ command: 'git', env: {} });
  });
});
