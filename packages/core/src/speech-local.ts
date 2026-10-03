import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeSync, renameSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { freeBytesAt } from './providers/install.ts';
import { CUSTOM_MAX_BYTES, SpeechModels, catalogueEntry, type CustomRecord, type DownloadSpec } from './speech-models.ts';
import { previewContext, SpeechServer, speechThreads } from './speech-server.ts';
import { SpeechNative } from './speech-native.ts';
import { NEMOTRON_FILES, sherpaRuntime, whistleRuntime, unpackSpeechRuntime } from './speech-artifacts.ts';

const RUNTIME: DownloadSpec = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
  bytes: 8194445,
  sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
};
const RUNTIME_BYTES = RUNTIME.bytes ?? 0;
/** Room left on the disk after a download, for the journal and everything else. */
const MARGIN = 256 * 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/** Written beside a `.part`, so a later download resumes only bytes of the same file. */
interface PartRecord {
  url: string;
  /** Empty for a link with no known digest. */
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

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** What a download is for: a model id, and a custom model's record when it came from a link. */
export interface SpeechTarget {
  id: string;
  spec: DownloadSpec;
  custom?: CustomRecord;
}

export class SpeechLocal {
  readonly root: string;
  readonly models: SpeechModels;
  readonly server: SpeechServer;
  readonly native: SpeechNative;
  installing = false;
  /** The model the running download is for. */
  downloading: string | null = null;
  downloadedBytes = 0;
  totalBytes = 0;
  error: string | null = null;
  /** How long a download may receive nothing before it gives up and keeps its bytes. A test seam. */
  stallMs = 60_000;
  /** The command that starts a whisper-server, instead of the one beside the executable. A test seam. */
  serverOverride: string[] | null = null;
  private runtimeBytes = 0;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  readonly canInstallRuntime = process.platform === 'win32' && process.arch === 'x64';

  constructor(core: Core) {
    this.root = join(core.dataDir, 'speech');
    this.models = new SpeechModels(this.root);
    this.server = new SpeechServer(core, this.root);
    this.native = new SpeechNative(core, this.root);
    // Remove only our transient audio directories left by a hard-killed core.
    if (existsSync(this.root)) for (const name of readdirSync(this.root)) {
      if (/^speech-[a-f0-9-]{36}$/.test(name)) rmSync(join(this.root, name), { recursive: true, force: true });
    }
  }
  private get runtime(): string { return join(this.root, 'runtime'); }
  get nativeRuntime(): string { return join(this.root, 'runtime-sherpa'); }
  get needle(): string { return join(this.root, 'runtime-whistle', process.platform === 'win32' ? 'needle.exe' : 'needle'); }
  canInstallModel(id: string): boolean {
    const backend = catalogueEntry(id)?.backend;
    return backend === 'whistle' ? !!whistleRuntime() : backend === 'nemotron' ? !!sherpaRuntime() : this.canInstallRuntime;
  }
  /** A different engine's runtime can install while the selected engine still dictates. */
  updatingRuntimeFor(id?: string): boolean {
    const backend = catalogueEntry(id ?? '')?.backend ?? 'whisper';
    const downloadingBackend = catalogueEntry(this.downloading ?? '')?.backend ?? 'whisper';
    return this.installing && this.runtimeBytes > 0 && backend === downloadingBackend;
  }
  get executable(): string {
    const managed = join(this.runtime, 'whisper-cli.exe');
    return existsSync(managed) ? managed : Bun.which('whisper-cli') ?? '';
  }
  /** The model file a configuration names: its own path, or the managed file of its model id. */
  modelFile(config: { model: string; modelPath: string }): string {
    return config.modelPath || this.models.file(config.model);
  }
  ready(executable: string, model: string, id?: string): boolean {
    const backend = id ? catalogueEntry(id)?.backend : undefined;
    if (backend === 'whistle') return isFile(this.needle) && this.models.installed(id!);
    if (backend === 'nemotron') return isFile(join(this.nativeRuntime, 'ready.json')) && this.models.installed(id!);
    return isFile(executable || this.executable) && isFile(model);
  }
  /** Installed by a Boite that fetched only whisper-cli: it works, one model load per request. */
  runtimeOutdated(): boolean {
    return this.canInstallRuntime && existsSync(join(this.runtime, 'whisper-cli.exe')) && !existsSync(join(this.runtime, 'whisper-server.exe'));
  }
  /** A retry after a failed model download keeps the runtime it already unpacked. */
  needsRuntime(id?: string): boolean {
    const backend = id ? catalogueEntry(id)?.backend : undefined;
    if (backend === 'whistle') return !isFile(this.needle);
    if (backend === 'nemotron') return !isFile(join(this.nativeRuntime, 'ready.json'));
    return this.canInstallRuntime && !(existsSync(join(this.runtime, 'whisper-cli.exe')) && existsSync(join(this.runtime, 'whisper-server.exe')));
  }
  /** The whisper-server of the same build as the whisper-cli in use, or null to run whisper-cli per request. */
  serverCommand(executable: string): string[] | null {
    if (this.serverOverride) return this.serverOverride;
    const cli = executable || this.executable;
    if (!cli) return null;
    const server = join(dirname(cli), process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
    return isFile(server) ? [server] : null;
  }
  /** True when there was something to download; false when the model and runtime are already here. */
  start(target: SpeechTarget, done: (id: string) => void): boolean {
    if (this.installing) throw refused('speech: a download is already running');
    const backend = catalogueEntry(target.id)?.backend;
    if (backend && !this.canInstallModel(target.id)) throw refused(`speech: ${backend} runtime is unavailable on ${process.platform}/${process.arch}`);
    const runtime = this.needsRuntime(target.id);
    const model = !this.models.installed(target.id);
    if (!runtime && !model) return false;
    this.installing = true;
    this.downloading = target.id;
    this.error = null;
    this.downloadedBytes = 0;
    const runtimeSize = backend === 'whistle' ? whistleRuntime()!.bytes! : backend === 'nemotron' ? sherpaRuntime()!.reduce((sum, file) => sum + file.bytes!, 0) : RUNTIME_BYTES;
    this.runtimeBytes = runtime ? runtimeSize : 0;
    // A link's size is known once its server answers.
    const modelBytes = backend === 'nemotron' ? NEMOTRON_FILES.filter(file => !isFile(join(this.root, 'nemotron', file.file))).reduce((sum, file) => sum + file.bytes!, 0) : model ? target.spec.bytes ?? 0 : 0;
    this.totalBytes = model && target.spec.bytes === null ? 0 : this.runtimeBytes + modelBytes;
    if (target.custom) this.models.saveCustom(target.custom);
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.install(target, runtime, controller.signal).then(() => done(target.id)).catch(error => {
      this.error = controller.signal.aborted ? null : String(error.message ?? error);
      // A link that failed its checks leaves no row behind; one with a part kept can resume.
      const file = this.models.file(target.id);
      if (target.custom && !isFile(file) && !existsSync(`${file}.part`)) this.models.remove(target.id);
    }).finally(() => { this.installing = false; this.downloading = null; this.controller = null; });
    return true;
  }
  async cancel(): Promise<void> { this.controller?.abort(); await this.pending; }
  /** One model, or the runtime and every managed model. Paths set by hand are never removed. */
  async remove(id?: string): Promise<void> {
    if (id === undefined || this.downloading === id) await this.cancel();
    // A loaded model file cannot be removed on Windows.
    await this.server.stop();
    await this.native.stop();
    if (id !== undefined) {
      this.models.remove(id);
      this.error = null;
      return;
    }
    rmSync(this.runtime, { recursive: true, force: true });
    rmSync(join(this.root, 'runtime-whistle'), { recursive: true, force: true });
    rmSync(this.nativeRuntime, { recursive: true, force: true });
    rmSync(join(this.root, 'native-staging'), { recursive: true, force: true });
    for (const archive of ['bindings.tgz', 'native.tgz']) {
      rmSync(join(this.root, archive), { force: true });
      dropPart(join(this.root, `${archive}.part`));
    }
    this.models.removeAll();
    rmSync(join(this.root, 'runtime.zip'), { force: true });
    dropPart(join(this.root, 'runtime.zip.part'));
    rmSync(join(this.root, 'runtime-staging'), { recursive: true, force: true });
    this.error = null;
  }
  /**
   * One download into `${target}.part`, then a rename once the size, and the
   * SHA-256 when one is known, match. A connection that drops or goes quiet for
   * `stallMs` keeps the part and a `.part.json` naming the url, digest and
   * validator it came from: the next install resumes only when the url and
   * digest are the ones it wants, hashes the part again and asks for the rest
   * with `If-Range`, so a file changed on the server comes whole. A wrong size,
   * a wrong digest, a header `check` refuses or a cancel starts over.
   */
  private async download(spec: DownloadSpec, target: string, signal: AbortSignal): Promise<void> {
    const part = `${target}.part`;
    const hashing = spec.sha256 !== null;
    let hash = createHash('sha256');
    let bytes = 0;
    let held = 0;
    let head = new Uint8Array(0);
    try { held = statSync(part).size; } catch { /* nothing to resume */ }
    const record = readPartRecord(part);
    // Bytes of another file, a Boite that pinned another model or runtime, are never resumed.
    const same = record !== null && record.url === spec.url && record.sha256.toLowerCase() === (spec.sha256 ?? '').toLowerCase();
    let validator = same ? record.validator : null;
    if (same && held > 0 && (spec.bytes === null || held < spec.bytes)) {
      if (hashing) {
        for await (const chunk of Bun.file(part).stream()) {
          signal.throwIfAborted();
          hash.update(chunk);
        }
      }
      bytes = held;
      head = new Uint8Array(await Bun.file(part).slice(0, 48).arrayBuffer());
      this.downloadedBytes += bytes;
    } else dropPart(part);

    let expected = spec.bytes;
    let fd: number | null = null;
    let keep = false;
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), this.stallMs); };
    const at = () => `at ${megabytes(bytes)}${expected === null ? '' : ` of ${megabytes(expected)}`} MB`;
    // What the network threw, in words that say the bytes so far are kept.
    const lost = (): Error => {
      keep = true;
      return new Error(stall.signal.aborted
        ? `speech download: no data for ${Math.round(this.stallMs / 1000)} s ${at()}; install again to resume`
        : `speech download: the connection dropped ${at()}; install again to resume`);
    };
    // The first 48 bytes go through `check` once, as soon as they are in: a web page stops here, not after 4 GB.
    let checked = !spec.check;
    const inspect = (final: boolean) => {
      if (checked || (head.length < 48 && !final)) return;
      checked = true;
      spec.check?.(head);
    };
    try {
      inspect(false);
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
      // A link given as https stays https through its redirects.
      if (spec.url.startsWith('https:') && response.redirected && !response.url.startsWith('https:')) {
        await response.body?.cancel();
        throw new Error('speech download: the link redirected away from https');
      }
      let complete = false;
      if (response.status === 206) {
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
        const from = range?.[1];
        if (from === undefined || Number(from) !== bytes) throw new Error(`speech download: the server resumed at byte ${from ?? 'unknown'} instead of ${bytes}`);
        if (expected === null && range?.[2] && range[2] !== '*') expected = Number(range[2]);
      } else if (response.status === 416 && bytes > 0) {
        // The part already holds the whole file: a core stopped between the last byte and the rename.
        await response.body?.cancel();
        const whole = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
        if (whole === undefined || Number(whole) !== bytes) throw new Error('speech download: the server refused to resume; install again to start over');
        expected ??= bytes;
        complete = true;
      } else if (response.ok) {
        // The whole file again: a server that does not resume.
        this.downloadedBytes -= bytes;
        bytes = 0;
        hash = createHash('sha256');
        head = new Uint8Array(0);
        checked = !spec.check;
        const length = response.headers.get('content-length');
        if (expected === null && length !== null && /^\d+$/.test(length)) expected = Number(length);
      } else {
        await response.body?.cancel();
        keep = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new Error(`speech download: HTTP ${response.status}${response.status === 401 || response.status === 403 ? '; the link needs a sign-in, which Boite does not send' : ''}`);
      }
      if (spec.bytes === null && expected !== null) {
        if (expected > CUSTOM_MAX_BYTES) throw new Error(`speech.url: the file is ${megabytes(expected)} MB; a Whisper model is at most ${megabytes(CUSTOM_MAX_BYTES)} MB`);
        this.totalBytes = this.runtimeBytes + expected;
      }
      const free = freeBytesAt(dirname(target));
      const need = (expected ?? bytes) - bytes + MARGIN;
      if (free !== null && free < need) throw refused(`speech: ${megabytes(need)} MB of free space is required for the download`);
      if (!complete) {
        if (!response.body) throw new Error(`speech download: HTTP ${response.status} with no body`);
        const etag = response.headers.get('etag');
        // `If-Range` takes a strong ETag or a date; a weak one would never match.
        validator = etag !== null && !etag.startsWith('W/')
          ? etag
          : (response.headers.get('last-modified') ?? (response.status === 206 ? validator : null));
        const kept: PartRecord = { url: spec.url, sha256: spec.sha256 ?? '', validator };
        writeFileSync(`${part}.json`, `${JSON.stringify(kept)}\n`);
        fd = openSync(part, bytes > 0 ? 'a' : 'w', 0o600);
        const limit = expected ?? CUSTOM_MAX_BYTES;
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
          if (bytes > limit) throw new Error('speech download: file exceeds expected size');
          if (!checked) {
            const joined = new Uint8Array(Math.min(48, head.length + chunk.length));
            joined.set(head);
            joined.set(chunk.subarray(0, joined.length - head.length), head.length);
            head = joined;
            inspect(false);
          }
          if (hashing) hash.update(chunk);
          writeSync(fd, chunk);
          this.downloadedBytes += chunk.length;
        }
      }
      inspect(true);
      if ((expected !== null && bytes !== expected) || (hashing && hash.digest('hex') !== spec.sha256)) throw new Error('speech download: size or SHA-256 mismatch');
      if (fd !== null) closeSync(fd);
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
  private async install(target: SpeechTarget, runtime: boolean, signal: AbortSignal): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    const backend = catalogueEntry(target.id)?.backend;
    if (backend === 'whistle' || backend === 'nemotron') {
      await this.installNative(target, runtime, signal);
      return;
    }
    if (runtime) {
      const free = freeBytesAt(this.root);
      if (free !== null && free < RUNTIME_BYTES * 4 + MARGIN) throw refused(`speech: ${megabytes(RUNTIME_BYTES * 4 + MARGIN)} MB of free space is required for the download`);
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
          if (file !== 'whisper-cli.exe' && file !== 'whisper-server.exe' && !file.endsWith('.dll') && !/^LICENSE/i.test(file)) continue;
          if (seen.has(file)) throw new Error(`speech runtime: duplicate file ${file}`);
          seen.add(file);
          await Bun.write(join(staging, file), data);
        }
        for (const needed of ['whisper-cli.exe', 'whisper-server.exe']) if (!seen.has(needed)) throw new Error(`speech runtime: ${needed} missing`);
        signal.throwIfAborted();
        // An outdated runtime may still run a whisper-cli; nothing else holds these files.
        await this.server.stop();
        rmSync(this.runtime, { recursive: true, force: true });
        renameSync(staging, this.runtime);
      } finally {
        rmSync(archive, { force: true });
        rmSync(staging, { recursive: true, force: true });
      }
    }
    const file = this.models.file(target.id);
    if (!isFile(file)) {
      mkdirSync(dirname(file), { recursive: true });
      await this.download(target.spec, file, signal);
      if (target.custom) this.models.saveCustom({ ...target.custom, bytes: statSync(file).size });
    }
  }

  private async installNative(target: SpeechTarget, runtime: boolean, signal: AbortSignal): Promise<void> {
    const nemotron = catalogueEntry(target.id)?.backend === 'nemotron';
    const required = this.totalBytes * (runtime ? 2 : 1) + MARGIN;
    const free = freeBytesAt(this.root);
    if (free !== null && free < required) throw refused(`speech: ${megabytes(required)} MB of free space is required for the download`);
    if (runtime) {
      if (nemotron) {
        const staging = join(this.root, 'native-staging');
        rmSync(staging, { recursive: true, force: true });
        try {
          for (const spec of sherpaRuntime()!) {
            const archive = join(this.root, spec.file);
            await this.download(spec, archive, signal);
            await unpackSpeechRuntime(archive, staging, signal);
            rmSync(archive, { force: true });
          }
          for (const name of ['streaming-asr.js', 'addon.js', 'sherpa-onnx.node']) if (!isFile(join(staging, name))) throw refused(`speech runtime: ${name} missing`);
          signal.throwIfAborted();
          await this.native.stop();
          writeFileSync(join(staging, 'ready.json'), JSON.stringify({ version: '1.13.8' }), { mode: 0o600 });
          rmSync(this.nativeRuntime, { recursive: true, force: true });
          renameSync(staging, this.nativeRuntime);
        } finally { rmSync(staging, { recursive: true, force: true }); }
      } else {
        mkdirSync(dirname(this.needle), { recursive: true });
        await this.download(whistleRuntime()!, this.needle, signal);
        chmodSync(this.needle, 0o700);
      }
    }
    if (nemotron) {
      const directory = join(this.root, 'nemotron');
      mkdirSync(directory, { recursive: true });
      for (const spec of NEMOTRON_FILES) if (!isFile(join(directory, spec.file))) await this.download(spec, join(directory, spec.file), signal);
    } else if (!this.models.installed(target.id)) await this.download(target.spec, this.models.file(target.id), signal);
  }
}

/** What the local engine is asked for one request. */
export interface LocalRequest {
  executable: string;
  model: string;
  /** A language code or name, or 'auto'. */
  language: string;
  /** A provisional window: decode a narrower encoder context. */
  preview: boolean;
}

/**
 * Through the resident whisper-server when the runtime has one, else one
 * whisper-cli per request. Both report the language they heard, so a final
 * request can skip the detection its previews already paid for.
 */
export async function transcribeLocal(core: Core, local: SpeechLocal, audio: Uint8Array, request: LocalRequest, signal: AbortSignal): Promise<{ text: string; language?: string }> {
  const audioCtx = request.preview ? previewContext(audio) : 0;
  const server = local.serverCommand(request.executable);
  if (server) return local.server.transcribe(server, request.model, audio, { language: request.language, audioCtx, signal });
  const id = `speech:${crypto.randomUUID()}`;
  const dir = join(local.root, id.replace(':', '-'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let child: ReturnType<Core['procs']['spawn']> | undefined;
  const abort = () => core.procs.killTree(id);
  try {
    await Bun.write(join(dir, 'input.wav'), audio);
    signal.throwIfAborted();
    child = core.procs.spawn(id, request.executable || local.executable, [
      '-m', request.model, '-f', join(dir, 'input.wav'), '-t', String(speechThreads()),
      '-l', request.language, ...(audioCtx > 0 ? ['-ac', String(audioCtx)] : []), '-ng', '-nt', '-otxt', '-of', join(dir, 'result'),
    ], { cwd: dir });
    signal.addEventListener('abort', abort, { once: true });
    // Drain both pipes; only the detected language is kept from stderr, never a transcript.
    let language: string | undefined;
    const drain = async (stream: ReadableStream<Uint8Array>, look: boolean) => {
      const decoder = new TextDecoder();
      let tail = '';
      for await (const chunk of stream) {
        if (!look || language) continue;
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-512);
        language = /auto-detected language: ([a-z]+) /.exec(tail)?.[1];
      }
    };
    const [code] = await Promise.all([child.exited, drain(child.proc.stdout, false), drain(child.proc.stderr, request.language === 'auto')]);
    signal.throwIfAborted();
    if (code !== 0) throw refused(`speech: whisper-cli exited with code ${code}; check the executable and model in Voice settings`);
    const text = (await Bun.file(join(dir, 'result.txt')).text()).split('\n').map(line => line.trim()).filter(Boolean).join(' ');
    return language ? { text, language } : { text };
  } finally {
    signal.removeEventListener('abort', abort);
    if (child) { abort(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}
