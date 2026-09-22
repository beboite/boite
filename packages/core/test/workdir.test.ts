/*
 * The thread's working directory over the wire: one listing, one file as text,
 * one file as a ticket the HTTP route answers, and the editor's save. The data
 * directory is the project here, so every path in this file is inside a
 * temporary directory the harness removes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FILE_MAX_BYTES, FILE_ROUTE, FILE_TICKET_TTL_MS } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { languageOf, mediaOf, writeLandsInside } from '../src/workdir.ts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;
let threadId: string;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
});

afterEach(async () => {
  await harness.stop();
});

/**
 * A file link, or false where the platform will not make one: Windows hands
 * them out to developer mode and administrators only, and says EPERM to the
 * rest. Any other failure is the test's to report, not to skip on.
 */
function linked(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

/** A picture is bytes with a NUL early on: what it holds is not this test's business. */
function picture(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(new ArrayBuffer(512));
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let at = 8; at < data.length; at += 1) data[at] = at % 251;
  data[9] = 0;
  return data;
}

describe('files.list', () => {
  test('directories first, then files, both ignoring case, with paths relative to the working directory', async () => {
    mkdirSync(join(harness.dataDir, 'Zeta'), { recursive: true });
    mkdirSync(join(harness.dataDir, 'alpha', 'nested'), { recursive: true });
    writeFileSync(join(harness.dataDir, 'Beta.txt'), 'b');
    writeFileSync(join(harness.dataDir, 'alpha', 'inside.ts'), 'export const a = 1;\n');

    const root = await client.call('files.list', { threadId });
    const names = root.map((entry) => entry.name);
    expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('Zeta'));
    expect(names.indexOf('Zeta')).toBeLessThan(names.indexOf('Beta.txt'));
    expect(root.find((entry) => entry.name === 'alpha')).toMatchObject({ kind: 'dir', bytes: null, path: 'alpha' });
    expect(root.find((entry) => entry.name === 'Beta.txt')).toMatchObject({ kind: 'file', bytes: 1 });

    const nested = await client.call('files.list', { threadId, path: 'alpha' });
    expect(nested.map((entry) => entry.path)).toEqual(['alpha/nested', 'alpha/inside.ts']);
    expect((nested[1]?.modifiedAt ?? 0) > 0).toBe(true);
  });

  test('a path that escapes the working directory or does not exist is refused by name', async () => {
    const failures: string[] = [];
    const attempts: (() => Promise<unknown>)[] = [
      () => client.call('files.list', { threadId, path: '..' }),
      () => client.call('files.list', { threadId, path: 'nowhere' }),
      () => client.call('files.read', { threadId, path: '../outside.txt' }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        failures.push('none');
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    expect(failures).toEqual([
      "files.list path leaves the thread's working directory: ..",
      'files.list path does not exist: nowhere',
      "files.read path leaves the thread's working directory: ../outside.txt",
    ]);
  });
});

describe('files.read', () => {
  test('text comes inline with the language its extension names', async () => {
    writeFileSync(join(harness.dataDir, 'module.ts'), 'export const answer = 42;\n');
    const content = await client.call('files.read', { threadId, path: 'module.ts' });
    expect(content).toMatchObject({
      kind: 'text',
      path: 'module.ts',
      text: 'export const answer = 42;\n',
      truncated: false,
      language: 'typescript',
    });
    expect(languageOf('a/b/notes.md')).toBe('markdown');
    expect(languageOf('binary.bin')).toBe(null);
    expect(mediaOf('shot.PNG')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(mediaOf('archive.zip')).toEqual({ kind: 'binary', mime: 'application/octet-stream' });
  });

  test('a picture comes as a url the route answers whole, and in ranges so a player can seek', async () => {
    const data = picture();
    writeFileSync(join(harness.dataDir, 'shot.png'), data);
    const content = await client.call('files.read', { threadId, path: 'shot.png' });
    if (content.kind === 'text') throw new Error('a picture must not come back as text');
    expect(content.kind).toBe('image');
    expect(content.mime).toBe('image/png');
    expect(content.bytes).toBe(data.length);
    expect(content.url.startsWith(`${FILE_ROUTE}/`)).toBe(true);
    const address = `${harness.url}${content.url}`;

    const whole = await fetch(address);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('image/png');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('cache-control')).toBe('no-store');
    // Opened as a page, a ticket downloads under its name and is never sniffed into something else.
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
    expect(whole.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''shot.png");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(data);

    const part = await fetch(address, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${data.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.slice(10, 20));

    // The ticket is the whole address: no path reaches the route, and no method but GET.
    const posted = await fetch(address, { method: 'POST' });
    expect(posted.status).toBe(405);
  });

  test('a text file over the cap takes a ticket too, rather than one enormous frame', async () => {
    writeFileSync(join(harness.dataDir, 'huge.log'), 'x'.repeat(FILE_MAX_BYTES + 1));
    const content = await client.call('files.read', { threadId, path: 'huge.log' });
    if (content.kind === 'text') throw new Error('a file over the cap must not come back as text');
    expect(content.kind).toBe('binary');
    expect(content.mime).toBe('application/octet-stream');
    expect(content.bytes).toBe(FILE_MAX_BYTES + 1);
    const served = await fetch(`${harness.url}${content.url}`, { headers: { range: 'bytes=0-4' } });
    expect(served.status).toBe(206);
    expect(await served.text()).toBe('xxxxx');
  });

  test('an unknown or expired ticket is a 404 that says nothing about the file', async () => {
    const stale = harness.core.fileTickets.mint(join(harness.dataDir, 'shot.png'), 'image/png', Date.now() - FILE_TICKET_TTL_MS - 1);
    const expired = await fetch(`${harness.url}${FILE_ROUTE}/${stale}`);
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe('unknown or expired ticket');

    const unknown = await fetch(`${harness.url}${FILE_ROUTE}/not-a-ticket`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain(harness.dataDir);
  });

  test('a ticket stops serving a file after its contents change', async () => {
    const path = join(harness.dataDir, 'changing.bin');
    writeFileSync(path, new Uint8Array([0, 1]));
    const content = await client.call('files.read', { threadId, path: 'changing.bin' });
    if (content.kind === 'text') throw new Error('expected a file ticket');
    writeFileSync(path, new Uint8Array([0, 2, 3]));
    expect((await fetch(`${harness.url}${content.url}`)).status).toBe(404);
  });

  test('a ticket cannot follow a directory replaced with an outside junction', async () => {
    const folder = join(harness.dataDir, 'media');
    const outside = mkdtempSync(join(tmpdir(), 'boite-ticket-outside-'));
    mkdirSync(folder);
    writeFileSync(join(folder, 'asset.bin'), new Uint8Array([0, 1]));
    writeFileSync(join(outside, 'asset.bin'), 'outside data');
    try {
      const content = await client.call('files.read', { threadId, path: 'media/asset.bin' });
      if (content.kind === 'text') throw new Error('expected a file ticket');
      renameSync(folder, join(harness.dataDir, 'original-media'));
      symlinkSync(outside, folder, 'junction');
      expect((await fetch(`${harness.url}${content.url}`)).status).toBe(404);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('files.write', () => {
  test('a new file lands inside the working directory and reads back as text', async () => {
    const written = await client.call('files.write', { threadId, path: 'notes/../saved.md', text: '# saved\n' });
    expect(written.bytes).toBe(8);
    expect(written.modifiedAt > 0).toBe(true);
    const content = await client.call('files.read', { threadId, path: 'saved.md' });
    expect(content).toMatchObject({ kind: 'text', text: '# saved\n', language: 'markdown' });
  });

  test('a directory that is not there and a path that escapes are refused by name', async () => {
    const failures: string[] = [];
    const attempts: (() => Promise<unknown>)[] = [
      () => client.call('files.write', { threadId, path: 'missing/deep/file.txt', text: 'no' }),
      () => client.call('files.write', { threadId, path: '../escaped.txt', text: 'no' }),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        failures.push('none');
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    expect(failures[0]).toContain('files.write path directory does not exist');
    expect(failures[1]).toBe("files.write path leaves the thread's working directory: ../escaped.txt");
  });

  test('a link that points out of the working directory is not written through', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'boite-outside-'));
    try {
      const target = join(outside, 'theirs.txt');
      writeFileSync(target, 'untouched');
      // Where no link can be made, the Linux and macOS runs are the ones that prove this.
      if (!linked(target, join(harness.dataDir, 'link.txt'))) return;
      let message = 'none';
      try {
        await client.call('files.write', { threadId, path: 'link.txt', text: 'overwritten' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("files.write path leaves the thread's working directory: link.txt");
      expect(readFileSync(target, 'utf8')).toBe('untouched');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a link to nothing is not written through either: the write would create its target', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'boite-outside-'));
    try {
      const target = join(outside, 'not-there.txt');
      if (!linked(target, join(harness.dataDir, 'dangling.txt'))) return;
      let message = 'none';
      try {
        await client.call('files.write', { threadId, path: 'dangling.txt', text: 'created outside' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe('files.write path is a link to nothing: dangling.txt');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writeLandsInside', () => {
  test('a new file is judged by its nearest existing parent, with every link followed', () => {
    const root = harness.dataDir;
    const outside = mkdtempSync(join(tmpdir(), 'boite-outside-'));
    try {
      mkdirSync(join(root, 'real'), { recursive: true });
      // Junctions need no privilege on Windows and read as directory links elsewhere.
      symlinkSync(outside, join(root, 'out'), 'junction');
      symlinkSync(join(root, 'real'), join(root, 'in'), 'junction');
      expect(writeLandsInside(root, 'notes.md')).toBe(true);
      expect(writeLandsInside(root, 'deep/new/notes.md')).toBe(true);
      expect(writeLandsInside(root, 'in/notes.md')).toBe(true);
      expect(writeLandsInside(root, '../notes.md')).toBe(false);
      expect(writeLandsInside(root, join(outside, 'notes.md'))).toBe(false);
      expect(writeLandsInside(root, 'out/notes.md')).toBe(false);
      expect(writeLandsInside(root, 'out/deep/new/notes.md')).toBe(false);
      if (linked(join(outside, 'not-there.txt'), join(root, 'dangling.txt'))) {
        expect(writeLandsInside(root, 'dangling.txt')).toBe(false);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
