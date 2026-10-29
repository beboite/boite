import * as fs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { InstallManager } from '../src/providers/install.ts';
import { pointCurrent, RELEASE_RECORD } from '../src/providers/install-release.ts';

let dataDir: string;
/** A directory link as the core makes one: a junction on Windows, which needs no privilege. */
const link = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
const agent = (...parts: string[]) => join(dataDir, 'agents', 'managed', ...parts);

/** A release directory holding one file that says which release it is. */
function release(version: string): string {
  const dir = agent('releases', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'which'), version);
  return dir;
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'boite-install-release-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('repointing current', () => {
  // A link (the usual case) and a plain directory (an account that may not make links) both hold the release that worked.
  test.each(['link', 'directory'] as const)('a release that can be neither linked nor moved into place leaves the %s that worked', (kind) => {
    const current = agent('current');
    if (kind === 'link') link(release('1.0.0'), current);
    else { mkdirSync(current, { recursive: true }); writeFileSync(join(current, 'which'), '1.0.0'); }
    const next = release('2.0.0');
    const realRename = fs.renameSync;
    const noLink = spyOn(fs, 'symlinkSync').mockImplementation(() => { throw new Error('links are not allowed here'); });
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === next) throw new Error('the release is in use');
      realRename(from, to);
    });
    try {
      expect(() => pointCurrent('managed', current, next, () => {})).toThrow('the release is in use');
    } finally { noLink.mockRestore(); rename.mockRestore(); }
    expect(readFileSync(join(current, 'which'), 'utf8')).toBe('1.0.0');
    expect(lstatSync(current).isSymbolicLink()).toBe(kind === 'link');
    expect(existsSync(`${current}.previous`)).toBe(false);
  });

  test('an update links the new release and drops the previous link', () => {
    const current = agent('current');
    link(release('1.0.0'), current);
    pointCurrent('managed', current, release('2.0.0'), () => {});
    expect(realpathSync(current)).toBe(realpathSync(agent('releases', '2.0.0')));
    expect(existsSync(`${current}.previous`)).toBe(false);
  });

  test('a repointing a stopped core cut off settles before anything reads current', () => {
    // Stopped after the previous link stepped aside, before the new one was made: it comes back.
    link(release('1.0.0'), agent('current.previous'));
    expect(readFileSync(join(new InstallManager(dataDir).currentDir('managed'), 'which'), 'utf8')).toBe('1.0.0');
    expect(existsSync(agent('current.previous'))).toBe(false);
    // Stopped after the new link was made: the previous one goes.
    rmSync(agent('current'));
    link(release('2.0.0'), agent('current'));
    link(agent('releases', '1.0.0'), agent('current.previous'));
    expect(readFileSync(join(new InstallManager(dataDir).currentDir('managed'), 'which'), 'utf8')).toBe('2.0.0');
    expect(existsSync(agent('current.previous'))).toBe(false);
  });

  test('a current that reaches no complete release gives way to the complete one kept beside it', () => {
    const old = release('1.0.0');
    writeFileSync(join(old, RELEASE_RECORD), '{}');
    link(old, agent('current.previous'));
    // The link to a release whose files are gone.
    link(agent('releases', '2.0.0'), agent('current'));
    expect(readFileSync(join(new InstallManager(dataDir).currentDir('managed'), 'which'), 'utf8')).toBe('1.0.0');
    expect(existsSync(agent('current.previous'))).toBe(false);
  });
});
