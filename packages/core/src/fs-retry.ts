import { rm } from 'node:fs/promises';

/** The codes a directory still held by an exiting process answers on Windows. */
const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/**
 * Removes a scratch directory, waiting out a process that still holds it.
 * Bun's `rm` ignores `maxRetries` and `retryDelay`, so this loops itself. It
 * never throws: a directory left behind is logged, and must not replace the
 * result of the work that used it.
 */
export async function removeDir(path: string, log?: (message: string) => void, attempts = 20, delayMs = 100): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code) || attempt >= attempts) {
        log?.(`could not remove ${path} (${code || (error instanceof Error ? error.message : String(error))}); it stays behind`);
        return false;
      }
      await Bun.sleep(delayMs);
    }
  }
}
