// Files the agent browser downloads: kept in a quarantine folder of the core until an agent copies one out.
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_DOWNLOAD_KEEP_MS,
  BROWSER_DOWNLOAD_MAX_BYTES,
  BROWSER_DOWNLOADS_MAX_BYTES,
  BROWSER_DOWNLOADS_PER_THREAD,
  browserDownloadName,
  type BrowserDownload,
  type BrowserDownloadKind,
  type ThreadId,
} from '@boite/contracts';
import { refused } from '../errors.ts';
import { bareUrl } from './page-events.ts';
import type { Engine } from './types.ts';
import type { AgentPage } from './automation.ts';

interface Entry extends BrowserDownload {
  threadId: ThreadId;
  guid: string;
  engine: Engine;
  /** Where the browser wrote it: the quarantine folder, named by its guid. */
  path: string;
  seq: number;
  expire?: ReturnType<typeof setTimeout>;
}

/** A Map, so a name ending in `.constructor` or `.__proto__` is no known kind. */
const EXTENSIONS = new Map<string, BrowserDownloadKind>();
const kinds: Array<[BrowserDownloadKind, string]> = [
  ['executable', 'exe msi msix msixbundle appx appxbundle com scr dll sys cpl ocx so dylib app dmg pkg mpkg deb rpm apk aab xapk jar war appimage run bin elf xpi crx iso img vhd vhdx lnk'],
  ['script', 'sh bash zsh fish ps1 psm1 psd1 bat cmd vbs vbe js mjs cjs jse wsf wsh hta py pyw rb pl php applescript scpt reg desktop command'],
  ['archive', 'zip 7z rar tar gz tgz bz2 tbz2 xz txz zst lz lzma cab'],
  ['document', 'pdf doc docx docm xls xlsx xlsm ppt pptx pptm odt ods odp rtf epub'],
  ['image', 'png jpg jpeg gif webp avif svg bmp ico tif tiff heic'],
  ['media', 'mp3 mp4 m4a wav ogg oga opus flac webm mkv mov avi'],
  ['text', 'txt md csv tsv json xml yaml yml html htm css log ini toml'],
];
for (const [kind, list] of kinds) for (const ext of list.split(' ')) EXTENSIONS.set(ext, kind);
const RISK: BrowserDownloadKind[] = ['executable', 'script', 'archive', 'document', 'other', 'image', 'media', 'text'];
const MACROS = new Set(['docm', 'xlsm', 'pptm']);

/** What the first bytes of a file say it is; null when they say nothing known. */
export function sniffDownload(head: Uint8Array): BrowserDownloadKind | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((byte, i) => head[offset + i] === byte);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map(char => char.charCodeAt(0)));
  if (ascii(0, 'MZ') || at(0, 0x7f, 0x45, 0x4c, 0x46) || at(0, 0xfe, 0xed, 0xfa, 0xce) || at(0, 0xfe, 0xed, 0xfa, 0xcf)
    || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe) || ascii(0, 'xar!') || ascii(0, '\0asm')) return 'executable';
  if (ascii(0, '#!')) return 'script';
  if (ascii(0, 'PK\x03\x04') || ascii(0, '7z\xbc\xaf\x27\x1c') || ascii(0, 'Rar!') || at(0, 0x1f, 0x8b) || ascii(0, 'BZh') || at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a)
    || at(0, 0x28, 0xb5, 0x2f, 0xfd) || ascii(0, 'MSCF') || ascii(257, 'ustar')) return 'archive';
  if (ascii(0, '%PDF') || at(0, 0xd0, 0xcf, 0x11, 0xe0)) return 'document';
  if (at(0, 0x89, 0x50, 0x4e, 0x47) || at(0, 0xff, 0xd8, 0xff) || ascii(0, 'GIF8') || (ascii(0, 'RIFF') && ascii(8, 'WEBP'))) return 'image';
  if (ascii(4, 'ftyp') || at(0, 0x1a, 0x45, 0xdf, 0xa3) || ascii(0, 'OggS') || ascii(0, 'ID3') || ascii(0, 'fLaC') || (ascii(0, 'RIFF') && ascii(8, 'WAVE'))) return 'media';
  if (head.length && head.every(byte => byte === 9 || byte === 10 || byte === 13 || byte >= 32)) return 'text';
  return null;
}

/** The riskier of what the name and the bytes say, and what to check before using the file. */
export function classifyDownload(name: string, head: Uint8Array): { kind: BrowserDownloadKind; warning?: string } {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const named = EXTENSIONS.get(ext) ?? null, sniffed = sniffDownload(head);
  // A package of executable code inside a zip (jar, apk, xpi) is an executable, not an archive.
  const bytes = sniffed === 'archive' && named === 'executable' ? 'executable' : sniffed;
  const kind = [named, bytes].filter((one): one is BrowserDownloadKind => one !== null).sort((a, b) => RISK.indexOf(a) - RISK.indexOf(b))[0] ?? 'other';
  const disguised = bytes !== null && named !== null && RISK.indexOf(bytes) < RISK.indexOf(named) && (bytes === 'executable' || bytes === 'script');
  const warning = disguised ? `its name says .${ext} but its bytes are ${bytes === 'executable' ? 'a program' : 'a script'}: do not open or run it`
    : kind === 'executable' || kind === 'script' ? 'a program or a script: never run it unless the user asked for this exact file from this source'
      : kind === 'archive' ? 'an archive: unpack it into its own empty folder and check what it holds before using any of it'
        : MACROS.has(ext) ? 'a document with macros: never enable them' : undefined;
  return { kind, ...(warning ? { warning } : {}) };
}

/**
 * Downloads of every conversation on this machine. The browser writes each
 * one under its guid in `dir`, so nothing the page names lands anywhere or
 * runs by a double click; this keeps the list, the limits and the cleanup.
 */
export class BrowserDownloads {
  #entries = new Map<string, Entry>();
  #byGuid = new Map<string, Entry>();
  #seq = 0;
  #waiters = new Set<() => void>();
  #swept = false;

  /** `dataDir` is read on first use: the core sets it after building the browser. */
  constructor(private dataDir: () => string, private log: (message: string) => void) {}

  get dir(): string { return join(this.dataDir(), 'browser-downloads'); }

  /** Before the first browser of this core: what an earlier core left is listed nowhere. */
  prepare(): string {
    if (!this.#swept) { this.#swept = true; this.#remove(this.dir); }
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  get seq(): number { return this.#seq; }

  /** Starts listening to an engine's downloads; `tabOf` finds the tab whose frame began one. */
  watch(engine: Engine, tabOf: (frameId: string) => { threadId: ThreadId; page: AgentPage } | null): void {
    engine.cdp.on('Browser.downloadWillBegin', params => {
      const guid = String(params.guid);
      const tab = tabOf(String(params.frameId));
      // A frame no conversation owns (a window still attaching): nobody would see the file.
      if (!tab) { void this.#cancel(engine, guid); return; }
      tab.page.downloads = (tab.page.downloads ?? 0) + 1;
      this.#begin(tab.threadId, engine, guid, String(params.url ?? ''), params.suggestedFilename);
    });
    engine.cdp.on('Browser.downloadProgress', params => this.#progress(String(params.guid), params as unknown as Progress));
  }

  #begin(threadId: ThreadId, engine: Engine, guid: string, url: string, suggested: unknown): void {
    const own = [...this.#entries.values()].filter(entry => entry.threadId === threadId);
    if (own.length >= BROWSER_DOWNLOADS_PER_THREAD) {
      const oldest = own.find(entry => entry.state !== 'downloading');
      if (oldest) this.#forget(oldest);
    }
    const entry: Entry = {
      id: `dl-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, name: browserDownloadName(suggested), url: url.startsWith('data:') || url.startsWith('blob:') ? url.slice(0, url.indexOf(':') + 1) : bareUrl(url),
      state: 'downloading', bytes: 0, startedAt: Date.now(), threadId, guid, engine, path: join(this.dir, guid), seq: ++this.#seq,
    };
    this.#entries.set(entry.id, entry); this.#byGuid.set(guid, entry);
    if (own.length >= BROWSER_DOWNLOADS_PER_THREAD && !own.some(other => other.state !== 'downloading')) this.#stop(entry, `a conversation keeps ${BROWSER_DOWNLOADS_PER_THREAD} downloads; wait for one to end or discard one`);
    this.#wake();
  }

  #progress(guid: string, progress: Progress): void {
    const entry = this.#byGuid.get(guid);
    if (!entry || entry.state !== 'downloading') return;
    entry.bytes = progress.receivedBytes;
    if (progress.totalBytes > 0) entry.totalBytes = progress.totalBytes;
    if (progress.state === 'canceled') { this.#end(entry, 'canceled', entry.reason ?? 'the page or the browser cancelled it'); return; }
    const size = Math.max(entry.bytes, entry.totalBytes ?? 0);
    if (size > BROWSER_DOWNLOAD_MAX_BYTES) { this.#stop(entry, `larger than ${BROWSER_DOWNLOAD_MAX_BYTES / 1024 ** 3} GiB`); return; }
    if (this.#held() > BROWSER_DOWNLOADS_MAX_BYTES) { this.#stop(entry, `the download quarantine of this machine already holds ${BROWSER_DOWNLOADS_MAX_BYTES / 1024 ** 3} GiB; save or discard downloads first`); return; }
    if (progress.state === 'completed') void this.#finish(entry, progress.filePath);
  }

  /** Bytes in the quarantine: finished files and what downloads in progress will weigh. */
  #held(): number {
    let sum = 0;
    for (const entry of this.#entries.values()) if (entry.state === 'downloading' || entry.state === 'done') sum += Math.max(entry.bytes, entry.totalBytes ?? 0);
    return sum;
  }

  async #finish(entry: Entry, filePath: string | undefined): Promise<void> {
    // The browser names the file itself; anything outside the quarantine is not trusted as ours.
    if (filePath && filePath !== entry.path) { this.#end(entry, 'failed', 'the browser wrote it outside the quarantine'); this.#remove(filePath); return; }
    try {
      const size = statSync(entry.path).size;
      if (size > BROWSER_DOWNLOAD_MAX_BYTES) { this.#end(entry, 'canceled', `larger than ${BROWSER_DOWNLOAD_MAX_BYTES / 1024 ** 3} GiB`); return; }
      const hasher = new Bun.CryptoHasher('sha256');
      for await (const chunk of Bun.file(entry.path).stream()) hasher.update(chunk);
      const head = Buffer.alloc(512), fd = openSync(entry.path, 'r');
      let read = 0;
      try { read = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
      if (entry.state !== 'downloading') return;
      Object.assign(entry, { bytes: size, totalBytes: size, sha256: hasher.digest('hex'), ...classifyDownload(entry.name, head.subarray(0, read)) });
      this.#end(entry, 'done');
    } catch (error) {
      this.#end(entry, 'failed', `the file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #stop(entry: Entry, reason: string): void {
    void this.#cancel(entry.engine, entry.guid);
    this.#end(entry, 'canceled', reason);
  }

  async #cancel(engine: Engine, guid: string): Promise<void> {
    await engine.cdp.send('Browser.cancelDownload', { guid }).catch(() => {});
  }

  #end(entry: Entry, state: Entry['state'], reason?: string): void {
    if (entry.state !== 'downloading') return;
    entry.state = state;
    if (reason) entry.reason = reason;
    if (state !== 'done') this.#removeFile(entry);
    clearTimeout(entry.expire);
    entry.expire = setTimeout(() => this.#forget(entry), BROWSER_DOWNLOAD_KEEP_MS);
    entry.expire.unref?.();
    this.#wake();
  }

  #wake(): void { for (const wake of [...this.#waiters]) wake(); }

  #forget(entry: Entry): void {
    clearTimeout(entry.expire);
    this.#entries.delete(entry.id); this.#byGuid.delete(entry.guid);
    if (entry.state === 'downloading') void this.#cancel(entry.engine, entry.guid);
    this.#removeFile(entry);
  }

  #removeFile(entry: Entry): void {
    this.#remove(entry.path);
    this.#remove(`${entry.path}.crdownload`);
  }

  #remove(path: string): void {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { this.log(`could not remove the browser download ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  #of(threadId: ThreadId, id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry || entry.threadId !== threadId) throw refused(`no download ${id} in this conversation; browser downloads lists them`);
    return entry;
  }

  #public(entry: Entry): BrowserDownload {
    const { threadId: _thread, guid: _guid, engine: _engine, path: _path, seq: _seq, expire: _expire, ...shown } = entry;
    return shown;
  }

  list(threadId: ThreadId): BrowserDownload[] {
    return [...this.#entries.values()].filter(entry => entry.threadId === threadId).map(entry => this.#public(entry));
  }

  /** Downloads of the conversation that began after `seq`. */
  since(threadId: ThreadId, seq: number): BrowserDownload[] {
    return [...this.#entries.values()].filter(entry => entry.threadId === threadId && entry.seq > seq).map(entry => this.#public(entry));
  }

  /** Resolves once a download began after `seq` or `ms` passed: a navigation to a file answers before its download is listed. */
  async began(threadId: ThreadId, seq: number, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (!this.since(threadId, seq).length && Date.now() < until) await this.#next(until - Date.now());
  }

  async wait(threadId: ThreadId, id: string, ms: number): Promise<BrowserDownload> {
    const until = Date.now() + ms;
    while (this.#of(threadId, id).state === 'downloading' && Date.now() < until) await this.#next(until - Date.now());
    return this.#public(this.#of(threadId, id));
  }

  #next(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      this.#waiters.add(done);
    });
  }

  read(threadId: ThreadId, id: string, offset: number, maxBytes: number): { base64: string; nextOffset: number; done: boolean; bytes: number; sha256: string } {
    const entry = this.#of(threadId, id);
    if (entry.state !== 'done') throw refused(entry.state === 'downloading' ? `download ${id} is still running (${entry.bytes} bytes so far); browser download wait ${id}` : `download ${id} ${entry.state}${entry.reason ? `: ${entry.reason}` : ''}`);
    if (offset > entry.bytes) throw refused(`download ${id} holds ${entry.bytes} bytes`);
    const buffer = Buffer.alloc(Math.min(maxBytes, entry.bytes - offset));
    const fd = openSync(entry.path, 'r');
    let read = 0;
    try { while (read < buffer.length) { const count = readSync(fd, buffer, read, buffer.length - read, offset + read); if (count <= 0) break; read += count; } }
    finally { closeSync(fd); }
    const nextOffset = offset + read;
    return { base64: buffer.subarray(0, read).toString('base64'), nextOffset, done: nextOffset === entry.bytes, bytes: entry.bytes, sha256: entry.sha256! };
  }

  discard(threadId: ThreadId, id: string): void {
    this.#forget(this.#of(threadId, id));
  }

  /** The conversation was archived or removed: its files go. */
  release(threadId: ThreadId): void {
    for (const entry of [...this.#entries.values()]) if (entry.threadId === threadId) this.#forget(entry);
  }

  /** The browser ended: what it was still downloading will never finish. */
  lost(engine: Engine): void {
    for (const entry of this.#entries.values()) if (entry.engine === engine) this.#end(entry, 'failed', 'the browser closed before it finished');
  }

  close(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.expire);
    this.#entries.clear(); this.#byGuid.clear(); this.#wake();
    if (this.#swept) this.#remove(this.dir);
  }
}

interface Progress { receivedBytes: number; totalBytes: number; state: 'inProgress' | 'completed' | 'canceled'; filePath?: string }
