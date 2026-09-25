import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId, ProviderInstall, ProviderInstallState } from '@boite/contracts';
import { refused, unavailable } from '../errors.ts';

/** How often a download reports itself while it runs. */
const PROGRESS_INTERVAL_MS = 250;

/** A download that receives nothing for this long is dropped and tried again from where it stopped. */
export const IDLE_TIMEOUT_MS = 30_000;

/** The wait before each new attempt after a dropped connection: five retries, then the install fails and keeps what it has. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

/** Written beside a `.part`, so a later install knows the bytes it holds belong to the same archive. */
interface PartRecord {
  url: string;
  sha256: string;
  /** The server's strong ETag or Last-Modified, sent back as `If-Range`; null when it gave neither. */
  validator: string | null;
}

/** The bytes a download holds so far and their running digest. */
interface Progress {
  received: number;
  hasher: Bun.CryptoHasher;
  /** What the server said identifies the file, sent back as `If-Range` by the next attempt. */
  validator: string | null;
}

/**
 * One download as the install manager hands it over: the archive, the `.part`
 * it lands in, the run's own signal (a cancel or a core stop), and the manager's
 * state and log to report through.
 */
export interface DownloadRun {
  providerId: ProviderId;
  install: ProviderInstall;
  operationId: string;
  signal: AbortSignal;
  part: string;
  idleTimeoutMs: number;
  retryDelaysMs: readonly number[];
  move(state: ProviderInstallState): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/** One attempt lost its connection, stalled or met a server error that may pass: the download tries again. */
class Retryable extends Error {}

/** Every retry failed. The `.part` stays, so installing again resumes where this stopped. */
export class Dropped extends Error {}

export function humanMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function partRecordFile(part: string): string {
  return `${part}.json`;
}

function readPartRecord(part: string): PartRecord | null {
  try {
    const raw = JSON.parse(readFileSync(partRecordFile(part), 'utf8')) as Partial<PartRecord>;
    if (typeof raw.url !== 'string' || typeof raw.sha256 !== 'string') return null;
    return { url: raw.url, sha256: raw.sha256, validator: typeof raw.validator === 'string' ? raw.validator : null };
  } catch {
    return null;
  }
}

/** The bytes a `.part` of this exact archive already holds, zero when there is none or it belongs to another. */
export function resumableBytes(part: string, install: ProviderInstall): number {
  const record = readPartRecord(part);
  if (record === null || record.url !== install.url || record.sha256.toLowerCase() !== install.sha256.toLowerCase()) return 0;
  try {
    const size = statSync(part).size;
    return size <= install.archiveBytes ? size : 0;
  } catch {
    return 0;
  }
}

export function dropPart(part: string): void {
  rmSync(part, { force: true });
  rmSync(partRecordFile(part), { force: true });
}

/**
 * The archive into its `.part`, resumed from what an earlier attempt left,
 * retried while the connection keeps dropping, then checked against the
 * descriptor's length and sha256.
 */
export async function downloadArchive(run: DownloadRun): Promise<void> {
  const { providerId, install, part, signal } = run;
  mkdirSync(dirname(part), { recursive: true });
  const progress: Progress = { received: 0, hasher: new Bun.CryptoHasher('sha256'), validator: null };
  if (resumableBytes(part, install) > 0) {
    progress.validator = readPartRecord(part)?.validator ?? null;
    for await (const chunk of Bun.file(part).stream()) {
      if (signal.aborted) throw signal.reason;
      progress.hasher.update(chunk);
      progress.received += chunk.byteLength;
    }
    run.log('info', `resuming the download of ${providerId} at ${humanMegabytes(progress.received)} of ${humanMegabytes(install.archiveBytes)}`);
  } else {
    dropPart(part);
  }
  report(run, progress);

  let retries = 0;
  while (progress.received < install.archiveBytes) {
    try {
      await downloadAttempt(run, progress);
      break;
    } catch (error) {
      if (!(error instanceof Retryable)) throw error;
      const delay = run.retryDelaysMs[retries];
      const at = `${humanMegabytes(progress.received)} of ${humanMegabytes(install.archiveBytes)}`;
      if (delay === undefined) {
        throw new Dropped(`${error.message} at ${at}, and ${retries} retr${retries === 1 ? 'y' : 'ies'} did not get past it; install again to resume`);
      }
      retries += 1;
      run.log('warn', `downloading ${providerId}: ${error.message} at ${at}, retrying (${retries}/${run.retryDelaysMs.length})`);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, delay);
        signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      });
      if (signal.aborted) throw signal.reason;
    }
  }

  run.move({
    state: 'verifying',
    version: install.version,
    operationId: run.operationId,
  });

  if (progress.received !== install.archiveBytes) {
    throw refused(
      `${install.url} is ${progress.received} bytes, the descriptor expected ${install.archiveBytes}`,
      { providerId, url: install.url, expectedBytes: install.archiveBytes, actualBytes: progress.received },
    );
  }
  const digest = progress.hasher.digest('hex');
  if (digest !== install.sha256.toLowerCase()) {
    throw refused(
      `${install.url} hashes to ${digest}, the descriptor expected ${install.sha256.toLowerCase()}`,
      { providerId, url: install.url, expectedSha256: install.sha256.toLowerCase(), actualSha256: digest },
    );
  }
}

/** One request, appended to `progress`. Throws `Retryable` for what another attempt may get past. */
async function downloadAttempt(run: DownloadRun, progress: Progress): Promise<void> {
  const { providerId, install, part } = run;
  const attempt = new AbortController();
  const signal = AbortSignal.any([run.signal, attempt.signal]);
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; attempt.abort(); }, run.idleTimeoutMs);
  };
  // What the network threw, in words: the user's cancel stays a cancel, the
  // rest is worth another attempt. Bun's own text asks for `verbose: true`.
  const lost = (error: unknown): Error => {
    if (run.signal.aborted) return run.signal.reason as Error;
    if (stalled) return new Retryable(`no data for ${Math.round(run.idleTimeoutMs / 1000)} s`);
    return new Retryable(`the connection dropped (${error instanceof Error ? error.name : 'error'})`);
  };

  let handle: number | null = null;
  arm();
  try {
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (progress.received > 0) {
      headers['range'] = `bytes=${progress.received}-`;
      if (progress.validator !== null) headers['if-range'] = progress.validator;
    }
    let response: Response;
    try {
      response = await fetch(install.url, { signal, headers });
    } catch (error) {
      throw lost(error);
    }
    const status = response.status;
    if (status === 408 || status === 429 || status >= 500) {
      throw new Retryable(`the server answered ${status} ${response.statusText}`.trim());
    }
    if (status === 206) {
      const start = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1];
      if (start === undefined || Number(start) !== progress.received) {
        // A range the download did not ask for: the next attempt takes the whole file.
        restart(part, progress);
        throw new Retryable(`the server resumed at byte ${start ?? 'unknown'} instead of ${progress.received}`);
      }
    } else if (status === 200) {
      // The whole file: a server that does not resume, or a file that changed.
      if (progress.received > 0) restart(part, progress);
    } else {
      throw unavailable(`${install.url} answered ${status} ${response.statusText}`.trim(), {
        providerId,
        url: install.url,
        status,
      });
    }
    if (response.body === null) {
      throw unavailable(`${install.url} answered ${status} with no body`, { providerId, url: install.url, status });
    }
    const length = response.headers.get('content-length');
    if (length !== null && response.headers.get('content-encoding') === null) {
      const total = progress.received + Number(length);
      if (total !== install.archiveBytes) {
        throw refused(`${install.url} is ${total} bytes, the descriptor expected ${install.archiveBytes}`, {
          providerId, url: install.url, expectedBytes: install.archiveBytes, actualBytes: total,
        });
      }
    }
    const etag = response.headers.get('etag');
    // `If-Range` takes a strong ETag or a date; a weak one would never match.
    progress.validator = etag !== null && !etag.startsWith('W/')
      ? etag
      : (response.headers.get('last-modified') ?? (status === 206 ? progress.validator : null));
    const record: PartRecord = { url: install.url, sha256: install.sha256, validator: progress.validator };
    writeFileSync(partRecordFile(part), `${JSON.stringify(record)}\n`);

    handle = openSync(part, progress.received > 0 ? 'a' : 'w');
    const reader = response.body.getReader();
    let lastReport = 0;
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        throw lost(error);
      }
      // An abort does not always reach a body that already has data waiting.
      if (signal.aborted) throw lost(null);
      if (read.done) break;
      arm();
      const chunk = read.value;
      if (progress.received + chunk.byteLength > install.archiveBytes) {
        throw refused(`${install.url} sent more than the ${install.archiveBytes} bytes the descriptor expected`, {
          providerId, url: install.url, expectedBytes: install.archiveBytes,
        });
      }
      progress.hasher.update(chunk);
      writeSync(handle, chunk);
      progress.received += chunk.byteLength;
      const now = Date.now();
      if (now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        report(run, progress);
      }
    }
    if (run.signal.aborted) throw run.signal.reason;
  } finally {
    clearTimeout(timer);
    if (handle !== null) closeSync(handle);
    attempt.abort();
  }
}

/** Throws away what a download held, for a server that answers with the whole file again. */
function restart(part: string, progress: Progress): void {
  rmSync(part, { force: true });
  progress.received = 0;
  progress.hasher = new Bun.CryptoHasher('sha256');
}

function report(run: DownloadRun, progress: Progress): void {
  run.move({
    state: 'downloading',
    version: run.install.version,
    receivedBytes: progress.received,
    totalBytes: run.install.archiveBytes,
    operationId: run.operationId,
  });
}
