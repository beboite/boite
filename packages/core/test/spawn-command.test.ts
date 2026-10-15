import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SpawnLookup, forgetSpawnCommands, preferGitForWindowsBinary, resolveSpawnCommand, startResolved } from '../src/spawn-command.ts';

/** A Windows machine made of the paths given: `which` answers from `onPath`, a file exists when listed. */
function windowsLookup(onPath: Record<string, string>, files: string[] = []): SpawnLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    windows: true,
    asked,
    which(name, PATH) {
      asked.push(`${name} ${PATH}`);
      return onPath[name] ?? null;
    },
    isFile: (path) => files.includes(path),
  };
}

const LAUNCHER = 'C:\\Program Files\\Git\\cmd\\git.exe';

beforeEach(() => forgetSpawnCommands());
afterEach(() => forgetSpawnCommands());

describe('spawn command resolution', () => {
  test('on Windows a bare name spawns the exe the child PATH finds, and a shim or a path is left to the spawner', () => {
    const lookup = windowsLookup({ gh: 'C:\\Program Files\\GitHub CLI\\gh.exe', npm: 'C:\\nodejs\\npm.cmd', rel: 'tools\\rel.exe' });
    // Windows spells it `Path`; the child's own value is the one looked up.
    expect(resolveSpawnCommand('gh', { Path: 'C:\\Program Files\\GitHub CLI' }, lookup)).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
    expect(lookup.asked).toEqual(['gh C:\\Program Files\\GitHub CLI']);
    // A `.cmd` needs cmd.exe, which Bun and node handle on their own.
    expect(resolveSpawnCommand('npm', {}, lookup)).toBe('npm');
    expect(resolveSpawnCommand('rel', {}, lookup)).toBe('rel');
    expect(resolveSpawnCommand('missing', {}, lookup)).toBe('missing');
    expect(resolveSpawnCommand('C:\\tools\\gh.exe', {}, lookup)).toBe('C:\\tools\\gh.exe');
    expect(resolveSpawnCommand('.\\gh', {}, lookup)).toBe('.\\gh');
    expect(lookup.asked).toHaveLength(4);
  });

  test("git runs the binary Git for Windows' launcher would start, once looked up, and only for that layout", () => {
    const lookup = windowsLookup({ git: 'C:\\Program Files\\Git\\cmd\\git.EXE' }, [
      'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
    ]);
    const isFile = spyOn(lookup, 'isFile');
    expect(resolveSpawnCommand('git', { PATH: 'C:\\Program Files\\Git\\cmd' }, lookup)).toBe('C:\\Program Files\\Git\\ucrt64\\bin\\git.exe');
    const checks = isFile.mock.calls.length;
    expect(resolveSpawnCommand('git', { PATH: 'C:\\Program Files\\Git\\cmd' }, lookup)).toBe('C:\\Program Files\\Git\\ucrt64\\bin\\git.exe');
    expect(isFile.mock.calls.length).toBe(checks);
    // With MSYSTEM set the real binary leaves PATH alone and a `#!/bin/sh` hook could not start.
    expect(resolveSpawnCommand('git', { PATH: 'C:\\Program Files\\Git\\cmd', MSYSTEM: 'MINGW64' }, lookup)).toBe('C:\\Program Files\\Git\\cmd\\git.EXE');

    // Before 2.56, the portable build's bin launcher, and ARM64.
    expect(preferGitForWindowsBinary('D:\\PortableGit\\bin\\git.exe', {}, (path) => path === 'D:\\PortableGit\\mingw64\\bin\\git.exe')).toBe('D:\\PortableGit\\mingw64\\bin\\git.exe');
    expect(preferGitForWindowsBinary(LAUNCHER, {}, (path) => path === 'C:\\Program Files\\Git\\clangarm64\\bin\\git.exe')).toBe('C:\\Program Files\\Git\\clangarm64\\bin\\git.exe');
    // Another layout keeps what PATH found.
    expect(preferGitForWindowsBinary(LAUNCHER, {}, () => false)).toBe(LAUNCHER);
    expect(preferGitForWindowsBinary('C:\\Users\\me\\scoop\\shims\\git.exe', {}, () => true)).toBe('C:\\Users\\me\\scoop\\shims\\git.exe');
    expect(preferGitForWindowsBinary('C:\\Program Files\\Git\\cmd\\gitk.exe', {}, () => true)).toBe('C:\\Program Files\\Git\\cmd\\gitk.exe');
  });

  test.skipIf(process.platform === 'win32')('a bare name is looked up once per child PATH, and a changed PATH looks again', () => {
    const root = mkdtempSync(join(tmpdir(), 'boite-spawn-command-'));
    try {
      const name = 'boite-spawn-command-fixture';
      const dirs = ['a', 'b'].map((dir) => join(root, dir));
      for (const dir of dirs) {
        mkdirSync(dir);
        writeFileSync(join(dir, name), '#!/bin/sh\n');
        chmodSync(join(dir, name), 0o755);
      }
      const which = spyOn(Bun, 'which');
      try {
        expect(resolveSpawnCommand(name, { PATH: dirs[0] })).toBe(join(dirs[0]!, name));
        expect(resolveSpawnCommand(name, { PATH: dirs[0] })).toBe(join(dirs[0]!, name));
        expect(which).toHaveBeenCalledTimes(1);
        expect(resolveSpawnCommand(name, { PATH: dirs[1] })).toBe(join(dirs[1]!, name));
        expect(which).toHaveBeenCalledTimes(2);
      } finally {
        which.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('a resolved program that is gone starts the bare name once and forgets the lookups', () => {
    const root = mkdtempSync(join(tmpdir(), 'boite-spawn-command-'));
    try {
      const name = 'boite-spawn-command-gone';
      writeFileSync(join(root, name), '#!/bin/sh\n');
      chmodSync(join(root, name), 0o755);
      const started: string[] = [];
      const result = startResolved(name, { PATH: root }, (executable) => {
        started.push(executable);
        if (executable !== name) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return 'bare';
      });
      expect(result).toBe('bare');
      expect(started).toEqual([join(root, name), name]);
      // Any other failure is the caller's.
      expect(() => startResolved(name, { PATH: root }, () => { throw new Error('denied'); })).toThrow('denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
