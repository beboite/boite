import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from '@boite/contracts';
import { fileReference } from '../src/attachments.ts';
import { publishArtifact } from '../src/artifacts.ts';
import { takeLock } from '../src/data-lock.ts';
import { InstallManager } from '../src/providers/install.ts';
import { RELEASE_RECORD } from '../src/providers/install-release.ts';
import { openDataDir } from '../src/server-update/restore.ts';
import { buildView } from '../src/views.ts';
import { existingInside, openChecked } from '../src/workdir.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { thrown } from './settle.ts';

/*
 * Two files whose NTFS ids are one apart, past 2^53, as a Windows runner
 * reported them (job 118081174911): read as numbers they are one id. Each
 * check that a file is still the one it saw must read them exact.
 */
const [A, B] = [0x96000000006f38n, 0x96000000006f39n];

/** The stats with `ino` read as `id`: exact for a bigint call, rounded for a number one, as NTFS ids are. */
function withId<S extends object>(stats: S, id: bigint): S {
  return new Proxy(stats, {
    get(target, key) {
      if (key === 'ino') return typeof (target as { ino: unknown }).ino === 'bigint' ? id : Number(id);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const real = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, open: fsp.open };
const restores: Array<() => void> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = () => { const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'boite-ntfs-'))); dirs.push(dir); return dir; };

/** `statSync` (or `lstatSync`) reads `idOf(path)` for the paths it names, the real id elsewhere. */
function stats(name: 'statSync' | 'lstatSync', idOf: (path: string) => bigint | undefined) {
  const call = real[name] as (path: fs.PathLike, options?: object) => fs.Stats | fs.BigIntStats | undefined;
  const spy = spyOn(fs, name).mockImplementation(((path: fs.PathLike, options?: object) => {
    const found = call(path, options);
    const id = idOf(String(path));
    return found === undefined || id === undefined ? found : withId(found, id);
  }) as never);
  restores.push(() => spy.mockRestore());
}

/** Every file handle opened from now on reads `id` for itself. */
function handlesRead(id: bigint) {
  const spy = spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await real.open(...args);
    const stat = handle.stat.bind(handle) as (options?: object) => Promise<object>;
    (handle as { stat: unknown }).stat = async (options?: object) => withId(await stat(options), id);
    return handle;
  }) as never);
  restores.push(() => spy.mockRestore());
}

test('a lock released after another core took its path leaves that core\'s lock', () => {
  const file = join(scratch(), 'core.lock');
  const fstat = spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: object) => withId(real.fstatSync(fd, options as never), A)) as never);
  restores.push(() => fstat.mockRestore());
  let replaced = false;
  stats('statSync', path => path === file ? (replaced ? B : A) : undefined);
  const release = takeLock(file, () => 'busy');
  // The directory moved away and another core took its path: a new file there.
  replaced = true;
  fs.rmSync(file);
  fs.writeFileSync(file, '{"pid":1}');
  release();
  expect(fs.readFileSync(file, 'utf8')).toBe('{"pid":1}');
});

test('a data directory replaced while its lock was taken is not the one locked', () => {
  const data = join(scratch(), 'data');
  let seen = 0;
  // Before each lock it reads one directory, after it another.
  stats('statSync', path => path === data ? [A, B][seen++ % 2] : undefined);
  let locked = 0, released = 0;
  const release = openDataDir(data, dir => fs.mkdirSync(dir, { recursive: true }), () => () => {}, () => { locked++; return () => { released++; }; });
  release();
  // Three starts let go of a lock on a directory no longer at the path; the fourth runs under maintenance.
  expect([locked, released]).toEqual([4, 4]);
});

test('a release record replaced by one of the same size and time is read again', () => {
  const installs = new InstallManager(scratch());
  const current = installs.currentDir('claude' as ProviderId);
  fs.mkdirSync(current, { recursive: true });
  const record = join(current, RELEASE_RECORD);
  const at = new Date(1_700_000_000_000);
  const write = (version: string) => {
    fs.writeFileSync(record, JSON.stringify({ version, files: [], installedAt: 1 }));
    fs.utimesSync(record, at, at);
  };
  let id = A;
  stats('statSync', path => path === record ? id : undefined);
  write('1.0.0');
  expect(installs.installedVersion('claude' as ProviderId)).toBe('1.0.0');
  write('2.0.0');
  id = B;
  expect(installs.installedVersion('claude' as ProviderId)).toBe('2.0.0');
});

test('an uploaded copy an agent replaced with bytes of the same size and time is not sent again as the upload', () => {
  const dataDir = scratch();
  const upload = { type: 'file' as const, name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('original').toString('base64') };
  let id = A;
  let copy = '';
  stats('lstatSync', path => path === copy ? id : undefined);
  copy = (JSON.parse(fileReference(dataDir, upload)) as { path: string }).path;
  // A whole second, so the time written back below is the same to the nanosecond.
  const at = new Date(1_700_000_000_000);
  fs.utimesSync(copy, at, at);
  expect((JSON.parse(fileReference(dataDir, upload)) as { path: string }).path).toBe(copy);
  // The agent writes other bytes of the same length into a new file at that name.
  fs.rmSync(copy);
  fs.writeFileSync(copy, 'edited!!');
  fs.utimesSync(copy, at, at);
  id = B;
  const again = (JSON.parse(fileReference(dataDir, upload)) as { path: string }).path;
  expect(again).not.toBe(copy);
  expect(fs.readFileSync(again, 'utf8')).toBe('original');
});

test('a work file swapped for another between its check and its opening is refused', async () => {
  const cwd = scratch();
  fs.writeFileSync(join(cwd, 'a.txt'), 'checked');
  stats('statSync', path => path === join(cwd, 'a.txt') ? A : undefined);
  handlesRead(B);
  const found = existingInside(cwd, 'a.txt', 'file', 'files.read path');
  expect(await thrown(openChecked(found.real, fs.constants.O_RDONLY, found.stats.dev, found.stats.ino, 'files.read path', 'a.txt')))
    .toThrow('files.read path changed while it was opened');
});

test('a file a view embeds, swapped for another as it is opened, is not embedded', () => {
  const cwd = scratch();
  fs.writeFileSync(join(cwd, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  stats('statSync', path => path === join(cwd, 'logo.png') ? A : undefined);
  const fstat = spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: object) => withId(real.fstatSync(fd, options as never), B)) as never);
  restores.push(() => fstat.mockRestore());
  const view = buildView('<img src="logo.png">', cwd, cwd);
  expect(view.problems.join('\n')).toContain('changed while it was opened');
});

test('a file swapped for another as it is published is refused', async () => {
  const harness = await startTestCore();
  try {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('turns.start', { threadId, prompt: 'Prepare a deliverable' });
    await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
    const cwd = harness.core.threads.require(threadId).cwd;
    const path = join(fs.realpathSync(cwd), 'report.pdf');
    fs.writeFileSync(path, '%PDF-1.4\nreport');
    stats('statSync', named => named === path ? A : undefined);
    handlesRead(B);
    expect(await thrown(publishArtifact(harness.core, { threadId, path: 'report.pdf' }))).toThrow('artifacts.publish path changed while opening');
  } finally { await harness.stop(); }
});
