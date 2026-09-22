import { type GitChange, type GitDiff } from '@boite/contracts';

/** What `projects.files` names for any project of the seed: a small repository's tree. */
export const FAKE_FILES = [
  'README.md',
  'package.json',
  'src/main.ts',
  'src/app.css',
  'src/App.svelte',
  'src/lib/store.svelte.ts',
  'src/lib/strings.ts',
  'src/lib/client.ts',
  'src/components/Composer.svelte',
  'src/components/Sidebar.svelte',
  'docs/development.md',
  'docs/providers.md',
  'tests/e2e/ui.test.ts'
];

/**
 * The core's ranking in short: the file's own name first, prefix over
 * substring, then the whole path, ties to the shorter path.
 */
export function scoreFakeFile(query: string, path: string): number {
  const word = query.toLowerCase();
  if (word.length === 0) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (name.startsWith(word)) return 80;
  if (name.includes(word)) return 60;
  if (lower.includes(word)) return 40;
  return 0;
}

// ---------------------------------------------------------------------------
// The workbench: what the changes, files and tasks surfaces read. One working
// tree, small enough to hold in a file and wide enough to draw every badge.
// ---------------------------------------------------------------------------

/** One row per `GitChangeStatus`, so the changes list draws all seven marks. */
export const FAKE_CHANGES: GitChange[] = [
  { path: 'src/components/RightPanel.svelte', status: 'modified', oldPath: null, staged: false, additions: 84, deletions: 12 },
  { path: 'src/components/ChangesSurface.svelte', status: 'added', oldPath: null, staged: true, additions: 196, deletions: 0 },
  { path: 'src/components/TracePanel.svelte', status: 'deleted', oldPath: null, staged: true, additions: 0, deletions: 141 },
  { path: 'docs/panel.md', status: 'renamed', oldPath: 'docs/right-panel.md', staged: true, additions: 9, deletions: 2 },
  { path: 'src/lib/panel-layout.ts', status: 'copied', oldPath: 'src/lib/right-panel.svelte.ts', staged: false, additions: 31, deletions: 0 },
  { path: 'docs/panel.svg', status: 'untracked', oldPath: null, staged: false, additions: null, deletions: null },
  { path: 'src/lib/store.svelte.ts', status: 'conflict', oldPath: null, staged: false, additions: 26, deletions: 4 }
];

/**
 * The sides `git.diff` answers with. A picture is binary and carries no text, a
 * file that was added has no old side, one that was deleted has no new one, and
 * the conflicted file comes back cut so the truncation notice is drawn too.
 */
export const FAKE_DIFFS: Record<string, Pick<GitDiff, 'oldText' | 'newText' | 'binary' | 'truncated'>> = {
  'src/components/RightPanel.svelte': {
    oldText: [
      '{#if active?.kind === "trace"}',
      '  <TraceSurface {store} />',
      '{:else}',
      '  <BrowserSurface surface={active} {panel} />',
      '{/if}'
    ].join('\n'),
    newText: [
      '{#if active?.kind === "trace"}',
      '  <TraceSurface {store} />',
      '{:else if active?.kind === "changes"}',
      '  <ChangesSurface {store} surface={active} {panel} />',
      '{:else if active?.kind === "tasks"}',
      '  <TasksSurface {store} />',
      '{:else}',
      '  <BrowserSurface surface={active} {panel} />',
      '{/if}'
    ].join('\n'),
    binary: false,
    truncated: false
  },
  'src/components/ChangesSurface.svelte': {
    oldText: null,
    newText: [
      '<script lang="ts">',
      '  let { store, surface, panel } = $props();',
      '</script>',
      '',
      '<div class="changes-surface" data-testid="changes-panel"></div>'
    ].join('\n'),
    binary: false,
    truncated: false
  },
  'src/components/TracePanel.svelte': {
    oldText: [
      '<script lang="ts">',
      '  // The trace had its own panel before the workbench took the slot.',
      '  let { store } = $props();',
      '</script>'
    ].join('\n'),
    newText: null,
    binary: false,
    truncated: false
  },
  'docs/panel.svg': { oldText: null, newText: null, binary: true, truncated: false },
  'src/lib/store.svelte.ts': {
    oldText: ['export class Store {', '  todos = $state({});', '}'].join('\n'),
    newText: [
      'export class Store {',
      '  todos = $state<Record<ProjectId, Todo[]>>({});',
      '',
      '  async loadTodos(threadId: ThreadId) {',
      '    const todos = await this.#client.call("todos.list", { threadId });',
      '  }',
      '}'
    ].join('\n'),
    binary: false,
    truncated: true
  }
};

/**
 * The one file long enough that the editor has something to scroll, and the
 * one `panel.open` sends a line of. Eighty-odd lines of plausible source.
 */
const FAKE_STORE_SOURCE = `import type { FileContent, FileEntry, ThreadId } from '@boite/contracts';
import { RpcFailure } from './client';
import { rightPanel } from './right-panel.svelte';

/** What one files call answers with: the value, or what the surface prints. */
export type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

interface Cached {
  entries: FileEntry[];
  readAt: number;
}

const CACHE_MS = 2_000;

export class Workbench {
  #client: Client | null = null;
  #cache = new Map<string, Cached>();
  #reads = new Map<string, Promise<FileContent>>();

  attach(client: Client): void {
    this.#client = client;
    this.#cache.clear();
    this.#reads.clear();
  }

  /** One directory, from the cache when it was read a moment ago. */
  async list(threadId: ThreadId, path: string): Promise<Answer<FileEntry[]>> {
    const client = this.#client;
    if (client === null) return { ok: false, error: 'no core' };
    const key = threadId + ':' + path;
    const cached = this.#cache.get(key);
    if (cached !== undefined && Date.now() - cached.readAt < CACHE_MS) {
      return { ok: true, value: cached.entries };
    }
    try {
      const entries = await client.call('files.list', { threadId, path });
      this.#cache.set(key, { entries, readAt: Date.now() });
      return { ok: true, value: entries };
    } catch (error) {
      return { ok: false, error: this.#message(error) };
    }
  }

  /** One file. Two tabs asking at once share the call that is already out. */
  async read(threadId: ThreadId, path: string): Promise<Answer<FileContent>> {
    const client = this.#client;
    if (client === null) return { ok: false, error: 'no core' };
    const key = threadId + ':' + path;
    const running = this.#reads.get(key);
    if (running !== undefined) return { ok: true, value: await running };
    const call = client.call('files.read', { threadId, path });
    this.#reads.set(key, call);
    try {
      return { ok: true, value: await call };
    } catch (error) {
      return { ok: false, error: this.#message(error) };
    } finally {
      this.#reads.delete(key);
    }
  }

  /** The editor's save. The directory it sits in is read again after it. */
  async write(threadId: ThreadId, path: string, text: string): Promise<Answer<number>> {
    const client = this.#client;
    if (client === null) return { ok: false, error: 'no core' };
    try {
      const written = await client.call('files.write', { threadId, path, text });
      this.forget(threadId, directoryOf(path));
      return { ok: true, value: written.bytes };
    } catch (error) {
      return { ok: false, error: this.#message(error) };
    }
  }

  /** A directory whose contents changed under us: the next list asks the core. */
  forget(threadId: ThreadId, path: string): void {
    this.#cache.delete(threadId + ':' + path);
  }

  #message(error: unknown): string {
    if (error instanceof RpcFailure) return error.message + ' (' + error.code + ')';
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

/** The directory a path sits in, forward slashes the way the core writes them. */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

export const workbench = new Workbench();

// The panel asks for the surface, the surface asks this, and nothing in the
// tree ever touches the browser's own file system.
rightPanel.onOpen(() => workbench.attach(client));
`;

/**
 * The tree `files.list` walks and `files.read` answers from: three levels, a
 * file per kind the viewer draws, and one source file long enough to scroll.
 */
export const FAKE_TREE: Record<string, string> = {
  'README.md': ['# boite', '', 'The workbench sits beside the thread, one tab per surface.', ''].join('\n'),
  'package.json': ['{', '  "name": "boite",', '  "private": true', '}', ''].join('\n'),
  'docs/panel.md': [
    '# The panel',
    '',
    'Every thread owns its strip of surfaces: trace, changes, files, tasks.',
    '',
    '| Surface | Tab      | What it reads              |',
    '| ------- | -------- | -------------------------- |',
    '| Changes | one      | `git.status` of the cwd    |',
    '| Files   | one      | `files.list`, lazily       |',
    '| File    | per path | `files.read`, `files.write`|',
    ''
  ].join('\n'),
  'docs/guide/editor.md': [
    '# The editor',
    '',
    'Tab writes two spaces. Ctrl+S saves. A file cut at its size limit is read only.',
    ''
  ].join('\n'),
  'docs/guide/tree.md': [
    '# The tree',
    '',
    'One directory per call, on the expand. The arrows walk, Enter opens.',
    ''
  ].join('\n'),
  'src/app.css': [':root {', '  --row: 34px;', '  --control-sm: 26px;', '}', ''].join('\n'),
  'src/main.ts': [
    "import { mount } from 'svelte';",
    "import App from './App.svelte';",
    '',
    'mount(App, { target: document.body });',
    ''
  ].join('\n'),
  'src/lib/panel-layout.ts': ['export const PANEL_DEFAULT = 360;', 'export const PANEL_MIN = 300;', ''].join('\n'),
  'src/lib/store.svelte.ts': FAKE_STORE_SOURCE,
  'src/lib/strings.ts': [
    'export const strings = {',
    "  save: 'Save',",
    "  fit: 'Fit'",
    '};',
    ''
  ].join('\n'),
  'src/components/RightPanel.svelte': [
    '<script lang="ts">',
    '  let { store, panel } = $props();',
    '</script>',
    '',
    '<aside class="panel" data-testid="right-panel"></aside>',
    ''
  ].join('\n'),
  'src/components/surfaces/FilesSurface.svelte': [
    '<script lang="ts">',
    '  let { store, surface, panel } = $props();',
    '</script>',
    ''
  ].join('\n'),
  'src/components/surfaces/FileSurface.svelte': [
    '<script lang="ts">',
    '  let { store, surface } = $props();',
    '</script>',
    ''
  ].join('\n'),
  'tests/e2e/panel.test.ts': [
    "import { expect, test } from 'bun:test';",
    '',
    "test('the tree expands a directory', async () => {",
    '  expect(true).toBe(true);',
    '});',
    ''
  ].join('\n')
};

/** The one picture of the tree, a data url so a capture needs no server. */
const FAKE_IMAGE_PATH = 'docs/panel.svg';

const FAKE_IMAGE_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMjQwIDEyMCI+PHJlY3Qgd2lkdGg9IjI0MCIgaGVpZ2h0PSIxMjAiIHJ4PSIxMiIgZmlsbD0iIzFmMjkzNyIvPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxNiIgcng9IjQiIGZpbGw9IiM2MGE1ZmEiLz48cmVjdCB4PSIxNiIgeT0iNDQiIHdpZHRoPSIyMDgiIGhlaWdodD0iMTAiIHJ4PSI0IiBmaWxsPSIjNGI1NTYzIi8+PHJlY3QgeD0iMTYiIHk9IjY0IiB3aWR0aD0iMTc2IiBoZWlnaHQ9IjEwIiByeD0iNCIgZmlsbD0iIzRiNTU2MyIvPjxyZWN0IHg9IjE2IiB5PSI4NCIgd2lkdGg9Ijk2IiBoZWlnaHQ9IjEwIiByeD0iNCIgZmlsbD0iIzM0ZDM5OSIvPjwvc3ZnPg==';

const FAKE_IMAGE_BYTES = 612;

/** The bytes behind a data url, which is what the core would report as the size. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const payload = url.slice(comma + 1);
  if (!url.slice(0, comma).includes(';base64')) return payload.length;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function base64(bytes: Uint8Array): string {
  let raw = '';
  // One chunk at a time: a whole buffer spread into `fromCharCode` overflows
  // the argument list well before a picture is large.
  for (let at = 0; at < bytes.length; at += 4096) {
    raw += String.fromCharCode(...bytes.subarray(at, at + 4096));
  }
  return btoa(raw);
}

/**
 * The picture the image viewer is looked at on: 640 by 400, drawn once on a
 * canvas so zooming into it shows something. jsdom draws nothing, so the SVG
 * beside it stands in there and a test still gets a url.
 */
let drawnPng: string | null = null;

function fakePng(): string {
  if (drawnPng !== null) return drawnPng;
  drawnPng = FAKE_IMAGE_URL;
  // jsdom has no canvas and says so loudly on every call, so the probe is a
  // thing only a real browser carries rather than the drawing itself.
  if (typeof OffscreenCanvas === 'undefined') return drawnPng;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 400;
    const paint = canvas.getContext('2d');
    if (paint === null) return drawnPng;
    const sky = paint.createLinearGradient(0, 0, 640, 400);
    sky.addColorStop(0, '#0f172a');
    sky.addColorStop(0.55, '#3730a3');
    sky.addColorStop(1, '#f97316');
    paint.fillStyle = sky;
    paint.fillRect(0, 0, 640, 400);
    paint.fillStyle = '#fbbf24';
    paint.beginPath();
    paint.arc(470, 120, 56, 0, Math.PI * 2);
    paint.fill();
    paint.fillStyle = 'rgba(15, 23, 42, 0.85)';
    paint.beginPath();
    paint.moveTo(0, 400);
    paint.lineTo(180, 210);
    paint.lineTo(320, 330);
    paint.lineTo(430, 240);
    paint.lineTo(640, 400);
    paint.closePath();
    paint.fill();
    paint.strokeStyle = '#34d399';
    paint.lineWidth = 6;
    paint.strokeRect(24, 24, 592, 352);
    paint.fillStyle = '#e2e8f0';
    paint.font = '600 34px sans-serif';
    paint.fillText('640 x 400', 48, 82);
    const url = canvas.toDataURL('image/png');
    if (url.startsWith('data:image/png')) drawnPng = url;
  } catch {
    /* no canvas here: the SVG above is the picture */
  }
  return drawnPng;
}

/**
 * Four tenths of a second of a 440 Hz tone, written as a RIFF file. A real
 * WebM would need an encoder, so the fake has a sound and no video; the video
 * branch of the viewer is the same native element with another mime.
 */
let recordedWav: string | null = null;

function fakeWav(): string {
  if (recordedWav !== null) return recordedWav;
  const rate = 8000;
  const samples = Math.round(rate * 0.4);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) {
    // Faded at both ends, so the tone neither clicks in nor clicks out.
    const fade = Math.min(1, Math.min(index, samples - index) / (rate * 0.05));
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 9000 * fade), true);
  }
  recordedWav = `data:audio/wav;base64,${base64(bytes)}`;
  return recordedWav;
}

/** The blob of the tree: a one-page PDF, which the viewer offers to download. */
let printedPdf: string | null = null;

function fakePdf(): string {
  if (printedPdf !== null) return printedPdf;
  const source = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    ''
  ].join('\n');
  printedPdf = `data:application/pdf;base64,${btoa(source)}`;
  return printedPdf;
}

/** Everything of the tree that is not text, each one answered as a url. */
export const FAKE_MEDIA: Record<string, { kind: 'image' | 'video' | 'audio' | 'binary'; mime: string; url: () => string }> = {
  [FAKE_IMAGE_PATH]: { kind: 'image', mime: 'image/svg+xml', url: () => FAKE_IMAGE_URL },
  'assets/preview.png': { kind: 'image', mime: 'image/png', url: fakePng },
  'assets/chime.wav': { kind: 'audio', mime: 'audio/wav', url: fakeWav },
  'assets/handbook.pdf': { kind: 'binary', mime: 'application/pdf', url: fakePdf }
};

export const FAKE_MEDIA_PATHS = Object.keys(FAKE_MEDIA);

/** What one entry of the tree weighs, text or not. */
export function fakeBytes(path: string, text: string | undefined): number {
  if (path === FAKE_IMAGE_PATH) return FAKE_IMAGE_BYTES;
  const media = FAKE_MEDIA[path];
  if (media) return dataUrlBytes(media.url());
  return text?.length ?? 0;
}

/** What the editor colours a file with, by the only thing the core has: the extension. */
export function fakeLanguage(path: string): string | null {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  const known: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    svelte: 'svelte',
    md: 'markdown',
    json: 'json',
    css: 'css',
    html: 'html'
  };
  return known[extension] ?? null;
}
