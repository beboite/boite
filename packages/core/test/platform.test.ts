import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.ts';
import { Journal } from '../src/journal.ts';
import { ProcRegistry } from '../src/procs.ts';
import { createPosixPlatform } from '../src/platform/posix.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { waitFor } from './harness.ts';

for (const os of ['linux', 'macos'] as const) {
  describe(`${os} process backend`, () => {
    let directory: string;
    let previousDataDir: string | undefined;
    let journal: Journal;
    let procs: ProcRegistry;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'boite-platform-'));
      previousDataDir = process.env.BOITE_DATA_DIR;
      process.env.BOITE_DATA_DIR = directory;
      journal = new Journal(join(directory, 'journal.db'));
      procs = new ProcRegistry(journal, new Bus(), createPosixPlatform(os));
    });

    afterEach(async () => {
      procs.killAll();
      await waitFor(() => procs.liveCount('one') + procs.liveCount('two') === 0);
      procs.close();
      journal.close();
      if (previousDataDir === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previousDataDir;
      rmSync(directory, { recursive: true, force: true });
    });

    test('unsupported protections remain off when settings enable them', () => {
      procs.applySettings(DEFAULT_SETTINGS);
      expect(procs.capability()).toMatchObject({ os, mode: 'poll' });
      expect(procs.capability().note).toContain('direct children only');
      expect(procs.guardStatus()).toEqual({
        running: false, hook: null, failure: null, audio: 'off', mutedPids: [],
      });
    });

    test('all launch paths journal exits and killing one thread leaves another running', async () => {
      const args = ['-e', 'setTimeout(() => {}, 30000)'];
      const direct = procs.spawn('one', process.execPath, args, { cwd: directory });
      const piped = procs.spawnPiped('one', process.execPath, args, { cwd: directory });
      const node = procs.spawnChild('one', process.execPath, args, { cwd: directory });
      node.on('error', () => {});
      const other = procs.spawn('two', process.execPath, args, { cwd: directory });
      expect(procs.liveCount('one')).toBe(3);
      expect(procs.killTree('one')).toBe(3);
      await waitFor(() => procs.liveCount('one') === 0);
      await Promise.all([direct.exited, piped.exited]);
      const records = journal.listProcesses('one', 10);
      expect(records).toHaveLength(3);
      expect(records.every(record => record.exitedAt !== null)).toBe(true);
      expect(procs.liveOf('two').map(record => record.pid)).toEqual([other.record.pid]);
      expect(procs.guardStatus().running).toBe(false);
      procs.killTree('two');
      await other.exited;
    });
  });
}
