import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeSync, renameSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { freeBytesAt } from './providers/install.ts';

const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  bytes: 190085487,
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
};
const RUNTIME = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
  bytes: 8194445,
  sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
};

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/** Written beside a `.part`, so a later download resumes only bytes of the same file. */
interface PartRecord {
  url: string;
  sha256: string;
  /** The server's strong ETag or Last-Modified, sent back as `If-Range`; null when it gave neither. */
  validator: string | null;
}

function readPartRecord(part: string): PartRecord | null {
  try {
    const raw = JSON.parse(readFileSync(`${part}.json`, 'utf8')) as Partial<PartRecord>;
    if (typeof raw.url !== 'string' || typeof raw.sha256 !== 'string') return null;
    return { url: raw.url, sha256: raw.sha256, validator: typeof raw.validator === 'string' ? raw.validator : null };
  } catch {
    return null;
  }
}

function dropPart(part: string): void {
  rmSync(part, { force: true });
  rmSync(`${part}.json`, { force: true });
}

export class SpeechLocal {
  readonly root: string;
  installing = false;
  downloadedBytes = 0;
  totalBytes = 0;
  error: string | null = null;
  /** How long a download may receive nothing before it gives up and keeps its bytes. A test seam. */
  stallMs = 60_000;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  readonly canInstallRuntime = process.platform === 'win32' && process.arch === 'x64';

  constructor(dataDir: string) {
    this.root = join(dataDir, 'speech');
    // Remove only our transient audio directories left by a hard-killed core.
    if (existsSync(this.root)) for (const name of readdirSync(this.root)) {
      if (/^speech-[a-f0-9-]{36}$/.test(name)) rmSync(join(this.root, name), { recursive: true, force: true });
    }
  }
  get model(): string { return join(this.root, 'ggml-small-q5_1.bin'); }
  get executable(): string {
    const managed = join(this.root, 'runtime', 'whisper-cli.exe');
    return existsSync(managed) ? managed : Bun.which('whisper-cli') ?? '';
  }
  ready(executable: string, model: string): boolean {
    return [executable || this.executable, model || this.model].every(path => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
  }
  /** A retry after a failed model download keeps the runtime it already unpacked. */
  private needsRuntime(): boolean {
    return this.canInstallRuntime && !existsSync(join(this.root, 'runtime', 'whisper-cli.exe'));
  }
  start(): void {
    if (this.installing) throw refused('speech: a download is already running');
    this.installing = true;
    this.error = null;
    this.downloadedBytes = 0;
    this.totalBytes = MODEL.bytes + (this.needsRuntime() ? RUNTIME.bytes : 0);
    this.controller = new AbortController();
    this.pending = this.install(this.controller.signal).catch(error => {
      this.error = this.controller?.signal.aborted ? null : String(error.message ?? error);
    }).finally(() => { this.installing = false; this.controller = null; });
  }
  async cancel(): Promise<void> { this.controller?.abort(); await this.pending; }
  async remove(): Promise<void> {
    await this.cancel();
    // Only these managed paths belong to the installer; custom paths are never removed.
    rmSync(join(this.root, 'runtime'), { recursive: true, force: true });
    rmSync(this.model, { force: true });
    dropPart(`${this.model}.part`);
    rmSync(join(this.root, 'runtime.zip'), { force: true });
    dropPart(join(this.root, 'runtime.zip.part'));
    rmSync(join(this.root, 'runtime-staging'), { recursive: true, force: true });
    this.error = null;
  }
  /**
   * One download into `${target}.part`, then a rename once size and SHA-256
   * match. A connection that drops or goes quiet for `stallMs` keeps the part
   * and a `.part.json` naming the url, digest and validator it came from: the
   * next install resumes only when the url and digest are the ones it wants,
   * hashes the part again and asks for the rest with `If-Range`, so a file
   * changed on the server comes whole. A wrong size, a wrong digest or a cancel
   * starts over.
   */
  private async download(spec: typeof MODEL, target: string, signal: AbortSignal): Promise<void> {
    const part = `${target}.part`;
    let hash = createHash('sha256');
    let bytes = 0;
    let held = 0;
    try { held = statSync(part).size; } catch { /* nothing to resume */ }
    const record = readPartRecord(part);
    // Bytes of another file, a Boite that pinned another model or runtime, are never resumed.
    const same = record !== null && record.url === spec.url && record.sha256.toLowerCase() === spec.sha256.toLowerCase();
    let validator = same ? record.validator : null;
    if (same && held > 0 && held < spec.bytes) {
      for await (const chunk of Bun.file(part).stream()) {
        signal.throwIfAborted();
        hash.update(chunk);
        bytes += chunk.length;
      }
      this.downloadedBytes += bytes;
    } else dropPart(part);

    let fd: number | null = null;
    let keep = false;
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), this.stallMs); };
    const at = () => `at ${megabytes(bytes)} of ${megabytes(spec.bytes)} MB`;
    // What the network threw, in words that say the bytes so far are kept.
    const lost = (): Error => {
      keep = true;
      return new Error(stall.signal.aborted
        ? `speech download: no data for ${Math.round(this.stallMs / 1000)} s ${at()}; install again to resume`
        : `speech download: the connection dropped ${at()}; install again to resume`);
    };
    try {
      arm();
      let response: Response;
      try {
        response = await fetch(spec.url, {
          signal: AbortSignal.any([signal, stall.signal]),
          headers: bytes > 0
            ? { range: `bytes=${bytes}-`, ...(validator === null ? {} : { 'if-range': validator }), 'accept-encoding': 'identity' }
            : { 'accept-encoding': 'identity' },
        });
      } catch (error) {
        throw signal.aborted ? error : lost();
      }
      if (response.status === 206) {
        const from = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1];
        if (from === undefined || Number(from) !== bytes) throw new Error(`speech download: the server resumed at byte ${from ?? 'unknown'} instead of ${bytes}`);
      } else if (response.ok) {
        // The whole file again: a server that does not resume.
        this.downloadedBytes -= bytes;
        bytes = 0;
        hash = createHash('sha256');
      } else {
        keep = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new Error(`speech download: HTTP ${response.status}`);
      }
      if (!response.body) throw new Error(`speech download: HTTP ${response.status} with no body`);
      const etag = response.headers.get('etag');
      // `If-Range` takes a strong ETag or a date; a weak one would never match.
      validator = etag !== null && !etag.startsWith('W/')
        ? etag
        : (response.headers.get('last-modified') ?? (response.status === 206 ? validator : null));
      const kept: PartRecord = { url: spec.url, sha256: spec.sha256, validator };
      writeFileSync(`${part}.json`, `${JSON.stringify(kept)}\n`);
      fd = openSync(part, bytes > 0 ? 'a' : 'w', 0o600);
      const reader = response.body.getReader();
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try { read = await reader.read(); }
        catch (error) { throw signal.aborted ? error : lost(); }
        signal.throwIfAborted();
        if (stall.signal.aborted) throw lost();
        if (read.done) break;
        arm();
        const chunk = read.value;
        bytes += chunk.length;
        if (bytes > spec.bytes) throw new Error('speech download: file exceeds expected size');
        hash.update(chunk);
        writeSync(fd, chunk);
        this.downloadedBytes += chunk.length;
      }
      if (bytes !== spec.bytes || hash.digest('hex') !== spec.sha256) throw new Error('speech download: size or SHA-256 mismatch');
      closeSync(fd);
      fd = null;
      renameSync(part, target);
      rmSync(`${part}.json`, { force: true });
    } catch (error) {
      try { if (fd !== null) closeSync(fd); }
      finally { if (!keep || signal.aborted) dropPart(part); }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async install(signal: AbortSignal): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    const free = freeBytesAt(this.root);
    if (free !== null && free < MODEL.bytes + RUNTIME.bytes * 4 + 256 * 1024 * 1024) throw refused('speech: at least 500 MB of free space is required for the download');
    if (this.needsRuntime()) {
      const archive = join(this.root, 'runtime.zip');
      const staging = join(this.root, 'runtime-staging');
      try {
        await this.download(RUNTIME, archive, signal);
        // Loaded on install only, like the provider installer's unzip.
        const { unzipSync } = await import('fflate');
        const files = unzipSync(new Uint8Array(await Bun.file(archive).arrayBuffer()));
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        const seen = new Set<string>();
        for (const [name, data] of Object.entries(files)) {
          const file = basename(name.replaceAll('\\', '/'));
          if (file !== 'whisper-cli.exe' && !file.endsWith('.dll') && !/^LICENSE/i.test(file)) continue;
          if (seen.has(file)) throw new Error(`speech runtime: duplicate file ${file}`);
          seen.add(file);
          await Bun.write(join(staging, file), data);
        }
        if (!seen.has('whisper-cli.exe')) throw new Error('speech runtime: whisper-cli.exe missing');
        signal.throwIfAborted();
        rmSync(join(this.root, 'runtime'), { recursive: true, force: true });
        renameSync(staging, join(this.root, 'runtime'));
      } finally {
        rmSync(archive, { force: true });
        rmSync(staging, { recursive: true, force: true });
      }
    }
    await this.download(MODEL, this.model, signal);
  }
}

export async function transcribeLocal(core: Core, local: SpeechLocal, audio: Uint8Array, config: { executable: string; modelPath: string; language: string }, signal: AbortSignal): Promise<string> {
  const id = `speech:${crypto.randomUUID()}`;
  const dir = join(local.root, id.replace(':', '-'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let child: ReturnType<Core['procs']['spawn']> | undefined;
  const abort = () => core.procs.killTree(id);
  try {
    await Bun.write(join(dir, 'input.wav'), audio);
    signal.throwIfAborted();
    child = core.procs.spawn(id, config.executable || local.executable, [
      '-m', config.modelPath || local.model, '-f', join(dir, 'input.wav'),
      // No '-t': whisper-cli takes min(4, cores) itself, which a 2-core machine needs.
      '-l', config.language || 'auto', '-ng', '-nt', '-otxt', '-of', join(dir, 'result'),
    ], { cwd: dir });
    signal.addEventListener('abort', abort, { once: true });
    // Drain both pipes without keeping raw transcripts or diagnostics in the journal.
    const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const _ of stream) { /* drain */ } };
    const [code] = await Promise.all([child.exited, drain(child.proc.stdout), drain(child.proc.stderr)]);
    signal.throwIfAborted();
    if (code !== 0) throw refused(`speech: whisper-cli exited with code ${code}; check the executable and model in Voice settings`);
    return (await Bun.file(join(dir, 'result.txt')).text()).trim();
  } finally {
    signal.removeEventListener('abort', abort);
    if (child) { abort(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}
