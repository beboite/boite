import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { recoverActivation, switchRelease } from '../src/plugins/activation.ts';

let dir: string;
const BINARY = 'agent';
const record = (version: string) => JSON.stringify({ version });

/** Which release the binary is, and which one the record names: one whole release when they agree. */
function installed(): { binary: string; record: string } {
  return { binary: readFileSync(join(dir, BINARY), 'utf8'), record: (JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as { version: string }).version };
}

function update(version: string) {
  const temporary = join(dir, `${BINARY}.download`);
  writeFileSync(temporary, version);
  return switchRelease(dir, { previous: join(dir, BINARY), binary: join(dir, BINARY), temporary, record: record(version) });
}

/** A binary a process still runs: Windows refuses to remove it, here for as long as the test holds it. */
function lockBackups(): { mockRestore(): void } {
  const realRm = fs.rmSync;
  return spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.previous') && existsSync(path)) throw new Error('EBUSY: resource busy or locked');
    realRm(path, options);
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-activation-'));
  writeFileSync(join(dir, BINARY), 'v1');
  writeFileSync(join(dir, 'installed.json'), record('v1'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a backup belongs to the activation that made it', () => {
  test('the next update after one whose backup stayed locked installs whole, and never brings the older binary back', () => {
    const locked = lockBackups();
    try {
      update('v2').commit();
      recoverActivation(dir);
      expect(installed()).toEqual({ binary: 'v2', record: 'v2' });
      // Before, the update reused the backup v2 left and put v1 back under the v2 record.
      try { update('v3').commit(); } catch { /* asserted below */ }
      expect(installed()).toEqual({ binary: 'v3', record: 'v3' });
    } finally { locked.mockRestore(); }
    // Once nothing holds them, a read clears every backup the committed activations left.
    recoverActivation(dir);
    expect(readdirSync(dir).sort()).toEqual(['agent', 'installed.json']);
  });

  test('a core stopped while staging the next update, after a locked backup, restarts on the release that committed', () => {
    const locked = lockBackups();
    const realOpen = fs.openSync;
    let armed = false;
    // Stopped once the next record is staged, before its intent is written.
    const open = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const path = args[0];
      if (armed && String(path).endsWith('activation.json') && existsSync(join(dir, 'installed.json.part'))) throw new Error('the core stopped');
      return realOpen(...args);
    });
    try {
      update('v2').commit();
      armed = true;
      expect(() => update('v3')).toThrow('the core stopped');
    } finally { open.mockRestore(); locked.mockRestore(); }
    recoverActivation(dir);
    expect(installed()).toEqual({ binary: 'v2', record: 'v2' });
  });

  test('a rollback whose backup cannot move back leaves the new binary rather than none', () => {
    const realRename = fs.renameSync;
    let backup: string | null = null;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('.previous')) backup = String(to);
      else if (from === backup) throw new Error('EBUSY: resource busy or locked');
      realRename(from, to);
    });
    try {
      const activation = update('v2');
      expect(() => activation.rollback()).toThrow('EBUSY');
    } finally { rename.mockRestore(); }
    expect(readFileSync(join(dir, BINARY), 'utf8')).toBe('v2');
    // The intent stays, so the next read puts the previous release back.
    expect(recoverActivation(dir)).toBe('restored');
    expect(installed()).toEqual({ binary: 'v1', record: 'v1' });
  });
});
