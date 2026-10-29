/*
 * The thread's working directory over the wire: one listing, one file as text,
 * one file as a ticket the HTTP route answers, and the editor's save. The data
 * directory is the project here, so every path in this file is inside a
 * temporary directory the harness removes.
 */

import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { FILE_MAX_BYTES, FILE_ROUTE, FILE_TICKET_TTL_MS } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { createExclusiveFile, languageOf, mediaOf, openHeldDirectory, writeLandsInside } from '../src/workdir.ts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { rejection, thrown } from './settle.ts';

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
    writeFileSync(join(harness.dataDir, 'shot.png'), picture());
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

  test('a ticket keeps the opened file when its directory is swapped before the path is sampled again', async () => {
    const folder = join(harness.dataDir, 'media');
    const outside = mkdtempSync(join(tmpdir(), 'boite-ticket-mint-'));
    const tickets = harness.core.fileTickets;
    const original = tickets.mint.bind(tickets);
    mkdirSync(folder);
    writeFileSync(join(folder, 'asset.bin'), new Uint8Array([0, 1]));
    writeFileSync(join(outside, 'asset.bin'), 'outside data');
    tickets.mint = (path, mime, now, name, identity) => {
      renameSync(folder, join(harness.dataDir, 'original-media'));
      symlinkSync(outside, folder, 'junction');
      return original(path, mime, now, name, identity);
    };
    try {
      const content = await client.call('files.read', { threadId, path: 'media/asset.bin' });
      if (content.kind === 'text') throw new Error('expected a file ticket');
      expect((await fetch(`${harness.url}${content.url}`)).status).toBe(404);
      expect(readFileSync(join(outside, 'asset.bin'), 'utf8')).toBe('outside data');
    } finally {
      tickets.mint = original;
      rmSync(folder, { recursive: true, force: true });
      rmSync(join(harness.dataDir, 'original-media'), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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

  test('revoking a session drops every ticket, and archiving drops the ones under that directory', async () => {
    writeFileSync(join(harness.dataDir, 'shot.png'), picture());
    const first = await client.call('files.read', { threadId, path: 'shot.png' });
    if (first.kind === 'text') throw new Error('expected a file ticket');
    const { grant } = await client.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'phone', version: 'test' } });
    try {
      const sessions = await client.call('sessions.list', {});
      const paired = sessions.find((session) => session.client.name === 'phone');
      if (paired === undefined) throw new Error('paired phone missing');
      await client.call('sessions.revoke', { sessionId: paired.id });
    } finally {
      phone.close();
    }
    expect((await fetch(`${harness.url}${first.url}`)).status).toBe(404);

    const second = await client.call('files.read', { threadId, path: 'shot.png' });
    if (second.kind === 'text') throw new Error('expected a file ticket');
    await client.call('threads.archive', { threadId });
    expect((await fetch(`${harness.url}${second.url}`)).status).toBe(404);
  });

  test('a file link inside the working directory reads the file it names', async () => {
    writeFileSync(join(harness.dataDir, 'real.txt'), 'target text\n');
    if (!linked(join(harness.dataDir, 'real.txt'), join(harness.dataDir, 'link.txt'))) return;
    const content = await client.call('files.read', { threadId, path: 'link.txt' });
    expect(content).toMatchObject({ kind: 'text', path: 'link.txt', text: 'target text\n' });
  });
});

describe('byte tickets', () => {
  test('a ticket in use stays alive, and dies ten minutes after its last read', () => {
    const tickets = harness.core.fileTickets;
    const ticket = tickets.mintBytes('picture', () => ({ data: new Uint8Array([1]), mime: 'image/webp' }), 0);
    // Read before each expiry, it keeps the same address well past the first ten minutes.
    for (const at of [1, 2, 3]) expect(tickets.bytes(ticket, at * (FILE_TICKET_TTL_MS - 1))).not.toBeNull();
    expect(tickets.bytes(ticket, 4 * FILE_TICKET_TTL_MS)).toBeNull();
  });
});

describe('download responses', () => {
  test.each(['disk', 'bytes'])('%s tickets encode filename attributes, including ranged downloads', async kind => {
    const path = join(harness.dataDir, 'download.bin');
    const data = Buffer.from('0123456789');
    writeFileSync(path, data);
    for (const [name, encoded] of [["a'b(c)*.txt", 'a%27b%28c%29%2A.txt'], ['café!.txt', 'caf%C3%A9!.txt']]) {
      const ticket = kind === 'disk'
        ? harness.core.fileTickets.mint(path, 'application/octet-stream', Date.now(), name)
        : harness.core.fileTickets.mintBytes(name!, () => ({ data, mime: 'application/octet-stream', name }));
      for (const range of [null, 'bytes=2-4']) {
        const response = await fetch(`${harness.url}${FILE_ROUTE}/${ticket}`, { headers: range ? { range } : {} });
        expect(response.status).toBe(range ? 206 : 200);
        expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encoded}`);
        expect(await response.text()).toBe(range ? '234' : '0123456789');
      }
    }
  });

  test('HTTP rejects a ticket body truncated after its handle was checked', async () => {
    const path = join(harness.dataDir, 'shrinking.bin');
    writeFileSync(path, Buffer.alloc(200_000, 65));
    const tickets = harness.core.fileTickets;
    const ticket = tickets.mint(path, 'application/octet-stream');
    const original = tickets.open.bind(tickets);
    const opened: fsPromises.FileHandle[] = [];
    let resume!: () => void;
    const receiving = new Promise<void>(resolve => { resume = resolve; });
    tickets.open = async (asked, now) => {
      const result = await original(asked, now);
      if (asked === ticket && result) {
        opened.push(result.handle);
        const read = result.handle.read.bind(result.handle);
        result.handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (position > 0) await receiving;
          return read(buffer, offset, length, position);
        }) as typeof result.handle.read;
      }
      return result;
    };
    try {
      const response = await fetch(`${harness.url}${FILE_ROUTE}/${ticket}`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      truncateSync(path, 100_000);
      resume();
      const drain = async () => { while (!(await reader.read()).done) { /* Read through the transport failure. */ } };
      const { reason } = await rejection(drain());
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).name).not.toBe('TimeoutError');
      expect(opened).toHaveLength(1);
      expect((await rejection(opened[0]!.stat())).reason).toMatchObject({ code: 'EBADF' });
    } finally {
      resume();
      tickets.open = original;
      await Promise.all(opened.map(handle => handle.close()));
    }
  });

  (process.platform === 'win32' ? test.skip : test).each(['file', 'gzip'])('a %s ticket rejects a FIFO without waiting for a writer', async kind => {
    const path = join(harness.dataDir, 'page.html');
    const page = '<!doctype html><p>synthetic view</p>';
    writeFileSync(path, page);
    const copy = path + '.gz';
    writeFileSync(copy, Bun.gzipSync(Buffer.from(page)));
    const tickets = harness.core.fileTickets;
    const ticket = tickets.mint(path, 'text/html', Date.now(), 'page.html', undefined, kind === 'gzip');
    const url = `${harness.url}/${kind === 'gzip' ? 'view' : 'file'}/${ticket}`;
    const request = () => fetch(url, { headers: { 'accept-encoding': 'gzip' }, decompress: false });
    const normal = await request();
    expect(normal.status).toBe(200);
    expect(kind === 'gzip' ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await normal.arrayBuffer()))) : await normal.text()).toBe(page);

    const target = kind === 'gzip' ? copy : path;
    rmSync(target);
    execFileSync('mkfifo', [target]);
    const open = spyOn(fsPromises, 'open');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = request();
    let writer: number | undefined;
    try {
      const response = await Promise.race([
        pending,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
      ]);
      // A failing implementation must still release its blocked open and close the returned handles.
      if (response === null) writer = openSync(target, constants.O_RDWR | constants.O_NONBLOCK);
      const settled = response ?? await pending;
      expect(settled.status).toBe(kind === 'gzip' ? 200 : 404);
      expect(await settled.text()).toBe(kind === 'gzip' ? page : 'unknown or expired ticket');
      const handles = await Promise.all(open.mock.results.flatMap((result, index) =>
        open.mock.calls[index]?.[0] === target && result.type === 'return' ? [result.value] : []));
      expect(handles).toHaveLength(1);
      for (const handle of handles) expect((await rejection(handle.stat())).reason).toMatchObject({ code: 'EBADF' });
      expect(response).not.toBeNull();
      if (kind === 'file') expect(tickets.resolve(ticket)).toBeNull();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (writer !== undefined) closeSync(writer);
      open.mockRestore();
    }
  });

  (process.platform === 'win32' ? test.skip : test)('a gzip view copy replaced with a link falls back to the original page', async () => {
    const path = join(harness.dataDir, 'page.html');
    writeFileSync(path, '<p>original</p>');
    const other = join(harness.dataDir, 'other.gz');
    writeFileSync(other, Bun.gzipSync(Buffer.from('<p>other</p>')));
    if (!linked(other, path + '.gz')) return;
    const ticket = harness.core.fileTickets.mint(path, 'text/html', Date.now(), 'page.html', undefined, true);
    const response = await fetch(`${harness.url}/view/${ticket}`, { headers: { 'accept-encoding': 'gzip' } });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('<p>original</p>');
  });
});

describe('files.locate', () => {
  test('answers a chat link with the file its tail names under the thread', async () => {
    mkdirSync(join(harness.dataDir, 'notes', '.local'), { recursive: true });
    writeFileSync(join(harness.dataDir, 'notes', '.local', 'core-rules.md'), '# rules');
    expect(await client.call('files.locate', { threadId, path: 'core-rules.md' })).toEqual(['notes/.local/core-rules.md']);
    expect(await thrown(client.call('files.locate', { threadId, path: '' }))).toThrow('files.locate path: expected a file path');
  });
});

describe('files.write', () => {
  test('an existing file is replaced and the previous tail is not left behind', async () => {
    writeFileSync(join(harness.dataDir, 'note.txt'), 'ORIGINAL-CONTENT');
    const written = await client.call('files.write', { threadId, path: 'note.txt', text: 'SHORT\n' });
    expect(written.bytes).toBe(6);
    expect(readFileSync(join(harness.dataDir, 'note.txt'), 'utf8')).toBe('SHORT\n');
  });

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

  test('a new file stays on the held directory inode when that directory is renamed onto an outside link', async () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'boite-held-'));
    const parent = join(root, 'sub');
    const moved = join(root, 'sub-real');
    const outside = mkdtempSync(join(tmpdir(), 'boite-held-out-'));
    mkdirSync(parent);
    const stats = statSync(parent, { bigint: true });
    const dir = await openHeldDirectory(parent, stats.dev, stats.ino, 'files.write path directory', 'sub');
    try {
      renameSync(parent, moved);
      symlinkSync(outside, parent, 'junction');
      const handle = await createExclusiveFile(dir, 'note.txt', join(parent, 'note.txt'));
      try {
        await handle.write(Buffer.from('inside-inode\n'));
      } finally {
        await handle.close();
      }
      expect(readFileSync(join(moved, 'note.txt'), 'utf8')).toBe('inside-inode\n');
      expect(existsSync(join(outside, 'note.txt'))).toBe(false);
    } finally {
      await dir.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a directory junction inside the working directory is where the new file lands', async () => {
    const real = join(harness.dataDir, 'realdir');
    mkdirSync(real);
    symlinkSync(real, join(harness.dataDir, 'junction'), 'junction');
    const written = await client.call('files.write', { threadId, path: 'junction/note.txt', text: 'landed\n' });
    expect(written.bytes).toBe(7);
    expect(readFileSync(join(real, 'note.txt'), 'utf8')).toBe('landed\n');
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

  test('a file its owner may not read lies where its parent resolves, a link that cannot be resolved stays refused', () => {
    const root = harness.dataDir;
    writeFileSync(join(root, 'locked.txt'), 'x');
    const outside = mkdtempSync(join(tmpdir(), 'boite-outside-'));
    const linkMade = linked(join(outside, 'secret.txt'), join(root, 'locked-link.txt'));
    // Bun on macOS opens a path to resolve it, so mode 000 answers EACCES there.
    const real = fs.realpathSync;
    const spy = spyOn(fs, 'realpathSync').mockImplementation(((path: string, options?: unknown) => {
      if (String(path).includes('locked')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return real(path, options as never);
    }) as typeof fs.realpathSync);
    try {
      expect(writeLandsInside(root, 'locked.txt')).toBe(true);
      if (linkMade) expect(writeLandsInside(root, 'locked-link.txt')).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
