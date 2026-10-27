import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fdResponse } from '../src/server/file-response.ts';
import { rejection, thrown } from './settle.ts';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'boite-file-response-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

test.each(['before reading', 'after the first chunk'])('a file truncated %s rejects its Response body and closes once', async when => {
  const path = join(directory, 'shrinking.bin');
  const size = 200_000;
  writeFileSync(path, Buffer.alloc(size, 65));
  const handle = await open(path, 'r');
  const close = spyOn(handle, 'close');
  try {
    if (when === 'before reading') truncateSync(path, 3);
    const response = fdResponse(handle, size, null, { 'content-type': 'application/octet-stream' });
    expect(response.headers.get('content-length')).toBe(String(size));
    if (when === 'before reading') {
      expect(await thrown(response.arrayBuffer())).toThrow('unexpected end of file');
    } else {
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.length).toBeGreaterThan(0);
      truncateSync(path, first.value!.length);
      const drain = async () => { while (!(await reader.read()).done) { /* Read through EOF. */ } };
      expect(await thrown(drain())).toThrow('unexpected end of file');
    }
    expect(close).toHaveBeenCalledTimes(1);
    expect((await rejection(handle.stat())).reason).toMatchObject({ code: 'EBADF' });
  } finally {
    close.mockRestore();
    await handle.close();
  }
});

test('intact, ranged, empty, invalid and cancelled file responses close their handle once', async () => {
  for (const mode of ['intact', 'range', 'empty', 'invalid', 'cancel'] as const) {
    const path = join(directory, mode);
    writeFileSync(path, mode === 'empty' ? '' : '0123456789');
    const handle = await open(path, 'r');
    const close = spyOn(handle, 'close');
    try {
      const range = mode === 'range' ? 'bytes=2-4' : mode === 'invalid' ? 'bytes=20-' : null;
      const response = fdResponse(handle, (await handle.stat()).size, range, {});
      if (mode === 'cancel') await response.body!.cancel();
      else if (mode === 'invalid') {
        expect(response.status).toBe(416);
        expect(response.headers.get('content-range')).toBe('bytes */10');
        expect(await response.text()).toBe('range not satisfiable');
      } else {
        expect(response.status).toBe(mode === 'range' ? 206 : 200);
        expect(response.headers.get('content-length')).toBe(mode === 'empty' ? '0' : mode === 'range' ? '3' : '10');
        expect(await response.text()).toBe(mode === 'empty' ? '' : mode === 'range' ? '234' : '0123456789');
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect((await rejection(handle.stat())).reason).toMatchObject({ code: 'EBADF' });
    } finally {
      close.mockRestore();
      await handle.close();
    }
  }
});
