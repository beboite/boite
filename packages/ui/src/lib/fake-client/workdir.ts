/** A thread's working directory: files, git, the panel and published artifacts. */
import { PANEL_SURFACE_KINDS, RpcErrorCode, type FileContent, type FileEntry, type GitDiff, type GitStatus, type Message, type PanelSurface } from '@boite/contracts';
import { RpcFailure } from '../client';
import { FAKE_CHANGES, FAKE_DIFFS, FAKE_MEDIA, FAKE_MEDIA_PATHS, fakeBytes, fakeLanguage } from './files';
import { refusal, T0 } from './shared';
import type { FakeContext, FakeMethods } from './context';

/** A stable time per path, so two runs of a capture read the same tree. */
function fileTime(ctx: FakeContext, path: string): number {
  const index = [...ctx.files.keys(), ...FAKE_MEDIA_PATHS].indexOf(path);
  return T0 - Math.max(0, index) * 3_600_000;
}

/** One directory of the fixture tree, directories first, then files by name. */
function listDir(ctx: FakeContext, path: string): FileEntry[] {
  const prefix = path === '' ? '' : `${path.replace(/[\\/]+$/, '')}/`;
  const dirs = new Set<string>();
  const files: FileEntry[] = [];
  for (const full of [...ctx.files.keys(), ...FAKE_MEDIA_PATHS]) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut >= 0) {
      dirs.add(rest.slice(0, cut));
      continue;
    }
    files.push({
      name: rest,
      path: full,
      kind: 'file',
      bytes: fakeBytes(full, ctx.files.get(full)),
      modifiedAt: fileTime(ctx, full)
    });
  }
  const byName = (a: FileEntry, b: FileEntry): number => a.name.localeCompare(b.name);
  return [
    ...[...dirs]
      .map((name): FileEntry => ({ name, path: `${prefix}${name}`, kind: 'dir', bytes: null, modifiedAt: T0 }))
      .sort(byName),
    ...files.sort(byName)
  ];
}

function isDirPath(ctx: FakeContext, path: string): boolean {
  if (path === '') return true;
  const prefix = `${path}/`;
  return [...ctx.files.keys(), ...FAKE_MEDIA_PATHS].some((full) => full.startsWith(prefix));
}

/**
 * The core's `resolveInside`, and `existingInside` when `expect` is given,
 * over the fake tree: a path relative to the thread's directory or absolute
 * inside it, never out of it, answered in the relative form with forward
 * slashes the core answers with.
 */
function inside(ctx: FakeContext, cwd: string, path: unknown, what: string, expect?: 'file' | 'dir'): string {
  if (typeof path !== 'string') throw refusal(`${what} must be a path, got ${typeof path}`);
  const root = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  let rest = path.replace(/\\/g, '/');
  if (/^([a-z]:)?\//i.test(rest)) {
    if (rest.toLowerCase() !== root.toLowerCase() && !rest.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      throw refusal(`${what} leaves the thread's working directory: ${path}`);
    }
    rest = rest.slice(root.length);
  }
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) throw refusal(`${what} leaves the thread's working directory: ${path}`);
  }
  const relative = parts.join('/');
  if (expect === undefined) return relative;
  const isFile = ctx.files.has(relative) || FAKE_MEDIA[relative] !== undefined;
  const isDir = isDirPath(ctx, relative);
  if (!isFile && !isDir) throw refusal(`${what} does not exist: ${path}`);
  if (expect === 'file' && !isFile) throw refusal(`${what} is not a file: ${path}`);
  if (expect === 'dir' && !isDir) throw refusal(`${what} is not a directory: ${path}`);
  return relative;
}

/**
 * The core's `checkSurface` in `agent.ts`: a file that is there, a directory
 * that is, a diff path inside the directory, an http or https url, and the
 * relative path every client compares tabs by.
 */
function checkSurface(ctx: FakeContext, cwd: string, surface: PanelSurface): PanelSurface {
  const kind = (surface as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind !== 'string' || !(PANEL_SURFACE_KINDS as readonly string[]).includes(kind)) {
    throw refusal(`panel.open does not know the surface ${String(kind)}`);
  }
  const path = (surface as { path?: unknown }).path;
  if (kind === 'file') {
    if (typeof path !== 'string' || path.length === 0) throw refusal('panel.open file needs a path');
    const found = inside(ctx, cwd, path, 'panel.open file path', 'file');
    const line = (surface as { line?: unknown }).line;
    if (line === undefined || line === null) return { kind, path: found };
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw refusal(`panel.open line must be a line number, got ${String(line)}`);
    }
    return { kind, path: found, line };
  }
  if (kind === 'files') {
    if (path === undefined || path === null) return { kind };
    return { kind, path: inside(ctx, cwd, path, 'panel.open files path', 'dir') };
  }
  if (kind === 'diff') {
    // A diff names a file that may be gone from the working tree.
    if (path === undefined || path === null) return { kind };
    return { kind, path: inside(ctx, cwd, path, 'panel.open diff path') };
  }
  if (kind === 'browser') {
    const url = (surface as { url?: unknown }).url;
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw refusal(`panel.open browser needs a url, got ${String(url)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw refusal(`panel.open browser takes http or https, not ${parsed.protocol.replace(':', '')}`);
    }
    return { kind, url: parsed.href };
  }
  return { kind: kind as 'trace' | 'tasks' };
}

export function workdirMethods(ctx: FakeContext) {
  return {
    'artifacts.publish': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refusal('artifacts.publish needs an active thread');
      const turn = thread.turns.at(-1);
      if (!turn) throw refusal('artifacts.publish needs a thread with a turn');
      const path = inside(ctx, thread.cwd, params.path, 'artifacts.publish path', 'file');
      const media = FAKE_MEDIA[path];
      const body = media ? new Uint8Array(await (await fetch(media.url())).arrayBuffer()) : new TextEncoder().encode(ctx.files.get(path) ?? '');
      if (body.length > 5 * 1024 * 1024) throw refusal('artifacts.publish file must be at most 5 MB');
      if (thread.archived) throw refusal('artifacts.publish needs an active thread');
      let binary = '';
      for (const byte of body) binary += String.fromCharCode(byte);
      const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: ctx.now(), parts: [{ type: 'file', name: path.split('/').at(-1) ?? path, mimeType: media?.mime ?? 'application/octet-stream', data: btoa(binary) }] };
      thread.messages.push(message);
      ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
      ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
      return structuredClone(message);
    },
    'panel.open': async (params) => {
      const thread = ctx.thread(params.threadId);
      const surface = checkSurface(ctx, thread.cwd, params.surface);
      // The core sends this to every client subscribed to the thread, and
      // `shown` says whether there was one to receive it.
      const shown = ctx.bus.subscribed.has(thread.id);
      ctx.emitToThread(thread.id, 'panel.requested', {
        threadId: thread.id,
        surface,
        at: ctx.now()
      });
      return { shown };
    },
    'git.status': async (params) => {
      const thread = ctx.thread(params.threadId);
      const branch = thread.branch ?? 'main';
      const status: GitStatus = {
        branch,
        upstream: `origin/${branch}`,
        ahead: 2,
        behind: 1,
        changes: structuredClone(FAKE_CHANGES)
      };
      return status;
    },
    'git.diff': async (params) => {
      const path = inside(ctx, ctx.thread(params.threadId).cwd, params.path, 'git.diff path');
      const change = FAKE_CHANGES.find((one) => one.path === path);
      if (!change) throw ctx.notFound('change', path);
      const sides = FAKE_DIFFS[path] ?? {
        // A row with no fixture of its own still opens on two readable sides.
        oldText: `// ${path}
const ready = false;
`,
        newText: `// ${path}
const ready = true;
`,
        binary: false,
        truncated: false
      };
      const diff: GitDiff = { path: change.path, oldPath: change.oldPath, status: change.status, ...sides };
      return diff;
    },
    'files.list': async (params) => {
      const cwd = ctx.thread(params.threadId).cwd;
      return listDir(ctx, inside(ctx, cwd, params.path ?? '', 'files.list path', 'dir'));
    },
    'files.read': async (params) => {
      const path = inside(ctx, ctx.thread(params.threadId).cwd, params.path, 'files.read path', 'file');
      // A picture, a sound and anything else binary answer as a url, the way
      // the core hands out a ticket, except that these carry their own bytes.
      const media = FAKE_MEDIA[path];
      if (media) {
        const url = media.url();
        const blob: FileContent = {
          kind: media.kind,
          path,
          bytes: fakeBytes(path, undefined),
          modifiedAt: fileTime(ctx, path),
          mime: media.mime,
          url
        };
        return blob;
      }
      const text = ctx.files.get(path) ?? '';
      const content: FileContent = {
        kind: 'text',
        path,
        bytes: text.length,
        modifiedAt: fileTime(ctx, path),
        text,
        truncated: false,
        language: fakeLanguage(path)
      };
      return content;
    },
    'files.write': async (params) => {
      const cwd = ctx.thread(params.threadId).cwd;
      const path = inside(ctx, cwd, params.path, 'files.write path');
      // The file may be new, its directory may not, and what is there already has to be a file.
      inside(ctx, cwd, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', 'files.write path directory', 'dir');
      if (isDirPath(ctx, path)) throw refusal(`files.write path is not a file: ${params.path}`);
      if (FAKE_MEDIA[path]) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this file is not text' });
      }
      ctx.files.set(path, params.text);
      return { bytes: params.text.length, modifiedAt: ctx.now() };
    },
  } satisfies Partial<FakeMethods>;
}
