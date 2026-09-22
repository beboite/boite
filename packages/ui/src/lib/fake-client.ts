import {
  DEFAULT_DELEGATION_CONFIG,
  KEYBINDING_COMMANDS,
  parseChord,
  type Keybindings,
  MESSAGE_PAGE,
  MESSAGE_PAGE_MAX,
  PANEL_SURFACE_KINDS,
  PROTOCOL_VERSION,
  RpcErrorCode,
  TODO_STATUSES,
  TODO_TEXT_MAX,
  type Account,
  type AccountQuota,
  type AgentCommand,
  type AgentTask,
  type AgentWhere,
  type AgentLetter,
  type CoordinationConfig,
  type CoordinationPeer,
  type CoordinationView,
  type DelegatedAgent,
  type DelegationConfig,
  type DelegationProfile,
  type DelegationView,
  type PluginManifest,
  type PluginPreview,
  type PluginState,
  type PluginPool,
  type CoreInfo,
  type FileContent,
  type FileEntry,
  type GitChange,
  type GitDiff,
  type GitStatus,
  type Attachment,
  attachmentError,
  type ImportableSession,
  type Message,
  type MessageId,
  type MessagePart,
  type ModelInfo,
  type PairedSession,
  type PanelSurface,
  type PermissionRequest,
  type Principal,
  type QuestionAnswer,
  type QuestionRequest,
  type ProcessRecord,
  type Project,
  type HarnessUpdate,
  type ProviderInstallState,
  type ProviderSummary,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type SchedulerState,
  type Settings,
  type SpeechConfig,
  type SpeechStatus,
  type Thread,
  type ThreadId,
  type ThreadResources,
  type ThreadActivity,
  type ThreadStatus,
  type ThreadSummary,
  type Todo,
  type ToolDocument,
  type Turn,
  type Usage
} from '@boite/contracts';
import { decodedBytes } from './attachments';
import { RpcFailure, type ClientState, type EventHandler, type ObservableClient } from './client';
import { fakeUsageHistory, type FakeFinishedTurn } from './fake-usage';

export interface FakeClientOptions {
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
  /** A fresh machine with no agents or accounts, for the setup flow. */
  uninstalled?: boolean;
  /** Adds a deterministic active team for visual checks on `?fake=1&team=1`. */
  delegationDemo?: boolean;
  /** Who this client is. `'session'` makes it a paired phone, refused like one. */
  principal?: Principal;
  /** Stable public identity for multi-machine coordination tests. */
  coreId?: string;
  coreName?: string;
  publicUrl?: string;
}

/*
 * The device boundary, copied. `packages/core/src/access.ts` owns it, and the
 * UI package cannot import the core, so this list is a mirror kept by hand: a
 * method added there and forgotten here only makes the fake stricter than the
 * core, which shows up as a test failing rather than a screen that lies.
 * `hello` is not in it because the core answers it before the router's gate.
 */
const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  'delegation.get', 'delegation.send', 'delegation.stop',
  'sessions.list',
  'push.status', 'push.subscribe', 'push.unsubscribe', 'push.test',
  'projects.list',
  'projects.files',
  'providers.list',
  'accounts.list',
  'threads.list',
  'threads.pullRequest',
  'threads.create',
  'threads.get',
  'threads.activity.set',
  'threads.activity.control',
  'messages.list',
  'threads.update',
  'threads.retitle',
  'threads.compact',
  'threads.archive',
  'threads.pin',
  'threads.markRead',
  'threads.subscribe',
  'threads.unsubscribe',
  'turns.start',
  'turns.stop',
  'permissions.list',
  'permissions.answer',
  'questions.list',
  'questions.answer',
  'scheduler.get',
  'usage.get',
  'usage.history',
  'settings.get',
  'collaboration.get',
  'collaboration.directory',
  'speech.status', 'speech.transcribe', 'speech.cancel',
  'keybindings.get'
]);

const T0 = Date.UTC(2026, 8, 5, 9, 0, 0);
const DATA_DIR = 'C:\\Users\\you\\AppData\\Local\\boite2';

/** What the echo driver reports as its `/name` list, the same two commands. */
const ECHO_COMMANDS: AgentCommand[] = [
  { name: 'shout', description: 'The prompt back in capitals', hint: '<text>' },
  { name: 'whisper', description: 'The prompt back as it came', hint: null }
];
/** The one the fake acts on: `/shout <text>` comes back in capitals. */
const SHOUT = 'shout';

/** What `projects.files` names for any project of the seed: a small repository's tree. */
const FAKE_FILES = [
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
function scoreFakeFile(query: string, path: string): number {
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
const FAKE_CHANGES: GitChange[] = [
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
const FAKE_DIFFS: Record<string, Pick<GitDiff, 'oldText' | 'newText' | 'binary' | 'truncated'>> = {
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
const FAKE_TREE: Record<string, string> = {
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
const FAKE_MEDIA: Record<string, { kind: 'image' | 'video' | 'audio' | 'binary'; mime: string; url: () => string }> = {
  [FAKE_IMAGE_PATH]: { kind: 'image', mime: 'image/svg+xml', url: () => FAKE_IMAGE_URL },
  'assets/preview.png': { kind: 'image', mime: 'image/png', url: fakePng },
  'assets/chime.wav': { kind: 'audio', mime: 'audio/wav', url: fakeWav },
  'assets/handbook.pdf': { kind: 'binary', mime: 'application/pdf', url: fakePdf }
};

const FAKE_MEDIA_PATHS = Object.keys(FAKE_MEDIA);

/** What one entry of the tree weighs, text or not. */
function fakeBytes(path: string, text: string | undefined): number {
  if (path === FAKE_IMAGE_PATH) return FAKE_IMAGE_BYTES;
  const media = FAKE_MEDIA[path];
  if (media) return dataUrlBytes(media.url());
  return text?.length ?? 0;
}

/** A refusal worded like the core's, so a screen tested here shows what the real one would. */
function refusal(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message });
}

/** The core's `checkText` in `todos.ts`: a card needs text, and a line of it. */
function todoText(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length === 0) throw refusal('a todo needs text');
  const trimmed = text.trim();
  if (trimmed.length > TODO_TEXT_MAX) {
    throw refusal(`a todo is at most ${TODO_TEXT_MAX} characters, this one is ${trimmed.length}`);
  }
  return trimmed;
}

/** What the editor colours a file with, by the only thing the core has: the extension. */
function fakeLanguage(path: string): string | null {
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

/** The managed provider of the seed: a release Boite downloads, 468 MB of it. */
const MANAGED_ID = 'antigravity';
const MANAGED_VERSION = 'agy_acp_server_1.1.1';
const MANAGED_ARCHIVE_BYTES = 468_238_392;
const MANAGED_EXE = `${DATA_DIR}\\agents\\${MANAGED_ID}\\current\\agy_acp_server.exe`;

/** The second one is already down, one version behind: that is the Update row. */
const UPDATABLE_ID = 'opencode';
const UPDATABLE_VERSION = '0.4.12';
const UPDATABLE_AVAILABLE = '0.5.0';
const UPDATABLE_ARCHIVE_BYTES = 41_268_224;

/** What one `providers.install` on that provider would fetch, and how big it is. */
const RELEASES: Record<string, { version: string; archiveBytes: number }> = {
  claude: { version: '2.1.267', archiveBytes: 220_051_616 },
  codex: { version: '0.155.1', archiveBytes: 107_573_195 },
  [MANAGED_ID]: { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES },
  [UPDATABLE_ID]: { version: UPDATABLE_AVAILABLE, archiveBytes: UPDATABLE_ARCHIVE_BYTES }
};
/** Sixteen steps of 120 ms: about two seconds of download, long enough to be seen. */
const INSTALL_STEPS = 16;
const INSTALL_STEP_MS = 120;

/** A fake plugin install ticks this many times, INSTALL_STEP_MS apart. */
const PLUGIN_STEPS = 8;
const KEBACC_RELEASE = 'https://github.com/kebab1337420/kebacc-switch/releases/download/kebacc-v2.0.1';

/** The account pool command lines the core shows, `<pool>` and `<email>` standing for the values. */
function poolCommands(executable: string): string[] {
  return [
    `${executable} list -<pool> -Json`,
    `${executable} list -<pool> -Json -Refresh`,
    `${executable} add -<pool>`,
    `${executable} switch -<pool> -Email <email> -Yes`,
    `${executable} remove -<pool> -Email <email> -Yes`
  ];
}

/**
 * Every state the Plugins page draws: the recommended one not installed yet,
 * one added from a URL and installed, one stuck mid-download, and one whose
 * installed.json the core refuses.
 */
function fakePlugins(): PluginState[] {
  const base = { platform: 'win32-x64', progress: 0, error: null, rejected: null };
  const legacy = `${DATA_DIR}\\plugins\\pool-legacy\\installed.json`;
  return [
    {
      ...base, id: 'kebacc-switcher', name: 'kebacc-switcher', origin: 'recommended',
      description: 'Save and switch Claude, Codex and Antigravity CLI logins, with quota readings for each saved account.',
      homepage: 'https://github.com/kebab1337420/kebacc-switch', version: null, availableVersion: '2.0.1', status: 'not-installed', source: null,
      artifact: { url: `${KEBACC_RELEASE}/kebacc-x86_64-pc-windows-msvc.exe`, sha256: '9edc5c3af1db76e97a9c07e2fd1c3399ad8c9db22e0ad2684a1b885e33acc538' },
      commands: poolCommands('kebacc'), pools: ['claude', 'codex', 'antigravity']
    },
    {
      ...base, id: 'seat-pool', name: 'Seat pool', origin: 'url',
      description: 'Keeps several OpenCode logins and switches the active one.',
      homepage: 'https://github.com/example/seat-pool', version: '1.4.0', availableVersion: '1.4.0', status: 'installed',
      source: { url: 'https://github.com/example/seat-pool', ref: 'v1.4.0', commit: '3f9c2a7e5b1d4c6a8e0f2b4d6c8a0e2f4b6d8c0a' },
      artifact: { url: 'https://github.com/example/seat-pool/releases/download/v1.4.0/seat-pool-win32-x64.exe', sha256: 'c41e9b0a7d3f5e2b8a6c4d1f0e9b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a' },
      commands: poolCommands('seat-pool'), pools: ['opencode']
    },
    {
      ...base, id: 'grok-seats', name: 'Grok seats', origin: 'url',
      description: 'Saves Grok CLI logins and reads the quota of each one.',
      homepage: 'https://github.com/example/grok-seats', version: null, availableVersion: '0.3.0', status: 'installing', progress: 45,
      source: { url: 'https://github.com/example/grok-seats', ref: 'HEAD', commit: '8a1c3e5f7b9d0f2a4c6e8b0d2f4a6c8e0b2d4f6a' },
      artifact: { url: 'https://github.com/example/grok-seats/releases/download/v0.3.0/grok-seats-win32-x64.exe', sha256: '0d2f4b6a8c1e3f5a7b9c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b5c7d9e2f4a' },
      commands: poolCommands('grok-seats'), pools: ['grok']
    },
    {
      ...base, id: 'pool-legacy', name: 'pool-legacy', origin: 'url', description: '', homepage: null,
      version: null, availableVersion: null, status: 'rejected', source: null, artifact: null, commands: [], pools: [],
      rejected: { file: legacy, field: 'manifest.schema', expected: '1', message: `${legacy}: manifest.schema must be 1, found number 0` }
    }
  ];
}

function fakePluginPools(): Record<string, PluginPool[]> {
  return {
    'kebacc-switcher': ['claude', 'codex', 'antigravity'].map((provider) => ({ provider, accounts: [
      { email: 'work@example.com', active: true, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 32, resetsAt: null }, { id: 'sevenDay', label: 'Weekly', usedPercent: 74, resetsAt: null }] },
      { email: 'personal@example.com', active: false, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 8, resetsAt: null }] },
    ] })),
    'seat-pool': [{ provider: 'opencode', accounts: [
      { email: 'team@example.com', active: true, checkedSecondsAgo: 42, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 18, resetsAt: null }, { id: 'sevenDay', label: 'Weekly', usedPercent: 51, resetsAt: null }] },
      { email: 'side@example.com', active: false, checkedSecondsAgo: null, windows: [] },
    ] }],
    'grok-seats': [{ provider: 'grok', accounts: [] }]
  };
}

/** Where the core would put a worktree: `<parent>/.boite-worktrees/<repo>/<slug>` on `boite/<slug>`. */
function fakeWorktree(projectPath: string, title: string, branch?: string): { branch: string; path: string } {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'thread';
  const separator = projectPath.includes('\\') ? '\\' : '/';
  const parts = projectPath.split(/[\\/]/);
  const repo = parts.pop() ?? 'repo';
  const dir = branch === undefined ? slug : branch.replace(/^boite\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    branch: branch ?? `boite/${slug}`,
    path: [...parts, '.boite-worktrees', repo, dir].join(separator)
  };
}

function toSummary(thread: Thread): ThreadSummary {
  const { messages: _messages, turns: _turns, ...rest } = thread;
  return { ...rest, lastUserMessageAt: thread.messages.filter(m => m.role === 'user').at(-1)?.createdAt ?? null };
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: 0
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsdEquivalent: (a.costUsdEquivalent ?? 0) + (b.costUsdEquivalent ?? 0)
  };
}

function chunkText(text: string, pieces: number): string[] {
  if (text.length === 0) return [''];
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const SPAWN_MARKER = /\[spawn:([^\]]+)\]/;

/** What `[tool-stream]` types one piece at a time before the parsed input lands. */
const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

/** The three tool documents, the same ones the core's echo driver produces. */
/** What the fake agent asks when a prompt mentions a question, echo's wording. */
const QUESTION_TEXT = 'Which shape should the echo take?';
const QUESTION_OPTIONS = [
  { id: 'short', label: 'Short', description: 'one line back' },
  { id: 'long', label: 'Long', description: 'the whole prompt back' }
];

const DIFF_PATH = 'src/app.ts';
const DIFF_OLD = 'export function boot() {\n  return start();\n}';
const DIFF_NEW = "export function boot() {\n  return start({ warm: true });\n  log('booted');\n}";
const DOC_TITLE = 'README.md';
const DOC_TEXT = [
  '# README',
  '- the first item',
  '- the second item',
  '```ts',
  'export const answer = 42;',
  '```'
].join('\n');
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The questions the four-hundred-message thread repeats, so heights vary down the list. */
const LONG_ASKS = [
  'Where does the scheduler decide a turn may start?',
  'Read the descriptor loader and tell me what it refuses',
  'Why does the shell start its own core?',
  'What does the Job Object give us that a pid list does not?',
  'Show me the part of the journal that survives a crash'
];

/** The answers beside them, of deliberately uneven length. */
const LONG_ANSWERS = [
  'In `packages/core/src/scheduler.ts`: a turn leaves the queue when both caps hold, the global one and the one on its account.',
  [
    'The loader refuses four things, each with the file, the field and what was expected:',
    '',
    '- a `protocol` it does not know',
    '- a `roots` entry that resolves outside the descriptor directory',
    '- an `env` key it would have to invent a value for',
    '- a `login` block on a provider whose account is the default one',
    '',
    'Nothing is dropped in silence, which is the rule the whole module is written to.'
  ].join('\n'),
  'Because the window is a client. The core is the host, and the shell owns it through a `KILL_ON_JOB_CLOSE` job so closing the window never leaves an agent running.',
  'Exact start and exit events for every process a thread launched, grandchildren included, plus the CPU and the peak memory the kernel already counted. A pid list gives you a guess and a race.',
  [
    'The journal is SQLite in WAL mode, so the last committed write is what a restart reads:',
    '',
    '```ts',
    "db.run('PRAGMA journal_mode = WAL');",
    "db.run('PRAGMA synchronous = NORMAL');",
    '```',
    '',
    'A turn that was running when the core died comes back as `stopped`, never as `running`.'
  ].join('\n')
];

/** How long the fake agent takes to answer a probe, so the picker shows it reading. */
const PROBE_MS = 150;
/** How long the fake's `threads.retitle` takes: long enough for the menu to say it is writing. */
const RETITLE_DELAY_MS = 200;
/** How long the fake takes to read its transcripts, and to import one. */
const IMPORT_LIST_MS = 120;
/** The fake's context meter: a window, a floor on the first turn, a step per turn on top of the prompt. */
const FAKE_CONTEXT_WINDOW = 200_000;
const FAKE_CONTEXT_FLOOR = 1_200;
const FAKE_CONTEXT_PER_TURN = 600;

/**
 * What the fake ACP agent lists in the `configOptions` of a `session/new`: its
 * own models, the descriptor's `default` first, and one reasoning scale that
 * belongs to the session rather than to a model.
 */
const PROBED_EFFORT = {
  levels: [
    { id: 'think', label: 'Think' },
    { id: 'think-hard', label: 'Think hard' }
  ],
  default: 'think'
};

/**
 * A real OpenCode answers with hundreds of models across a dozen prefixes (534
 * on the machine this was written on), so the fake answers with enough of them
 * to put the picker's model column past its search threshold.
 */
const PROBED_CATALOGUE: [string, string][] = [
  ['openrouter/anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['openrouter/anthropic/claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['openrouter/openai/gpt-5-mini', 'GPT-5 Mini'],
  ['openrouter/google/gemini-3-pro', 'Gemini 3 Pro'],
  ['openrouter/meta-llama/llama-4-scout', 'Llama 4 Scout'],
  ['openrouter/deepseek/deepseek-v4', 'DeepSeek V4'],
  ['openrouter/qwen/qwen3-max', 'Qwen3 Max'],
  ['opencode/grok-code', 'Grok Code'],
  ['opencode/claude-sonnet-5', 'Claude Sonnet 5 zen'],
  ['opencode/gpt-5-codex', 'GPT-5 Codex zen'],
  ['opencode/kimi-k2', 'Kimi K2'],
  ['opencode/glm-4-7', 'GLM 4.7'],
  ['opencode/minimax-m2', 'MiniMax M2'],
  ['nvidia/nemotron-4-340b', 'Nemotron 4 340B'],
  ['nvidia/llama-3-3-nemotron-super', 'Llama 3.3 Nemotron Super'],
  ['nvidia/mistral-nemo-12b', 'Mistral Nemo 12B'],
  ['nvidia/deepseek-r2', 'DeepSeek R2'],
  ['nvidia/qwen3-coder-480b', 'Qwen3 Coder 480B'],
  ['nvidia/gpt-oss-120b', 'GPT-OSS 120B'],
  ['nvidia/phi-4-reasoning', 'Phi 4 Reasoning']
];

/** The scale the Muse probe falls back to when its model catalog lists none. */
const MUSE_EFFORT: NonNullable<ModelInfo['effort']> = {
  levels: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' }
  ],
  default: 'high'
};

const PROBED_MODELS: ModelInfo[] = [
  { id: 'default', name: 'OpenCode default', default: false, effort: PROBED_EFFORT },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: PROBED_EFFORT },
  { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex', default: false, effort: PROBED_EFFORT },
  ...PROBED_CATALOGUE.map(([id, name]): ModelInfo => ({ id, name, default: false, effort: PROBED_EFFORT }))
];

const PROBE_PROVIDERS: Pick<ProviderSummary, 'id' | 'name' | 'protocol' | 'login'>[] = [
  { id: 'codex', name: 'Codex', protocol: 'codex-appserver', login: { kind: 'command' } },
  { id: 'pi', name: 'pi', protocol: 'pi', login: false },
  { id: 'grok', name: 'Grok', protocol: 'acp', login: { kind: 'command' } },
  { id: 'muse', name: 'Muse Code', protocol: 'muse', login: { kind: 'command' } }
];

/**
 * The whole core in memory, contract-accurate: what `vite dev` uses behind
 * `?fake=1` and what every test runs against.
 */
function quietUpdates(): boolean {
  if (typeof location === 'undefined') return false;
  const query = new URLSearchParams(location.search);
  return query.get('fake') === '1' && query.get('updates') !== '1';
}

export class FakeClient implements ObservableClient {
  #telemetry: import('@boite/contracts').TelemetryState = { mode: 'basic', configured: true, pendingDeletion: false };
  static #cores = new Map<string, FakeClient>();
  #state: ClientState = 'idle';
  #handlers = new Map<string, Set<(payload: unknown) => void>>();
  #stateHandlers = new Set<(state: ClientState) => void>();
  /** What the core has this socket subscribed to: what `#emitToThread` reads. */
  #subscribed = new Set<ThreadId>();
  /** `WsClient.#subscribed`'s mirror: the ids the client itself puts back after a reconnect. */
  #clientSubscribed = new Set<ThreadId>();
  /** The calls the socket is holding, so `drop()` can reject them from underneath. */
  #pending = new Set<{ reject: (error: RpcFailure) => void }>();

  #projects: Project[] = [];
  /** The sessions Claude Code kept, each tagged with the project whose folder it sits under. */
  #importable: (ImportableSession & { projectId: string })[] = [];
  #providers: ProviderSummary[] = [];
  #modelCatalogs = new Map<string, ModelInfo[]>();
  /** Where each managed install stood before the running one started, for a cancel. */
  #installBefore = new Map<string, ProviderInstallState>();
  #accounts: Account[] = [];
  #threads = new Map<ThreadId, Thread>();
  #coordination = new Map<ThreadId, CoordinationConfig>();
  #delegationConfigs = new Map<ThreadId, DelegationConfig>();
  #delegationAgents = new Map<ThreadId, { threadId: ThreadId; profileId: string; task: string }[]>();
  #delegationLetters = new Map<ThreadId, AgentLetter[]>();
  #delegationTurns = new Map<ThreadId, number>();
  #delegationRequests = new Map<string, { fingerprint: string; threadId: ThreadId }>();
  #delegationSendRequests = new Map<string, { fingerprint: string; letter: AgentLetter }>();
  #letters = new Map<ThreadId, AgentLetter[]>();
  #peers = new Map<string, CoordinationPeer>();
  #identity: CoordinationPeer;
  #activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #activityTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number }>();
  #activityGenerations = new Map<string, number>();
  #processes: ProcessRecord[] = [];
  #usage = new Map<ThreadId, Usage>();
  /** Turns this session finished, added to the seeded ledger `usage.history` draws. */
  #finished: FakeFinishedTurn[] = [];
  #usageSeeded = true;
  /** The project todo lists, every thread of a project reading the same cards. */
  #todos: Todo[] = [];
  /** The working tree `files.list`, `files.read` and `files.write` share. */
  #files = new Map<string, string>(Object.entries(FAKE_TREE));
  #settings: Settings;
  #speech: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
  #speechStatus: SpeechStatus = { revision: 'fake-voice', engine: 'local', ready: true, localReady: true, groqKeySet: false, openrouterKeySet: false, installing: false, downloadedBytes: 0, totalBytes: 190085487, error: null, canInstallRuntime: true };
  #speechRequests = new Map<string, symbol>();
  /** A file with one moved chord, one taken away, and one line the core refused. */
  #keybindings: Keybindings = {
    path: `${DATA_DIR}\\keybindings.json`,
    bindings: { 'theme-light': 'mod+shift+l', panel: null },
    errors: ['keybindings.json: "trace": "t" has no modifier: a chord needs mod, ctrl, alt or meta before its key']
  };
  #quotaEnabled: Record<string, boolean> = {};
  #plugins: PluginState[] = fakePlugins();
  #pluginPools: Record<string, PluginPool[]> = fakePluginPools();
  #pluginPreviews = new Map<string, PluginPreview>();
  /** Bumped by cancel and uninstall, so a fake install in flight stops where it is. */
  #pluginRuns = new Map<string, number>();
  #scheduler: SchedulerState;
  #core: CoreInfo;
  /** One phone already paired, so the devices list has a row to revoke. */
  #sessions: PairedSession[] = [
    { id: 'ses-phone', client: { name: 'pwa', version: '2.0.0-beta.1' }, role: 'device', createdAt: T0, lastSeenAt: T0 + 600_000, current: false },
    { id: 'ses-laptop', client: { name: 'shell', version: '2.0.0-beta.1' }, role: 'owner', createdAt: T0, lastSeenAt: T0 + 300_000, current: false }
  ];

  /** The request itself is kept beside its resolver, which is what `permissions.list` answers with. */
  #pendingPermissions = new Map<
    string,
    { request: PermissionRequest; resolve: (decision: 'allow' | 'deny') => void }
  >();
  /** Same shape for the questions: the request kept beside what settles it. */
  #pendingQuestions = new Map<
    string,
    { request: QuestionRequest; resolve: (answer: QuestionAnswer | null) => void }
  >();
  #inFlight = new Map<ThreadId, { cancelled: boolean; done: Promise<void> }>();
  /** The current output of every active fake login, also returned after reconnect. */
  #logins = new Map<string, RpcEvents['account.login']>();
  #seq = 0;
  #turnRequests = new Map<string, { content: string; turn: Turn }>();
  #delayMs: number;
  #long: boolean;
  #principal: Principal;

  constructor(options: FakeClientOptions = {}) {
    this.#delayMs = options.delayMs ?? 18;
    this.#long = options.long ?? false;
    this.#principal = options.principal ?? 'owner';
    const coreId = options.coreId ?? `fake-core-${crypto.randomUUID()}`;
    this.#identity = {
      coreId,
      name: options.coreName ?? 'This PC',
      url: options.publicUrl ?? 'http://127.0.0.1:8777',
      publicKey: `fake-public-key-${coreId}`
    };
    FakeClient.#cores.set(coreId, this);
    this.#settings = {
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 5,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
      focusGuard: true,
      muteAgents: true,
      autoUpdateHarnesses: false
    };
    this.#core = {
      version: '2.0.0-beta.1',
      protocolVersion: PROTOCOL_VERSION,
      os: 'windows',
      channel: 'stable',
      pid: 4242,
      startedAt: T0,
      endpoint: { host: '127.0.0.1', port: 8777 },
      dataDir: DATA_DIR,
      trace: {
        os: 'windows',
        mode: 'events',
        note: 'Job object completion port: every process this thread launched is reported exactly, including the ones its children launched.'
      }
    };
    this.#scheduler = {
      maxConcurrentTurns: this.#settings.maxConcurrentTurns,
      perAccountConcurrency: this.#settings.perAccountConcurrency,
      running: [],
      queued: []
    };
    this.#seed();
    if (options.delegationDemo) this.#seedDelegationDemo();
    if (options.uninstalled) {
      this.#providers = this.#providers.filter(provider => provider.id !== 'echo').map(provider => ({
        ...provider, available: false, executable: null,
        install: RELEASES[provider.id] ? { state: 'absent', ...RELEASES[provider.id]! } : null,
      }));
      this.#accounts = [];
      this.#threads.clear();
      this.#importable = [];
      this.#pendingPermissions.clear();
      this.#pendingQuestions.clear();
      this.#processes = [];
      this.#todos = [];
      this.#usage.clear();
      this.#usageSeeded = false;
      this.#scheduler = { ...this.#scheduler, running: [], queued: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Client surface
  // -------------------------------------------------------------------------

  get state(): ClientState {
    return this.#state;
  }

  get core(): CoreInfo | null {
    return this.#state === 'ready' ? this.#core : null;
  }

  /**
   * Who the core says this client is, `null` until `hello` has answered, which
   * is what the real `WsClient` reports. The fake is the desktop owner unless
   * it was built with `{ principal: 'session' }`, the paired phone.
   */
  get principal(): Principal | null {
    return this.#state === 'ready' ? this.#principal : null;
  }

  /**
   * Turns this client into a paired device, or back into the owner, in the
   * spirit of `drop` and `restore`: the boundary is the core's, so a test can
   * cross it without a second socket. `hello` and every later call answer as
   * the new principal from here on.
   */
  becomes(principal: Principal): void {
    this.#principal = principal;
  }

  onState(handler: (state: ClientState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  async connect(): Promise<CoreInfo> {
    this.#setState('connecting');
    await this.#tick();
    this.#setState('ready');
    return this.#core;
  }

  close(): void {
    if (FakeClient.#cores.get(this.#identity.coreId) === this) FakeClient.#cores.delete(this.#identity.coreId);
    for (const thread of this.#threads.values()) this.#pauseActivity(thread);
    for (const [id, run] of this.#pluginRuns) this.#pluginRuns.set(id, run + 1);
    this.#setState('closed');
    this.#dropPending('client closed');
  }

  /**
   * The socket going away under the app, what `WsClient` does from
   * `socket.onclose`: every call it was holding rejects with the transport's
   * own failure, the state falls back to `connecting`, and the core's events
   * of that gap reach nobody. The core keeps running behind it.
   */
  drop(): void {
    if (this.#state !== 'ready') return;
    this.#setState('connecting');
    this.#dropPending('connection closed');
  }

  /** The socket back and the hello answered, `#resubscribe` included. */
  async restore(): Promise<CoreInfo> {
    if (this.#state === 'ready') return this.#core;
    this.#setState('connecting');
    await this.#tick();
    this.#setState('ready');
    // `WsClient.#resubscribe` sends one `threads.subscribe` per id it kept.
    for (const threadId of this.#clientSubscribed) this.#subscribed.add(threadId);
    return this.#core;
  }

  /** The ids the core holds this socket on, the set `#emitToThread` gates on. */
  get coreSubscribers(): ThreadId[] {
    return [...this.#subscribed];
  }

  /** The ids the client would resubscribe after a reconnect. */
  get clientSubscriptions(): ThreadId[] {
    return [...this.#clientSubscribed];
  }

  async call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.#state !== 'ready' && method !== 'hello') {
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'not connected' });
    }
    await this.#tick();
    // The router's gate, word for word: deny by default, `hello` before it.
    if (this.#principal === 'session' && method !== 'hello' && !DEVICE_METHODS.has(method)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method} is for the owner only` });
    }
    const result = await this.#hold(this.#dispatch(method, params)) as RpcResult<M>;
    // The real client writes its set from the answer, never from the request.
    if (method === 'threads.subscribe') {
      this.#clientSubscribed.add((params as RpcParams<'threads.subscribe'>).threadId);
    } else if (method === 'threads.unsubscribe') {
      this.#clientSubscribed.delete((params as RpcParams<'threads.unsubscribe'>).threadId);
    }
    return result;
  }

  /**
   * One tick of the core's load sampler (`packages/core/src/procs.ts`): the
   * thread's summary with a fresh `load` and the timestamp it already had,
   * pushed once a second for every thread with a live process. It is not a
   * `#touch`: a load sample moves no row in the sidebar.
   */
  sampleLoad(threadId: ThreadId, processes = 1): void {
    const thread = this.#thread(threadId);
    thread.load = { processes, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#emit('thread.updated', structuredClone(toSummary(thread)));
  }

  /**
   * What the core's recovery does to a thread whose turn it ends: every
   * request still waiting is settled and dropped, the question with a null
   * answer and the permission with a deny (`packages/core/src/threads.ts`).
   */
  clearRequestsOf(threadId: ThreadId): void {
    for (const [questionId, pending] of [...this.#pendingQuestions]) {
      if (pending.request.threadId !== threadId) continue;
      this.#pendingQuestions.delete(questionId);
      this.#emit('question.answered', { questionId, threadId, answer: null });
      pending.resolve(null);
    }
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.request.threadId !== threadId) continue;
      this.#pendingPermissions.delete(requestId);
      this.#emit('permission.resolved', { requestId, threadId, decision: 'deny' });
      pending.resolve('deny');
    }
  }

  /** Resolves when no turn is still streaming. A pending permission blocks it. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight.values()].map((entry) => entry.done));
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async #dispatch(method: RpcMethodName, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case 'quotas.configure': {
        const params = rawParams as RpcParams<'quotas.configure'>;
        this.#quotaEnabled[params.accountId] = params.enabled;
        const rows = this.#quotas(); this.#emit('quotas.updated', rows); return rows;
      }
      case 'quotas.list': return this.#quotas();
      // The core's order: recommended plugins as shipped, then the URL ones by id.
      case 'plugins.list': return structuredClone(this.#plugins).sort((a, b) => a.origin === b.origin ? (a.origin === 'url' ? a.id.localeCompare(b.id) : 0) : a.origin === 'recommended' ? -1 : 1);
      case 'plugins.inspect': return this.#inspectPlugin(rawParams as RpcParams<'plugins.inspect'>);
      case 'plugins.add': return this.#addPlugin((rawParams as RpcParams<'plugins.add'>).previewId);
      case 'plugins.install': {
        const plugin = this.#requirePlugin((rawParams as RpcParams<'plugins.install'>).id);
        if (plugin.status === 'installing') return structuredClone(plugin);
        if (plugin.status === 'rejected' && plugin.origin === 'url') {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${plugin.id} was refused (${plugin.rejected?.message ?? ''}). Remove it, then add it again from its URL.` });
        }
        Object.assign(plugin, { status: 'installing', progress: 0, error: null });
        this.#emit('plugins.updated', structuredClone(plugin));
        void this.#runPluginInstall(plugin.id);
        return structuredClone(plugin);
      }
      case 'plugins.cancel': {
        const plugin = this.#requirePlugin((rawParams as RpcParams<'plugins.cancel'>).id);
        if (plugin.status !== 'installing') return structuredClone(plugin);
        this.#pluginRuns.set(plugin.id, (this.#pluginRuns.get(plugin.id) ?? 0) + 1);
        if (plugin.origin === 'url' && plugin.version === null) return this.#dropPlugin(plugin);
        Object.assign(plugin, { status: plugin.version ? 'installed' : 'not-installed', progress: 0 });
        this.#emit('plugins.updated', structuredClone(plugin));
        return structuredClone(plugin);
      }
      case 'plugins.uninstall': {
        const plugin = this.#requirePlugin((rawParams as RpcParams<'plugins.uninstall'>).id);
        if (plugin.status === 'installing') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Wait for the current plugin operation before uninstalling.' });
        this.#pluginRuns.set(plugin.id, (this.#pluginRuns.get(plugin.id) ?? 0) + 1);
        if (plugin.origin === 'url') return this.#dropPlugin(plugin);
        Object.assign(plugin, { status: 'not-installed', version: null, progress: 0, error: null, rejected: null });
        this.#emit('plugins.updated', structuredClone(plugin));
        return structuredClone(plugin);
      }
      case 'plugins.accounts': {
        const plugin = this.#requirePlugin((rawParams as RpcParams<'plugins.accounts'>).id);
        if (plugin.status !== 'installed') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `Install ${plugin.id} first.` });
        return structuredClone(this.#pluginPools[plugin.id] ?? []);
      }
      case 'plugins.accountAction': {
        const params = rawParams as RpcParams<'plugins.accountAction'>;
        const pools = this.#pluginPools[this.#requirePlugin(params.id).id] ?? [];
        const pool = pools.find((pool) => pool.provider === params.provider);
        if (pool && params.action === 'switch') for (const account of pool.accounts) account.active = account.email === params.email;
        if (pool && params.action === 'remove') pool.accounts = pool.accounts.filter((a) => a.email !== params.email);
        return structuredClone(pools);
      }
      case 'hello':
        return { core: this.#core, principal: this.#principal };
      case 'pairing.grant': {
        const params = rawParams as RpcParams<'pairing.grant'>;
        const grant = `fake-grant-${++this.#seq}`;
        return {
          url: `http://192.168.1.20:8777/?grant=${grant}`,
          grant,
          role: params?.role ?? 'device',
          expiresAt: this.#now() + 10 * 60 * 1000
        };
      }
      case 'sessions.list':
        return structuredClone(this.#sessions);
      case 'push.status':
        return { publicKey: '', subscribed: false };
      case 'push.subscribe':
      case 'push.unsubscribe':
      case 'push.test':
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
      case 'sessions.revoke': {
        const params = rawParams as RpcParams<'sessions.revoke'>;
        if (!this.#sessions.some((session) => session.id === params.sessionId)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `unknown session ${params.sessionId}` });
        }
        this.#sessions = this.#sessions.filter((session) => session.id !== params.sessionId);
        this.#emit('sessions.updated', { sessionId: params.sessionId, state: 'revoked' });
        return { ok: true };
      }

      case 'projects.list':
        return structuredClone(this.#projects);
      case 'projects.browse': {
        const { path = '/workspace' } = rawParams as RpcParams<'projects.browse'>;
        return { path, parent: path === '/' ? null : '/', directories: path === '/workspace' ? [
          { name: 'boite', path: '/workspace/boite' }, { name: 'notes', path: '/workspace/notes' }
        ] : [] };
      }
      case 'projects.add': {
        const params = rawParams as RpcParams<'projects.add'>;
        const project: Project = {
          id: `p-${++this.#seq}`,
          name: params.name ?? params.path.split(/[\\/]/).filter(Boolean).pop() ?? params.path,
          path: params.path,
          createdAt: this.#now()
        };
        this.#projects.push(project);
        this.#emit('project.added', structuredClone(project));
        return structuredClone(project);
      }
      case 'threads.pullRequest': {
        const params = rawParams as RpcParams<'threads.pullRequest'>;
        const thread = this.#threads.get(params.threadId);
        return thread?.pullRequest ?? null;
      }
      case 'projects.remove': {
        const params = rawParams as RpcParams<'projects.remove'>;
        this.#projects = this.#projects.filter((p) => p.id !== params.projectId);
        const threads = [...this.#threads.values()].filter((thread) => thread.projectId === params.projectId);
        for (const thread of threads) thread.archived = true;
        await Promise.all(threads.map((thread) => this.#stopTurn(thread.id)));
        for (const thread of threads) {
          this.#threads.delete(thread.id);
          this.#emit('thread.removed', { threadId: thread.id });
        }
        this.#emit('project.removed', { projectId: params.projectId });
        return { ok: true };
      }
      case 'projects.files': {
        const params = rawParams as RpcParams<'projects.files'>;
        if (!this.#projects.some((p) => p.id === params.projectId)) {
          throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown project ${params.projectId}` });
        }
        const limit = Math.max(1, Math.min(200, params.limit ?? 50));
        const scored = FAKE_FILES.map((path) => ({ path, score: scoreFakeFile(params.query, path) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
        return { files: scored.slice(0, limit).map((entry) => entry.path), total: scored.length, capped: false };
      }

      case 'providers.list':
        return { loaded: structuredClone(this.#providers), rejected: [] };
      case 'providers.reload': {
        for (const provider of this.#providers) {
          if (!provider.available || this.#accounts.some(account => account.providerId === provider.id)) continue;
          const id = `a-${++this.#seq}`;
          const account: Account = {
            id, providerId: provider.id, label: 'Default',
            isolationDir: provider.alwaysIsolated ? `${DATA_DIR}/accounts/${id}` : null,
            status: provider.alwaysIsolated ? 'unauthenticated' : 'ok', identity: null, createdAt: this.#now(),
          };
          this.#accounts.push(account);
          this.#emit('accounts.updated', structuredClone(account));
        }
        const result = { loaded: structuredClone(this.#providers), rejected: [] };
        this.#emit('providers.updated', structuredClone(result));
        return result;
      }
      case 'providers.probe': {
        const params = rawParams as RpcParams<'providers.probe'>;
        // The fixture catalogue already carries each model's own scale, so a probe
        // naming a model answers the same list; only the refusal is mirrored.
        if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length === 0)) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'model must be a non-empty string when given', data: { field: 'model', expected: 'a non-empty string' } });
        }
        return this.#probe(params.providerId, params.accountId);
      }
      case 'providers.install': {
        const params = rawParams as RpcParams<'providers.install'>;
        return this.#startInstall(params.providerId);
      }
      case 'providers.installCancel': {
        const params = rawParams as RpcParams<'providers.installCancel'>;
        return this.#cancelInstall(params.providerId, params.operationId);
      }
      case 'providers.uninstall': {
        const params = rawParams as RpcParams<'providers.uninstall'>;
        return this.#uninstall(params.providerId);
      }
      case 'providers.updates':
        return structuredClone(this.#harnessUpdates);
      case 'providers.update': {
        const params = rawParams as RpcParams<'providers.update'>;
        return this.#updateHarness(params.providerId);
      }
      case 'providers.updateSkip': {
        const params = rawParams as RpcParams<'providers.updateSkip'>;
        const update = this.#harnessUpdate(params.providerId);
        update.skipped = params.version;
        update.pending = update.latest !== update.current && update.skipped !== update.latest;
        this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
        return structuredClone(update);
      }
      case 'providers.dryRun': {
        const params = rawParams as RpcParams<'providers.dryRun'>;
        const provider = this.#providers[0];
        if (!params.file.endsWith('.json') || !provider) {
          return {
            ok: false,
            rejected: {
              file: params.file,
              field: 'file',
              expected: 'a path ending in .json',
              message: 'not a descriptor file'
            }
          };
        }
        return {
          ok: true,
          summary: structuredClone(provider),
          plan: { roots: [DATA_DIR], env: ['BOITE_ISOLATION_DIR'], closes: [] }
        };
      }

      case 'accounts.list':
        return structuredClone(this.#accounts);
      case 'accounts.add': {
        const params = rawParams as RpcParams<'accounts.add'>;
        const provider = this.#providers.find((p) => p.id === params.providerId);
        if (!provider) throw this.#notFound('provider', params.providerId);
        const id = `a-${++this.#seq}`;
        const account: Account = {
          id,
          providerId: params.providerId,
          label: params.label,
          isolationDir: params.useDefaultLocation && !provider.alwaysIsolated ? null : `${DATA_DIR}\\accounts\\${id}`,
          status: 'unknown',
          identity: null,
          createdAt: this.#now()
        };
        this.#accounts.push(account);
        this.#emit('accounts.updated', structuredClone(account));
        return structuredClone(account);
      }
      case 'accounts.remove': {
        const params = rawParams as RpcParams<'accounts.remove'>;
        if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
        const referenced = [...this.#threads.values()].find((t) => t.accountId === params.accountId);
        if (referenced) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `account ${params.accountId} is used by thread ${referenced.id}` });
        }
        this.#cancelLogin(params.accountId);
        this.#accounts = this.#accounts.filter((a) => a.id !== params.accountId);
        this.#emit('accounts.removed', { accountId: params.accountId });
        return { ok: true };
      }
      case 'accounts.check': {
        const params = rawParams as RpcParams<'accounts.check'>;
        const account = this.#accounts.find((a) => a.id === params.accountId);
        if (!account) throw this.#notFound('account', params.accountId);
        account.status = account.isolationDir === null ? 'ok' : 'unauthenticated';
        account.identity = account.status === 'ok' ? 'you@example.com' : null;
        this.#emit('accounts.updated', structuredClone(account));
        return structuredClone(account);
      }
      case 'accounts.login': {
        const params = rawParams as RpcParams<'accounts.login'>;
        const account = this.#accounts.find((a) => a.id === params.accountId);
        if (!account) throw this.#notFound('account', params.accountId);
        const provider = this.#providers.find((p) => p.id === account.providerId);
        if (!provider?.available || !provider.login) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `login is not available for ${account.providerId}` });
        }
        if (account.isolationDir === null) {
          throw new RpcFailure({
            code: RpcErrorCode.Refused,
            message: `${account.label} uses the provider's own location: log it in with your own CLI, outside Boite`
          });
        }
        if (this.#logins.has(account.id)) {
          throw new RpcFailure({
            code: RpcErrorCode.Refused,
            message: `a login is already running for ${account.label}`
          });
        }
        this.#loginEvent({
          accountId: account.id,
          state: 'running',
          output: '',
          url: null,
          exitCode: null
        });
        void this.#fakeLoginPrompt(account.id);
        return { ok: true };
      }
      case 'accounts.logins':
        return structuredClone([...this.#logins.values()]);
      case 'accounts.loginCancel': {
        const params = rawParams as RpcParams<'accounts.loginCancel'>;
        if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
        this.#cancelLogin(params.accountId);
        return { ok: true };
      }
      case 'accounts.loginInput': {
        const params = rawParams as RpcParams<'accounts.loginInput'>;
        const account = this.#accounts.find((a) => a.id === params.accountId);
        if (!account) throw this.#notFound('account', params.accountId);
        if (!this.#logins.has(account.id)) {
          throw new RpcFailure({
            code: RpcErrorCode.Refused,
            message: `no login is running for ${account.id}`
          });
        }
        void this.#finishFakeLogin(account);
        return { ok: true };
      }

      case 'threads.list': {
        const params = rawParams as RpcParams<'threads.list'>;
        return [...this.#threads.values()]
          .filter((t) => (params.projectId ? t.projectId === params.projectId : true))
          .filter((t) => (params.includeArchived ? true : !t.archived))
          .map((t) => structuredClone(toSummary(t)));
      }
      case 'threads.create': {
        const params = rawParams as RpcParams<'threads.create'>;
        if (!this.#providers.some(provider => provider.id === params.providerId)) throw this.#notFound('provider', params.providerId);
        const project = this.#projects.find((p) => p.id === params.projectId);
        if (!project) throw this.#notFound('project', params.projectId);
        this.#checkSpeed(params.providerId, params.accountId, params.model ?? null, params.speed ?? null);
        const at = this.#now();
        const title = params.title ?? 'Untitled thread';
        // The core's own placement: a branch named after the title, the
        // worktree beside the repository. No git here, only the two strings.
        const placed = params.worktree === undefined ? null : fakeWorktree(project.path, title, params.worktree.branch);
        const thread: Thread = {
          id: `t-${++this.#seq}`,
          projectId: params.projectId,
          title,
          titleSource: 'prompt',
          providerId: params.providerId,
          accountId: params.accountId,
          model: params.model ?? null,
          effort: params.effort ?? null,
          speed: params.speed ?? null,
          cwd: placed?.path ?? params.cwd ?? project.path,
          branch: placed?.branch ?? null,
          permissionMode: params.permissionMode ?? 'default',
          status: 'idle',
          unread: false,
          archived: false,
          pinned: false,
          sessionId: null,
          load: null,
          context: null,
          createdAt: at,
          updatedAt: at,
          messages: [],
          commands: [],
          messagesBefore: null,
          turns: []
        };
        this.#threads.set(thread.id, thread);
        this.#emit('thread.created', structuredClone(toSummary(thread)));
        return structuredClone(toSummary(thread));
      }
      case 'threads.get': {
        const params = rawParams as RpcParams<'threads.get'>;
        const thread = this.#thread(params.threadId);
        // The core's rule: from the named message on, unless it is unknown or
        // the tail is longer than a page, and then the whole page as before.
        const from = params.after === undefined ? -1 : thread.messages.findIndex((message) => message.id === params.after);
        if (from !== -1 && thread.messages.length - from <= MESSAGE_PAGE) {
          const messages = thread.messages.slice(from);
          // As the core's `listTurnsFor`: the turns of the messages sent, and whatever is still queued or running.
          const sent = new Set(messages.map((message) => message.turnId));
          const turns = thread.turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || sent.has(turn.id));
          return structuredClone({ ...thread, messages, turns, messagesBefore: null, messagesFrom: params.after });
        }
        const page = this.#page(thread.messages, thread.messages.length, MESSAGE_PAGE);
        return structuredClone({ ...thread, messages: page.messages, messagesBefore: page.before });
      }
      case 'messages.list': {
        const params = rawParams as RpcParams<'messages.list'>;
        const thread = this.#thread(params.threadId);
        const at = thread.messages.findIndex((message) => message.id === params.before);
        if (at < 0) {
          throw new RpcFailure({
            code: RpcErrorCode.Refused,
            message: `message ${params.before} is not a message of thread ${params.threadId}`,
            data: { threadId: params.threadId, before: params.before }
          });
        }
        const asked = params.limit ?? MESSAGE_PAGE;
        const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
        const page = this.#page(thread.messages, at, limit);
        const turns = new Set(page.messages.map((message) => message.turnId));
        return structuredClone({ ...page, turns: thread.turns.filter((turn) => turns.has(turn.id)) });
      }
      case 'threads.update': {
        const params = rawParams as RpcParams<'threads.update'>;
        const thread = this.#thread(params.threadId);
        if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
        }
        const nextAccountId = params.accountId ?? thread.accountId;
        const nextProviderId = this.#accounts.find(a => a.id === nextAccountId)?.providerId ?? thread.providerId;
        const changedModel = (params.model !== undefined && params.model !== thread.model) || nextAccountId !== thread.accountId;
        this.#checkSpeed(nextProviderId, nextAccountId, params.model !== undefined ? params.model : thread.model, params.speed !== undefined ? params.speed : changedModel ? null : thread.speed ?? null);
        const before = [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0');
        if (params.accountId !== undefined && params.accountId !== thread.accountId) {
          const account = this.#accounts.find((entry) => entry.id === params.accountId);
          const provider = account && this.#providers.find((entry) => entry.id === account.providerId);
          if (!account || !provider?.available || account.status === 'unauthenticated') {
            throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the selected account is unavailable' });
          }
          thread.accountId = account.id;
          thread.providerId = account.providerId;
          thread.model = params.model === undefined ? provider.models.find((model) => model.default)?.id ?? null : params.model;
          thread.effort = null; thread.speed = null;
          thread.sessionId = null;
          thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
          thread.context = null;
          thread.commands = [];
          this.#emit('thread.commands', { threadId: thread.id, commands: [] });
        }
        if (params.title !== undefined) {
          thread.title = params.title;
          thread.titleSource = 'user';
        }
        if (params.model !== undefined && params.model !== thread.model) { thread.model = params.model; thread.effort = null; thread.speed = null; }
        if (params.effort !== undefined) thread.effort = params.effort;
        if (params.speed !== undefined) thread.speed = params.speed;
        if (params.permissionMode !== undefined) thread.permissionMode = params.permissionMode;
        if (before !== [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0')) thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
        return this.#touch(thread);
      }
      case 'threads.retitle': {
        const params = rawParams as RpcParams<'threads.retitle'>;
        const thread = this.#thread(params.threadId);
        const first = thread.messages.find((message) => message.role === 'user');
        if (first === undefined) {
          throw new RpcFailure({
            code: RpcErrorCode.Refused,
            message: 'this thread has no prompt to write a title from',
            data: { threadId: params.threadId }
          });
        }
        // The echo agent's rule, at the echo agent's pace: its prefix and the first five words.
        await new Promise<void>((resolve) => setTimeout(resolve, RETITLE_DELAY_MS));
        const words = first.parts
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join(' ')
          .split(/\s+/)
          .filter((word) => word.length > 0);
        thread.title = `Echo: ${words.slice(0, 5).join(' ')}`;
        thread.titleSource = 'agent';
        return this.#touch(thread);
      }
      case 'threads.archive': {
        const params = rawParams as RpcParams<'threads.archive'>;
        const thread = this.#thread(params.threadId);
        thread.archived = params.archived ?? true;
        if (thread.archived) await this.#stopTurn(thread.id);
        return this.#touch(thread);
      }
      case 'threads.pin': {
        const params = rawParams as RpcParams<'threads.pin'>;
        const thread = this.#thread(params.threadId);
        const pinned = params.pinned ?? true;
        if (thread.pinned === pinned) return structuredClone(toSummary(thread));
        thread.pinned = pinned;
        return this.#touch(thread);
      }
      case 'threads.markRead': {
        const params = rawParams as RpcParams<'threads.markRead'>;
        const thread = this.#thread(params.threadId);
        thread.unread = false;
        this.#touch(thread);
        return { ok: true };
      }
      case 'threads.subscribe': {
        const params = rawParams as RpcParams<'threads.subscribe'>;
        // The core runs `threads.require` first, so an unknown id is a NotFound.
        this.#thread(params.threadId);
        this.#subscribed.add(params.threadId);
        return { ok: true };
      }
      case 'threads.unsubscribe': {
        const params = rawParams as RpcParams<'threads.unsubscribe'>;
        this.#subscribed.delete(params.threadId);
        return { ok: true };
      }

      case 'turns.start': {
        const params = rawParams as RpcParams<'turns.start'>;
        if (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.some(a => !a || typeof a !== 'object'))) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'attachments must be an array of attachment objects' });
        const key = params.clientRequestId ? `${params.threadId}:${params.clientRequestId}` : null;
        const content = JSON.stringify([params.prompt, (params.attachments ?? []).map(a => [a.kind, a.mimeType, a.data, a.name])]);
        if (params.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(params.clientRequestId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId must contain 8 to 128 URL-safe characters' });
        const previous = key ? this.#turnRequests.get(key) : undefined;
        if (previous) {
          if (previous.content !== content) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId was already used for different content' });
          return previous.turn;
        }
        if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (this.#thread(params.threadId).selectionVersion ?? 0)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
        }
        const thread = this.#thread(params.threadId);
        const providerId = thread.providerId;
        const provider = this.#providers.find(p => p.id === providerId);
        if (!provider) throw this.#notFound('provider', providerId);
        const error = attachmentError(params.attachments ?? [], provider);
        if (error) throw new RpcFailure({ code: RpcErrorCode.Refused, ...error });
        const rootId = thread.parentThreadId;
        if (rootId) {
          const config = this.#delegationConfig(rootId);
          if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
          if ((this.#delegationTurns.get(rootId) ?? 0) >= config.maxTurns) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation turn budget reached' });
        }
        const turn = this.#startTurn(params.threadId, params.prompt, params.attachments ?? [], rootId ? 'delegation' : undefined);
        if (rootId) this.#delegationTurns.set(rootId, (this.#delegationTurns.get(rootId) ?? 0) + 1);
        if (key) this.#turnRequests.set(key, { content, turn });
        return turn;
      }
      case 'threads.activity.set': {
        const params = rawParams as RpcParams<'threads.activity.set'>;
        const thread = this.#thread(params.threadId);
        if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'activity requires an unarchived thread' });
        const activity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
        if (params.goal !== undefined) {
          if (params.goal !== null && !params.goal.objective?.trim()) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'goal.objective must be non-empty text' });
          activity.goal = params.goal === null ? null : { objective: params.goal.objective.trim(), status: 'active', iterations: 0, error: null };
        }
        if (params.loop !== undefined) {
          if (params.loop !== null && (!params.loop.prompt?.trim() || !Number.isInteger(params.loop.intervalMs) || (params.loop.intervalMs < 1000 && !(params.loop.intervalMs === 0 && params.loop.maxIterations)) || params.loop.intervalMs > 86400000 || (params.loop.maxIterations != null && (!Number.isInteger(params.loop.maxIterations) || params.loop.maxIterations < 1 || params.loop.maxIterations > 1000)))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'loop requires text and an interval from 1000 to 86400000 ms, or 0 with 1 to 1000 iterations' });
          activity.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, maxIterations: params.loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
        }
        for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
          const key = `${thread.id}:${kind}`;
          this.#activityGenerations.set(key, (this.#activityGenerations.get(key) ?? 0) + 1);
        }
        thread.activity = activity;
        this.#publishActivity(thread);
        this.#scheduleActivity(thread.id);
        return structuredClone(activity);
      }
      case 'threads.activity.control': {
        const params = rawParams as RpcParams<'threads.activity.control'>;
        const thread = this.#thread(params.threadId);
        const activity = thread.activity;
        if (params.action === 'resume' && thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot resume activity on an archived thread' });
        const item = activity?.[params.kind];
        if (!activity || !item) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `this thread has no ${params.kind}` });
        if (params.action === 'complete' && params.kind !== 'goal') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'only a goal can be completed' });
        if (params.action === 'resume' && params.kind === 'loop' && activity.loop?.maxIterations && activity.loop.iterations >= activity.loop.maxIterations) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this loop has finished all its iterations' });
        if (params.action === 'remove') activity[params.kind] = null;
        else if (params.action === 'complete' && activity.goal) activity.goal.status = 'complete';
        else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; if (params.kind === 'goal' && activity.goal) activity.goal.dismissed = false; }
        if (params.action === 'remove' || params.action === 'complete') {
          const key = `${thread.id}:${params.kind}`;
          this.#activityGenerations.set(key, (this.#activityGenerations.get(key) ?? 0) + 1);
        }
        if (activity.loop && activity.loop.status !== 'active') activity.loop.nextRunAt = null;
        if (params.kind === 'loop' && params.action === 'resume' && activity.loop) activity.loop.nextRunAt = Date.now();
        this.#publishActivity(thread);
        this.#scheduleActivity(thread.id);
        return structuredClone(activity);
      }
      case 'threads.compact': {
        const params = rawParams as RpcParams<'threads.compact'>;
        const thread = this.#thread(params.threadId);
        if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed' });
        if (!thread.sessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread has no native session to compact' });
        if (this.#providers.find((p) => p.id === thread.providerId)?.protocol === 'acp' && !thread.commands.some((c) => c.name === 'compact')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this agent has not advertised a compact command' });
        if (this.#providers.find((p) => p.id === thread.providerId)?.protocol === 'agy') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the Antigravity CLI takes no /compact in print mode' });
        return this.#startTurn(params.threadId, '[compact]', [], 'compact');
      }
      case 'turns.stop': {
        const params = rawParams as RpcParams<'turns.stop'>;
        const thread = this.#thread(params.threadId);
        const root = thread.parentThreadId ?? thread.id;
        let childrenStopped = 0;
        if (thread.parentThreadId || this.#delegationConfig(root).enabled || (this.#delegationAgents.get(root)?.length ?? 0) > 0) {
          childrenStopped = await this.#stopDelegation(root, thread.parentThreadId ? thread.id : undefined);
          this.#emit('delegation.changed', { threadId: root });
        }
        return { stopped: await this.#stopTurn(params.threadId) || childrenStopped > 0 };
      }

      case 'permissions.list': {
        const params = rawParams as RpcParams<'permissions.list'>;
        const requests = [...this.#pendingPermissions.values()]
          .map((pending) => pending.request)
          .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
          .sort((a, b) => a.createdAt - b.createdAt);
        return structuredClone(requests);
      }

      case 'permissions.answer': {
        const params = rawParams as RpcParams<'permissions.answer'>;
        const pending = this.#pendingPermissions.get(params.requestId);
        if (!pending) throw this.#notFound('permission request', params.requestId);
        this.#pendingPermissions.delete(params.requestId);
        pending.resolve(params.decision);
        return { ok: true };
      }

      case 'questions.list': {
        const params = rawParams as RpcParams<'questions.list'>;
        const requests = [...this.#pendingQuestions.values()]
          .map((pending) => pending.request)
          .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
          .sort((a, b) => a.createdAt - b.createdAt);
        return structuredClone(requests);
      }

      case 'questions.answer': {
        const params = rawParams as RpcParams<'questions.answer'>;
        const pending = this.#pendingQuestions.get(params.questionId);
        if (!pending) throw this.#notFound('question', params.questionId);
        this.#pendingQuestions.delete(params.questionId);
        const text = params.text ?? '';
        const answer: QuestionAnswer =
          text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
        pending.resolve(answer);
        return { ok: true };
      }

      case 'trace.get': {
        const params = rawParams as RpcParams<'trace.get'>;
        const rows = this.#processes
          .filter((p) => p.threadId === params.threadId)
          .sort((a, b) => b.startedAt - a.startedAt);
        return structuredClone(params.limit ? rows.slice(0, params.limit) : rows);
      }
      case 'resources.list':
        return structuredClone(this.#resources());
      case 'resources.killTree': {
        const params = rawParams as RpcParams<'resources.killTree'>;
        let killed = 0;
        for (const record of this.#processes) {
          if (record.threadId !== params.threadId || record.exitedAt !== null) continue;
          record.exitedAt = this.#now();
          record.exitCode = 1;
          killed += 1;
          this.#emit('process.exited', structuredClone(record));
        }
        const thread = this.#threads.get(params.threadId);
        if (thread) {
          thread.load = null;
          this.#touch(thread);
        }
        return { killed };
      }

      case 'scheduler.get':
        return structuredClone(this.#scheduler);
      case 'usage.get': {
        const params = rawParams as RpcParams<'usage.get'>;
        const byThread: Record<ThreadId, Usage> = {};
        let total = emptyUsage();
        for (const [threadId, usage] of this.#usage) {
          if (params.threadId && params.threadId !== threadId) continue;
          byThread[threadId] = { ...usage };
          total = addUsage(total, usage);
        }
        return { byThread, total };
      }
      case 'usage.history': {
        const { edges } = rawParams as RpcParams<'usage.history'>;
        const valid = Array.isArray(edges) && edges.length >= 2 && edges.length <= 367 &&
          edges.every((edge, index) => typeof edge === 'number' && Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]!));
        if (!valid) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'edges: expected 2 to 367 strictly ascending timestamps in milliseconds' });
        return fakeUsageHistory(edges, { seeded: this.#usageSeeded, finished: this.#finished });
      }

      case 'telemetry.state': return { ...this.#telemetry };
      case 'telemetry.configure': {
        const { mode } = rawParams as RpcParams<'telemetry.configure'>;
        if (!['off', 'basic', 'enhanced'].includes(mode)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'mode: expected off, basic or enhanced' });
        if (this.#telemetry.mode === 'enhanced' && mode !== 'enhanced') this.#telemetry.pendingDeletion = true;
        this.#telemetry.mode = mode;
        return { ...this.#telemetry };
      }
      case 'telemetry.retryForget':
        this.#telemetry.pendingDeletion = false;
        return { ...this.#telemetry };
      case 'telemetry.export':
        if (this.#telemetry.mode !== 'enhanced') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'telemetry export: expected enhanced mode' });
        return { events: [], truncated: false };
      case 'settings.get':
        return { ...this.#settings };
      case 'delegation.get': {
        const { threadId } = rawParams as RpcParams<'delegation.get'>;
        return this.#delegationView(this.#delegationRoot(threadId), threadId);
      }
      case 'delegation.configure': {
        const { threadId, config: value } = rawParams as RpcParams<'delegation.configure'>;
        const root = this.#delegationRoot(threadId);
        if (root !== threadId || !value || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean' || !Array.isArray(value.profiles) || value.profiles.length > 16) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'delegation.configure requires a parent thread and a valid config' });
        }
        const integer = (field: keyof Pick<DelegationConfig, 'maxAgents' | 'maxConcurrent' | 'maxTurns' | 'maxMinutes'>, max: number): number => {
          const number = value[field];
          if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `${field} must be an integer from 1 to ${max}` });
          return number;
        };
        const profiles = value.profiles.map(profile => {
          const provider = this.#providers.find(entry => entry.id === profile.providerId);
          const account = this.#accounts.find(entry => entry.id === profile.accountId);
          if (!profile.id || !profile.name.trim() || !provider || !account || account.providerId !== provider.id || !profile.model) {
            throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'each profile needs a unique id, name, provider, account and model' });
          }
          return { ...profile, name: profile.name.trim() };
        });
        if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'profile ids must be unique' });
        if (value.enabled && profiles.length === 0) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'choose at least one profile before enabling delegation' });
        const config: DelegationConfig = {
          enabled: value.enabled,
          paused: value.paused,
          maxAgents: integer('maxAgents', 8),
          maxConcurrent: integer('maxConcurrent', 8),
          maxTurns: integer('maxTurns', 100),
          maxMinutes: integer('maxMinutes', 120),
          profiles
        };
        if (config.maxConcurrent > config.maxAgents) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'maxConcurrent must not exceed maxAgents' });
        this.#delegationConfigs.set(root, structuredClone(config));
        if (!config.enabled || config.paused) await this.#stopDelegation(root);
        this.#emit('delegation.changed', { threadId: root });
        return this.#delegationView(root);
      }
      case 'delegation.spawn': {
        const params = rawParams as RpcParams<'delegation.spawn'>;
        const parent = this.#thread(params.threadId);
        if (parent.parentThreadId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation supports one level' });
        const task = params.task.trim();
        if (!task || task.length > 12000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'task must contain 1 to 12000 characters' });
        const fingerprint = JSON.stringify([params.profileId, task, params.title ?? null]);
        const requestKey = `${parent.id}:${params.requestId}`;
        const prior = this.#delegationRequests.get(requestKey);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
          const row = (this.#delegationAgents.get(parent.id) ?? []).find(entry => entry.threadId === prior.threadId);
          if (!row) throw this.#notFound('delegated agent', prior.threadId);
          return this.#delegatedAgent(row);
        }
        const config = this.#delegationConfig(parent.id);
        if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
        const rows = this.#delegationAgents.get(parent.id) ?? [];
        if (rows.length >= config.maxAgents) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation agent limit reached' });
        if ((this.#delegationTurns.get(parent.id) ?? 0) >= config.maxTurns) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation turn budget reached' });
        const running = rows.filter(row => ['queued', 'running', 'waiting'].includes(this.#thread(row.threadId).status)).length;
        const profile = config.profiles.find(entry => entry.id === params.profileId);
        if (!profile) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'unknown delegation profile' });
        const id = `t-${++this.#seq}`;
        const at = this.#now();
        const child: Thread = {
          ...parent,
          id,
          parentThreadId: parent.id,
          title: params.title?.trim() || task.split('\n')[0]!.slice(0, 80),
          titleSource: 'user',
          providerId: profile.providerId,
          accountId: profile.accountId,
          model: profile.model,
          effort: profile.effort,
          status: 'idle', unread: false, archived: false, pinned: false,
          sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null,
          createdAt: at, updatedAt: at, messagesBefore: null, messages: [], turns: [], commands: []
        };
        delete child.pullRequest;
        delete child.lastUserMessageAt;
        this.#threads.set(id, child);
        const row = { threadId: id, profileId: profile.id, task };
        this.#delegationAgents.set(parent.id, [...rows, row]);
        this.#delegationTurns.set(parent.id, (this.#delegationTurns.get(parent.id) ?? 0) + 1);
        this.#emit('thread.created', structuredClone(toSummary(child)));
        const turn = running >= config.maxConcurrent
          ? { id: `turn-${++this.#seq}`, threadId: id, status: 'queued' as const, queuedAt: at, startedAt: null, finishedAt: null, usage: null, error: null }
          : this.#startTurn(id, task, [], 'delegation');
        if (turn.status === 'queued') {
          child.turns.push(turn);
          child.status = 'queued';
          this.#scheduler.queued = [...this.#scheduler.queued, { turnId: turn.id, threadId: id, position: this.#scheduler.queued.length + 1, queuedAt: turn.queuedAt }];
          this.#emit('scheduler.updated', structuredClone(this.#scheduler));
        }
        const agent = this.#delegatedAgent(row);
        this.#delegationRequests.set(requestKey, { fingerprint, threadId: id });
        this.#emit('delegation.changed', { threadId: parent.id });
        void turn;
        return structuredClone(agent);
      }
      case 'delegation.send': {
        const params = rawParams as RpcParams<'delegation.send'>;
        if (params.requestId.startsWith('result:')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId prefix result: is reserved' });
        const sender = this.#thread(params.threadId);
        const recipient = this.#thread(params.toThreadId);
        const root = this.#delegationRoot(sender.id);
        const direct = sender.parentThreadId ? recipient.id === sender.parentThreadId : recipient.parentThreadId === sender.id;
        if (!direct) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'toThreadId must be the parent or a direct child' });
        const body = params.text.trim();
        if (!body || body.length > 4000) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'text must contain 1 to 4000 characters' });
        const key = `${sender.id}:${params.requestId}`;
        const fingerprint = JSON.stringify([recipient.id, body]);
        const prior = this.#delegationSendRequests.get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
          return structuredClone(prior.letter);
        }
        const config = this.#delegationConfig(root);
        if (!config.enabled || config.paused) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'delegation is disabled or paused' });
        const letter: AgentLetter = {
          id: `letter-${++this.#seq}`,
          origin: 'user',
          from: { coreId: 'local', threadId: sender.id, title: sender.title, machine: 'Boite', resources: '', status: sender.status, mode: 'team' },
          to: { coreId: 'local', threadId: recipient.id }, toTitle: recipient.title,
          text: body, replyTo: null, createdAt: this.#now(), expiresAt: this.#now() + 15 * 60_000,
          status: 'received', error: null
        };
        this.#delegationLetters.set(root, [...(this.#delegationLetters.get(root) ?? []), letter]);
        this.#delegationSendRequests.set(key, { fingerprint, letter });
        this.#emit('delegation.changed', { threadId: root });
        return structuredClone(letter);
      }
      case 'delegation.stop': {
        const params = rawParams as RpcParams<'delegation.stop'>;
        const caller = this.#thread(params.threadId);
        const root = caller.parentThreadId ?? caller.id;
        if (caller.parentThreadId && params.agentId && params.agentId !== caller.id) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a delegated child can only stop itself' });
        }
        const target = params.agentId ?? (caller.parentThreadId ? caller.id : undefined);
        const stopped = await this.#stopDelegation(root, target);
        this.#emit('delegation.changed', { threadId: root });
        return { stopped };
      }
      case 'collaboration.get': {
        const { threadId } = rawParams as RpcParams<'collaboration.get'>;
        this.#thread(threadId);
        return this.#coordinationView(threadId);
      }
      case 'collaboration.configure': {
        const { threadId, config } = rawParams as RpcParams<'collaboration.configure'>;
        this.#thread(threadId);
        if (!['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'config: expected mode, resources, remote and paused' });
        }
        this.#coordination.set(threadId, { ...config, resources: config.resources.trim() });
        this.#emit('collaboration.changed', { threadId });
        return this.#coordinationView(threadId);
      }
      case 'collaboration.directory': {
        const { threadId } = rawParams as RpcParams<'collaboration.directory'>;
        const source = this.#thread(threadId);
        const sourceConfig = this.#coordinationConfig(threadId);
        if (sourceConfig.mode === 'off') return { agents: [], unavailable: [] };
        const agents = [...this.#threads.values()]
          .filter(thread => thread.id !== threadId && !thread.archived && (thread.projectId === source.projectId || sourceConfig.remote && this.#coordinationConfig(thread.id).remote))
          .map(thread => {
            const config = this.#coordinationConfig(thread.id);
            return {
              coreId: this.#identity.coreId,
              threadId: thread.id,
              title: thread.title,
              machine: this.#identity.name,
              resources: config.resources,
              status: thread.status,
              mode: config.mode
            };
          })
          .filter(agent => agent.mode !== 'off');
        const unavailable: string[] = [];
        if (sourceConfig.remote) for (const peer of this.#peers.values()) {
          const target = FakeClient.#cores.get(peer.coreId);
          if (!target || !target.#peers.has(this.#identity.coreId)) { unavailable.push(peer.name); continue; }
          for (const thread of target.#threads.values()) {
            const config = target.#coordinationConfig(thread.id);
            if (thread.archived || config.mode === 'off' || !config.remote) continue;
            agents.push({ coreId: peer.coreId, threadId: thread.id, title: thread.title, machine: peer.name, resources: config.resources, status: thread.status, mode: config.mode });
          }
        }
        return { agents, unavailable };
      }
      case 'collaboration.send': {
        const params = rawParams as RpcParams<'collaboration.send'>;
        const source = this.#thread(params.threadId);
        const config = this.#coordinationConfig(source.id);
        if (config.mode === 'off' || config.paused) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination is off or paused for this thread' });
        }
        const existing = this.#letters.get(source.id)?.find(letter => letter.id === params.requestId);
        if (existing) {
          if (existing.text !== params.text.trim() || existing.to.coreId !== params.to.coreId || existing.to.threadId !== params.to.threadId || existing.replyTo !== (params.replyTo ?? null)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
          return structuredClone(existing);
        }
        if (!params.text.trim() || params.text.length > 4000 || this.#coordinationView(source.id).sent >= (config.mode === 'brief' ? 6 : 40)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'message size or hourly budget exceeded' });
        const destination = params.to.coreId === this.#identity.coreId ? this : FakeClient.#cores.get(params.to.coreId);
        const target = destination ? destination.#threads.get(params.to.threadId) : undefined;
        if (!target || target.archived || destination!.#coordinationConfig(target.id).mode === 'off') {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'recipient is unavailable for coordination' });
        }
        if (destination === this && target.projectId !== source.projectId && !(config.remote && this.#coordinationConfig(target.id).remote)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'both threads must allow coordination across projects' });
        }
        if (destination !== this && (!config.remote || !this.#peers.has(params.to.coreId) || !destination || !destination.#peers.has(this.#identity.coreId) || !destination.#coordinationConfig(target.id).remote)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'remote core is not trusted' });
        }
        const letter: AgentLetter = {
          id: params.requestId,
          from: {
            coreId: this.#identity.coreId,
            threadId: source.id,
            title: source.title,
            machine: this.#identity.name,
            resources: config.resources,
            status: source.status,
            mode: config.mode
          },
          to: params.to,
          toTitle: target?.title ?? this.#peers.get(params.to.coreId)?.name ?? params.to.threadId,
          text: params.text.trim(),
          replyTo: params.replyTo ?? null,
          createdAt: this.#now(),
          expiresAt: this.#now() + 15 * 60_000,
          status: 'delivered',
          error: null
        };
        this.#letters.set(source.id, [...(this.#letters.get(source.id) ?? []), letter]);
        this.#emit('collaboration.changed', { threadId: source.id });
        destination!.#letters.set(target.id, [...(destination!.#letters.get(target.id) ?? []), letter]);
        destination!.#emit('collaboration.changed', { threadId: target.id });
        return structuredClone(letter);
      }
      case 'collaboration.identity':
        return structuredClone(this.#identity);
      case 'collaboration.peers':
        return structuredClone([...this.#peers.values()]);
      case 'collaboration.check': {
        const { coreId } = rawParams as RpcParams<'collaboration.check'>;
        const peer = this.#peers.get(coreId);
        const target = FakeClient.#cores.get(coreId);
        if (!peer || !target || !target.#peers.has(this.#identity.coreId) || target.#identity.url !== peer.url) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'machine is unreachable or mutual trust is missing' });
        }
        return { ok: true };
      }
      case 'collaboration.trust': {
        const { peer } = rawParams as RpcParams<'collaboration.trust'>;
        let url: URL;
        try { url = new URL(peer.url); } catch { throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer.url: expected an HTTPS or loopback URL' }); }
        const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !loopback)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'peer.url: expected HTTPS origin, or numeric loopback HTTP' });
        if (!peer.coreId || !peer.publicKey || peer.coreId === this.#identity.coreId) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer: expected another core public identity' });
        this.#peers.set(peer.coreId, structuredClone(peer));
        return structuredClone(peer);
      }
      case 'collaboration.untrust': {
        const { coreId } = rawParams as RpcParams<'collaboration.untrust'>;
        this.#peers.delete(coreId);
        return { ok: true };
      }
      case 'speech.config': return { ...this.#speech };
      case 'speech.status': return { ...this.#speechStatus };
      case 'speech.configure': {
        const p = rawParams as RpcParams<'speech.configure'>;
        this.#speech = { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath };
        if (p.groqKey !== undefined) this.#speechStatus.groqKeySet = !!p.groqKey;
        if (p.openrouterKey !== undefined) this.#speechStatus.openrouterKeySet = !!p.openrouterKey;
        this.#speechStatus.engine = p.engine; this.#speechStatus.revision = crypto.randomUUID();
        this.#speechStatus.ready = p.engine === 'local' ? this.#speechStatus.localReady : p.apiProvider === 'groq' ? this.#speechStatus.groqKeySet : this.#speechStatus.openrouterKeySet;
        return { ...this.#speechStatus };
      }
      case 'speech.install':
        this.#speechStatus.localReady = true; this.#speechStatus.ready = this.#speech.engine === 'local' || this.#speechStatus.ready;
        return { ...this.#speechStatus };
      case 'speech.installCancel': return { ...this.#speechStatus };
      case 'speech.uninstall':
        this.#speechStatus.localReady = false; if (this.#speech.engine === 'local') this.#speechStatus.ready = false;
        return { ...this.#speechStatus };
      case 'speech.cancel': this.#speechRequests.delete((rawParams as RpcParams<'speech.cancel'>).requestId); return { ok: true };
      case 'speech.transcribe': {
        const p = rawParams as RpcParams<'speech.transcribe'>;
        if (!this.#speechStatus.ready) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Configure Voice first' });
        if (p.revision !== this.#speechStatus.revision) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Voice settings changed during recording; record again with the selected engine' });
        if (this.#speechRequests.size) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Another transcription is running; try again shortly' });
        const request = Symbol(p.requestId);
        this.#speechRequests.set(p.requestId, request);
        await new Promise(resolve => setTimeout(resolve, 250));
        if (this.#speechRequests.get(p.requestId) !== request) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Transcription cancelled' });
        this.#speechRequests.delete(p.requestId);
        return { text: 'Please add a test for this change.' };
      }
      case 'keybindings.get':
        return structuredClone(this.#keybindings);
      case 'keybindings.set': {
        const { command, chord } = rawParams as RpcParams<'keybindings.set'>;
        if (!(KEYBINDING_COMMANDS as readonly string[]).includes(command)) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `command: "${command}" is not a command Boite has` });
        }
        if (chord !== null) {
          const parsed = parseChord(chord);
          if (!parsed.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `chord: ${parsed.reason}` });
        }
        this.#keybindings = { ...this.#keybindings, bindings: { ...this.#keybindings.bindings, [command]: chord === null ? null : chord.trim().toLowerCase() } };
        this.#emit('keybindings.updated', structuredClone(this.#keybindings));
        return structuredClone(this.#keybindings);
      }
      case 'keybindings.reset': {
        const { command } = rawParams as RpcParams<'keybindings.reset'>;
        const bindings = { ...this.#keybindings.bindings };
        if (command === undefined) for (const id of KEYBINDING_COMMANDS) delete bindings[id];
        else delete bindings[command];
        this.#keybindings = { ...this.#keybindings, bindings };
        this.#emit('keybindings.updated', structuredClone(this.#keybindings));
        return structuredClone(this.#keybindings);
      }
      case 'settings.set': {
        const params = rawParams as RpcParams<'settings.set'>;
        for (const field of ['maxConcurrentTurns', 'perAccountConcurrency'] as const) {
          const value = params[field];
          if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
            throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `${field} must be a positive integer`, data: { field } });
          }
        }
        this.#settings = { ...this.#settings, ...params };
        this.#scheduler = {
          ...this.#scheduler,
          maxConcurrentTurns: this.#settings.maxConcurrentTurns,
          perAccountConcurrency: this.#settings.perAccountConcurrency
        };
        this.#emit('scheduler.updated', structuredClone(this.#scheduler));
        this.#emit('settings.updated', { ...this.#settings });
        return { ...this.#settings };
      }

      case 'imports.list': {
        const params = rawParams as RpcParams<'imports.list'>;
        if (!this.#projects.some((p) => p.id === params.projectId)) throw this.#notFound('project', params.projectId);
        await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
        // Newest first, the core's order.
        return structuredClone(
          this.#importable
            .filter((session) => session.projectId === params.projectId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ projectId: _p, ...session }) => session)
        );
      }
      case 'imports.run': {
        const params = rawParams as RpcParams<'imports.run'>;
        const project = this.#projects.find((p) => p.id === params.projectId);
        if (!project) throw this.#notFound('project', params.projectId);
        const session = this.#importable.find((entry) => entry.projectId === params.projectId && entry.sessionId === params.sessionId);
        if (!session) {
          throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no transcript for session ${params.sessionId}`, data: { sessionId: params.sessionId } });
        }
        if (session.threadId !== null) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this session is already a thread', data: { sessionId: params.sessionId, threadId: session.threadId } });
        }
        await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
        const id: ThreadId = `t-${++this.#seq}`;
        const turnA: Turn = { id: `turn-${id}-1`, threadId: id, status: 'done', queuedAt: session.startedAt, startedAt: session.startedAt, finishedAt: session.startedAt + 4_000, usage: null, error: null };
        const turnB: Turn = { id: `turn-${id}-2`, threadId: id, status: 'done', queuedAt: session.updatedAt - 9_000, startedAt: session.updatedAt - 9_000, finishedAt: session.updatedAt, usage: null, error: null };
        const thread: Thread = {
          id,
          projectId: params.projectId,
          title: session.title,
          titleSource: 'agent',
          providerId: 'claude',
          accountId: params.accountId,
          model: 'claude-sonnet-5',
          effort: null,
          cwd: project.path,
          branch: null,
          permissionMode: 'default',
          status: 'idle',
          unread: false,
          archived: false,
          pinned: false,
          sessionId: session.sessionId,
          load: null,
          context: null,
          createdAt: session.startedAt,
          updatedAt: session.updatedAt,
          commands: [],
          messagesBefore: null,
          turns: [turnA, turnB],
          messages: [
            { id: `${id}-m1`, threadId: id, turnId: turnA.id, role: 'user', parts: [{ type: 'text', text: 'Where does the shell look for a core, in what order?' }], state: 'complete', createdAt: turnA.queuedAt },
            {
              id: `${id}-m2`, threadId: id, turnId: turnA.id, role: 'assistant', state: 'complete', createdAt: turnA.queuedAt + 1_000,
              parts: [
                { type: 'thinking', text: 'The order lives in the Rust side, next to the sidecar lookup.' },
                { type: 'tool', toolId: `${id}-tool-1`, name: 'Grep', input: { pattern: 'boite-core', path: 'apps/shell/src-tauri/src' }, output: 'apps/shell/src-tauri/src/core.rs:41\napps/shell/src-tauri/src/core.rs:58', status: 'done' },
                { type: 'text', text: 'Three places, in order: the sidecar beside the exe, `BOITE_CORE` in the environment, then `bun run core` from the repository.' }
              ]
            },
            { id: `${id}-m3`, threadId: id, turnId: turnB.id, role: 'user', parts: [{ type: 'text', text: 'Write that down in docs/releasing.md' }], state: 'complete', createdAt: turnB.queuedAt },
            { id: `${id}-m4`, threadId: id, turnId: turnB.id, role: 'assistant', state: 'complete', createdAt: turnB.queuedAt + 2_000, parts: [{ type: 'text', text: 'Done: a short list under "Where the shell looks for a core".' }] }
          ]
        };
        this.#threads.set(id, thread);
        session.threadId = id;
        this.#emit('thread.created', structuredClone(toSummary(thread)));
        return structuredClone(toSummary(thread));
      }

      // ---------------------------------------------------------- the workbench
      // What the agent's CLI asks for, and what the right panel's surfaces read
      // behind the same methods.

      case 'agent.where': {
        const params = rawParams as RpcParams<'agent.where'>;
        const thread = this.#thread(params.threadId);
        const project = this.#projects.find((one) => one.id === thread.projectId);
        if (!project) throw this.#notFound('project', thread.projectId);
        const where: AgentWhere = {
          threadId: thread.id,
          title: thread.title,
          projectId: project.id,
          projectPath: project.path,
          cwd: thread.cwd,
          branch: thread.branch,
          // A thread of its own worktree does not sit in the project directory.
          worktree: thread.cwd !== project.path,
          providerId: thread.providerId,
          // A thread on no model of its own runs the provider's default.
          model: thread.model ?? 'default'
        };
        return where;
      }
      case 'panel.open': {
        const params = rawParams as RpcParams<'panel.open'>;
        const thread = this.#thread(params.threadId);
        const surface = this.#checkSurface(thread.cwd, params.surface);
        // The core sends this to every client subscribed to the thread, and
        // `shown` says whether there was one to receive it.
        const shown = this.#subscribed.has(thread.id);
        this.#emitToThread(thread.id, 'panel.requested', {
          threadId: thread.id,
          surface,
          at: this.#now()
        });
        return { shown };
      }
      case 'threads.tasks.set': {
        const params = rawParams as RpcParams<'threads.tasks.set'>;
        const thread = this.#thread(params.threadId);
        const activity: ThreadActivity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
        activity.tasks = params.tasks.map((task): AgentTask => ({ id: task.id, text: task.text, status: task.status }));
        // A fresh list is something new to look at, so a dismissal does not hold.
        activity.tasksDismissed = false;
        thread.activity = activity;
        this.#publishActivity(thread);
        return structuredClone(activity);
      }
      case 'threads.tasks.get': {
        const params = rawParams as RpcParams<'threads.tasks.get'>;
        return structuredClone(this.#thread(params.threadId).activity?.tasks ?? []);
      }

      case 'todos.list': {
        const params = rawParams as RpcParams<'todos.list'>;
        return this.#projectTodos(this.#thread(params.threadId).projectId);
      }
      case 'todos.add': {
        const params = rawParams as RpcParams<'todos.add'>;
        const thread = this.#thread(params.threadId);
        const at = this.#now();
        const todo: Todo = {
          id: `todo-${++this.#seq}`,
          projectId: thread.projectId,
          text: todoText(params.text),
          status: 'open',
          threadId: thread.id,
          createdAt: at,
          updatedAt: at
        };
        this.#todos.push(todo);
        this.#emitTodos(thread.projectId);
        return structuredClone(todo);
      }
      case 'todos.update': {
        const params = rawParams as RpcParams<'todos.update'>;
        const thread = this.#thread(params.threadId);
        const todo = this.#todos.find((one) => one.id === params.todoId && one.projectId === thread.projectId);
        if (!todo) throw this.#notFound('todo', params.todoId);
        // The status is checked before the text moves, as the core's `updateTodo`
        // builds the whole card before it saves anything.
        if (params.status !== undefined && !TODO_STATUSES.includes(params.status)) {
          throw refusal(`a todo is ${TODO_STATUSES.join(', ')}, not ${String(params.status)}`);
        }
        if (params.text !== undefined) todo.text = todoText(params.text);
        if (params.status !== undefined) todo.status = params.status;
        todo.threadId = thread.id;
        todo.updatedAt = this.#now();
        this.#emitTodos(thread.projectId);
        return structuredClone(todo);
      }
      case 'todos.remove': {
        const params = rawParams as RpcParams<'todos.remove'>;
        const thread = this.#thread(params.threadId);
        const index = this.#todos.findIndex((one) => one.id === params.todoId && one.projectId === thread.projectId);
        if (index < 0) throw this.#notFound('todo', params.todoId);
        this.#todos.splice(index, 1);
        this.#emitTodos(thread.projectId);
        return { ok: true as const };
      }

      case 'git.status': {
        const params = rawParams as RpcParams<'git.status'>;
        const thread = this.#thread(params.threadId);
        const branch = thread.branch ?? 'main';
        const status: GitStatus = {
          branch,
          upstream: `origin/${branch}`,
          ahead: 2,
          behind: 1,
          changes: structuredClone(FAKE_CHANGES)
        };
        return status;
      }
      case 'git.diff': {
        const params = rawParams as RpcParams<'git.diff'>;
        const path = this.#inside(this.#thread(params.threadId).cwd, params.path, 'git.diff path');
        const change = FAKE_CHANGES.find((one) => one.path === path);
        if (!change) throw this.#notFound('change', path);
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
      }

      case 'files.list': {
        const params = rawParams as RpcParams<'files.list'>;
        const cwd = this.#thread(params.threadId).cwd;
        return this.#listDir(this.#inside(cwd, params.path ?? '', 'files.list path', 'dir'));
      }
      case 'files.read': {
        const params = rawParams as RpcParams<'files.read'>;
        const path = this.#inside(this.#thread(params.threadId).cwd, params.path, 'files.read path', 'file');
        // A picture, a sound and anything else binary answer as a url, the way
        // the core hands out a ticket, except that these carry their own bytes.
        const media = FAKE_MEDIA[path];
        if (media) {
          const url = media.url();
          const blob: FileContent = {
            kind: media.kind,
            path,
            bytes: fakeBytes(path, undefined),
            modifiedAt: this.#fileTime(path),
            mime: media.mime,
            url
          };
          return blob;
        }
        const text = this.#files.get(path) ?? '';
        const content: FileContent = {
          kind: 'text',
          path,
          bytes: text.length,
          modifiedAt: this.#fileTime(path),
          text,
          truncated: false,
          language: fakeLanguage(path)
        };
        return content;
      }
      case 'files.write': {
        const params = rawParams as RpcParams<'files.write'>;
        const cwd = this.#thread(params.threadId).cwd;
        const path = this.#inside(cwd, params.path, 'files.write path');
        // The file may be new, its directory may not, and what is there already has to be a file.
        this.#inside(cwd, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', 'files.write path directory', 'dir');
        if (this.#isDir(path)) throw refusal(`files.write path is not a file: ${params.path}`);
        if (FAKE_MEDIA[path]) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this file is not text' });
        }
        this.#files.set(path, params.text);
        return { bytes: params.text.length, modifiedAt: this.#now() };
      }

      default: {
        const unreachable: never = method;
        throw new RpcFailure({
          code: RpcErrorCode.MethodNotFound,
          message: `unknown method ${String(unreachable)}`
        });
      }
    }
  }

  #coordinationConfig(threadId: ThreadId): CoordinationConfig {
    return this.#coordination.get(threadId) ?? { mode: 'off', resources: '', remote: false, paused: false };
  }

  #delegationRoot(threadId: ThreadId): ThreadId {
    const thread = this.#thread(threadId);
    return thread.parentThreadId ?? thread.id;
  }

  #delegationConfig(rootId: ThreadId): DelegationConfig {
    return structuredClone(this.#delegationConfigs.get(rootId) ?? DEFAULT_DELEGATION_CONFIG);
  }

  #delegatedAgent(row: { threadId: ThreadId; profileId: string; task: string }): DelegatedAgent {
    const thread = this.#thread(row.threadId);
    const lastTurn = thread.turns.at(-1) ?? null;
    const result = lastTurn && !['queued', 'running'].includes(lastTurn.status)
      ? thread.messages.filter(message => message.turnId === lastTurn.id && message.role === 'assistant').at(-1)?.parts
          .filter(part => part.type === 'text').map(part => part.text).join('\n').trim().slice(0, 4000) || lastTurn.error
      : null;
    return { thread: structuredClone(toSummary(thread)), profileId: row.profileId, task: row.task, lastTurn: structuredClone(lastTurn), result: result || null };
  }

  #delegationView(rootId: ThreadId, callerId = rootId): DelegationView {
    this.#thread(rootId);
    const rows = this.#delegationAgents.get(rootId) ?? [];
    let usage = emptyUsage();
    for (const row of rows) for (const turn of this.#thread(row.threadId).turns) if (turn.usage) usage = addUsage(usage, turn.usage);
    return {
      rootThreadId: rootId,
      config: this.#delegationConfig(rootId),
      agents: rows.map(row => this.#delegatedAgent(row)),
      messages: structuredClone((this.#delegationLetters.get(rootId) ?? []).filter(letter => callerId === rootId || letter.from.threadId === callerId || letter.to.threadId === callerId)),
      turnsUsed: this.#delegationTurns.get(rootId) ?? 0,
      usage
    };
  }

  async #stopDelegation(rootId: ThreadId, agentId?: ThreadId): Promise<number> {
    const rows = this.#delegationAgents.get(rootId) ?? [];
    const selected = agentId ? rows.filter(row => row.threadId === agentId) : rows;
    if (agentId && selected.length === 0) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agentId must name a direct child' });
    if (!agentId) this.#delegationConfigs.set(rootId, { ...this.#delegationConfig(rootId), paused: true });
    let stopped = 0;
    for (const row of selected) {
      const thread = this.#thread(row.threadId);
      if (['queued', 'running', 'waiting'].includes(thread.status)) stopped += 1;
      const queued = thread.turns.at(-1);
      if (queued?.status === 'queued') {
        queued.status = 'stopped';
        queued.finishedAt = this.#now();
        this.#scheduler.queued = this.#scheduler.queued.filter(entry => entry.turnId !== queued.id);
      }
      await this.#stopTurn(thread.id);
      thread.status = 'idle';
      this.#touch(thread);
    }
    return stopped;
  }

  #seedDelegationDemo(): void {
    const demoAt = Date.now() - 85_000;
    const root = this.#thread('t-trace');
    const reviewer: DelegationProfile = { id: 'reviewer', name: 'Reviewer', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-sonnet-5', effort: 'high' };
    const implementer: DelegationProfile = { id: 'implementer', name: 'Implementer', providerId: 'codex', accountId: 'a-codex', model: 'gpt-5.6-sol', effort: 'medium' };
    this.#delegationConfigs.set(root.id, { enabled: true, paused: false, maxAgents: 4, maxConcurrent: 2, maxTurns: 12, maxMinutes: 30, profiles: [reviewer, implementer] });
    const make = (id: string, title: string, task: string, status: Thread['status'], answer: string, profile: DelegationProfile): Thread => {
      const turn: Turn = { id: `turn-${id}`, threadId: id, status: status === 'running' ? 'running' : 'done', queuedAt: demoAt, startedAt: demoAt + 1000, finishedAt: status === 'running' ? null : demoAt + 30_000, usage: status === 'running' ? null : { inputTokens: 820, outputTokens: 260, cacheReadTokens: 1200, cacheWriteTokens: 0, costUsdEquivalent: 0.012 }, error: null };
      return {
        ...root, id, parentThreadId: root.id, title, titleSource: 'user', status, unread: false, archived: false, pinned: false,
        providerId: profile.providerId, accountId: profile.accountId, model: profile.model, effort: profile.effort,
        sessionId: `session-${id}`, sessionGeneration: 0, selectionVersion: 0, load: status === 'running' ? { processes: 1, cpuPercent: 8, memoryBytes: 64 * 1024 * 1024 } : null,
        createdAt: demoAt, updatedAt: demoAt + 30_000, messagesBefore: null, commands: [], turns: [turn],
        messages: [
          { id: `m-${id}-1`, threadId: id, turnId: turn.id, role: 'user', parts: [{ type: 'text', text: task }], state: 'complete', createdAt: demoAt },
          { id: `m-${id}-2`, threadId: id, turnId: turn.id, role: 'assistant', parts: [{ type: 'text', text: answer }], state: status === 'running' ? 'streaming' : 'complete', createdAt: demoAt + 10_000 }
        ]
      };
    };
    const running = make('t-team-running', 'Audit subscription flow', 'Check selection races and own the store tests.', 'running', 'I found the subscription boundary and am checking stale responses.', reviewer);
    const done = make('t-team-done', 'Review panel copy', 'Review the panel wording and report confusing states.', 'idle', 'The queued delivery label now matches the core state.', implementer);
    this.#threads.set(running.id, running);
    this.#threads.set(done.id, done);
    this.#delegationAgents.set(root.id, [
      { threadId: running.id, profileId: reviewer.id, task: 'Check selection races and own the store tests.' },
      { threadId: done.id, profileId: implementer.id, task: 'Review the panel wording and report confusing states.' }
    ]);
    this.#delegationTurns.set(root.id, 2);
  }

  #coordinationView(threadId: ThreadId): CoordinationView {
    const config = this.#coordinationConfig(threadId);
    const letters = this.#letters.get(threadId) ?? [];
    const sendLimit = config.mode === 'brief' ? 6 : config.mode === 'team' ? 40 : 0;
    const wakeLimit = config.mode === 'brief' ? 2 : config.mode === 'team' ? 12 : 0;
    return {
      self: { coreId: this.#identity.coreId, threadId },
      config: structuredClone(config),
      messages: structuredClone(letters),
      sent: letters.filter(letter => letter.from.coreId === this.#identity.coreId && letter.from.threadId === threadId && letter.createdAt > this.#now() - 3_600_000).length,
      sendLimit,
      wakes: 0,
      wakeLimit
    };
  }

  #quotas(): AccountQuota[] {
    const accounts = [...this.#accounts, { id: 'quota:antigravity-cli', providerId: 'antigravity', label: 'Antigravity CLI' }];
    return accounts.map((account, index) => ({
      accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : this.#providers.find((p) => p.id === account.providerId)?.name ?? account.providerId,
      label: account.label, enabled: account.id === 'quota:antigravity-cli' ? this.#quotaEnabled[account.id] === true : this.#quotaEnabled[account.id] !== false,
      status: account.providerId === 'echo' || account.providerId === 'pi' || account.id === 'a-antigravity' ? 'unsupported' : this.#quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && this.#quotaEnabled[account.id] !== true ? 'disabled' : 'ready',
      checkedAt: Date.now(), error: null,
      windows: this.#quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && this.#quotaEnabled[account.id] !== true ? [] : [
        { id: 'primary', label: '5 hours', usedPercent: [32, 87, 14, 48, 71, 6, 23, 40][index % 8]!, resetsAt: Date.now() + (1 + index % 4) * 3600_000 },
        { id: 'secondary', label: 'Weekly', usedPercent: [61, 94, 38, 27, 55, 12, 73, 66][index % 8]!, resetsAt: Date.now() + (1 + index % 6) * 86400_000 },
      ],
    }));
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async #stopTurn(threadId: ThreadId): Promise<boolean> {
    this.#pauseActivity(this.#thread(threadId));
    const running = this.#inFlight.get(threadId);
    let stopped = running !== undefined;
    if (running) running.cancelled = true;
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.request.threadId !== threadId) continue;
      stopped = true;
      this.#pendingPermissions.delete(requestId);
      pending.resolve('deny');
    }
    for (const [questionId, pending] of [...this.#pendingQuestions]) {
      if (pending.request.threadId !== threadId) continue;
      stopped = true;
      this.#pendingQuestions.delete(questionId);
      pending.resolve(null);
    }
    await running?.done;
    return stopped;
  }

  #startTurn(threadId: ThreadId, prompt: string, attachments: Attachment[] = [], operation?: 'compact' | 'delegation', activityKind?: 'goal' | 'loop', queuedTurn?: Turn): Turn {
    const thread = this.#thread(threadId);
    if (thread.archived) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot start a turn on an archived thread', data: { threadId } });
    }
    if ((!queuedTurn && ['queued', 'running', 'waiting'].includes(thread.status)) || (queuedTurn && (thread.status !== 'queued' || queuedTurn.status !== 'queued')) || this.#inFlight.has(threadId)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn', data: { threadId } });
    }
    // The agent names what it takes on its first turn, the way the echo driver
    // does: the list is the agent's, so it only exists once one has run.
    if (thread.commands.length === 0) {
      thread.commands = structuredClone(ECHO_COMMANDS);
      this.#emitToThread(threadId, 'thread.commands', {
        threadId,
        commands: structuredClone(thread.commands)
      });
    }

    const at = this.#now();
    const execution: NonNullable<Turn['execution']> = {
        providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
        effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode, sessionId: thread.sessionId,
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
        ...(operation ? { operation } : {}),
    };
    const turn: Turn = queuedTurn ?? {
      id: `turn-${++this.#seq}`, threadId, status: 'running', queuedAt: at,
      startedAt: at, finishedAt: null, usage: null, error: null, execution
    };
    if (queuedTurn) Object.assign(turn, { status: 'running', startedAt: at, execution });
    else thread.turns.push(turn);

    const user: Message = {
      id: `m-${++this.#seq}`,
      threadId,
      turnId: turn.id,
      role: 'user',
      // The images ride after the text, the order the core journals them in.
      parts: [
        { type: 'text', text: activityKind ? `/${activityKind} ${prompt}` : prompt, ...(activityKind ? { activity: { kind: activityKind, iteration: (thread.activity?.[activityKind]?.iterations ?? 0) + 1 } } : {}) },
        ...attachments.map((attachment): MessagePart => attachment.kind === 'file' ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name } : ({
          type: 'image',
          mimeType: attachment.mimeType,
          data: attachment.data,
          alt: attachment.name
        }))
      ],
      state: 'complete',
      createdAt: at
    };
    if (!activityKind && !operation && thread.activity) {
      if (thread.activity.tasks.length && thread.activity.tasks.every(task => task.status === 'completed')) thread.activity.tasksDismissed = true;
      if (thread.activity.goal?.status === 'complete') thread.activity.goal.dismissed = true;
      this.#publishActivity(thread);
    }
    thread.messages.push(user);
    this.#emitToThread(threadId, 'message.started', structuredClone(user));
    this.#emitToThread(threadId, 'message.completed', {
      threadId,
      messageId: user.id,
      state: 'complete'
    });

    thread.status = 'running';
    thread.sessionId = thread.sessionId ?? `sess-${turn.id}`;
    this.#touch(thread);
    this.#emit('turn.started', structuredClone(turn));
    this.#pushScheduler(turn, 'running');

    const record = { cancelled: false, done: Promise.resolve() };
    record.done = this.#stream(thread, turn, prompt, record, attachments);
    this.#inFlight.set(threadId, record);

    return structuredClone(turn);
  }

  async #stream(
    thread: Thread,
    turn: Turn,
    prompt: string,
    record: { cancelled: boolean },
    attachments: Attachment[] = []
  ): Promise<void> {
    const compactAfter = Math.max(1, Math.floor((thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) / 4));
    const message: Message = {
      id: `m-${++this.#seq}`,
      threadId: thread.id,
      turnId: turn.id,
      role: 'assistant',
      parts: [{ type: 'thinking', text: '' }],
      state: 'streaming',
      createdAt: this.#now()
    };
    thread.messages.push(message);
    this.#emitToThread(thread.id, 'message.started', structuredClone(message));

    // The reasoning first, in two deltas, the way a provider streams a thinking block.
    const reasoning = `thinking about: ${prompt}`;
    const cut = Math.ceil(reasoning.length / 2);
    for (const piece of [reasoning.slice(0, cut), reasoning.slice(cut)]) {
      if (record.cancelled || piece.length === 0) break;
      await this.#pause();
      const part = message.parts[0];
      if (part && part.type === 'thinking') part.text += piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex: 0,
        text: piece
      });
    }

    const textIndex = message.parts.length;
    message.parts.push({ type: 'text', text: '' });
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex: textIndex,
      part: { type: 'text', text: '' }
    });

    // `/shout <text>` comes back in capitals, the one command the fake acts on.
    const shouted = prompt.startsWith(`/${SHOUT} `) ? prompt.slice(SHOUT.length + 2) : null;
    const echoed = shouted === null ? prompt : shouted.toUpperCase();

    // An image is named back the way the echo driver names it, format and
    // weight first, then the prompt itself is echoed.
    const reply =
      attachments
        .map(
          (attachment) =>
            `[${attachment.kind} ${attachment.mimeType}, ${decodedBytes(attachment.data)} bytes${
              attachment.name === null ? '' : `, ${attachment.name}`
            }] `
        )
        .join('') + echoed;

    for (const piece of chunkText(reply, 5)) {
      if (record.cancelled) break;
      await this.#pause();
      const part = message.parts[textIndex];
      if (part && part.type === 'text') part.text += piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex: textIndex,
        text: piece
      });
    }

    if (!record.cancelled && prompt.includes('[permission]')) {
      await this.#askPermission(thread, turn, message);
    }
    // The bare word, like the echo driver: the fake agent asks one question.
    if (!record.cancelled && /\bquestion\b/.test(prompt)) {
      await this.#askQuestion(thread, turn, message);
    }
    if (!record.cancelled && prompt.includes('[tool-stream]')) {
      await this.#streamToolInput(thread, message);
    }
    if (!record.cancelled && prompt.includes('[tool]')) {
      await this.#runTool(thread, message);
    }
    if (!record.cancelled && prompt.includes('[diff]')) {
      await this.#documentTool(thread, message, 'Edit', { file_path: DIFF_PATH }, 'edited 1 file', [
        { kind: 'diff', path: DIFF_PATH, oldText: DIFF_OLD, newText: DIFF_NEW }
      ]);
    }
    if (!record.cancelled && prompt.includes('[doc]')) {
      await this.#documentTool(thread, message, 'Read', { file_path: DOC_TITLE }, `read ${DOC_TITLE}`, [
        { kind: 'markdown', title: DOC_TITLE, text: DOC_TEXT }
      ]);
    }
    if (!record.cancelled && prompt.includes('[image]')) {
      await this.#documentTool(thread, message, 'Screenshot', { region: 'window' }, 'captured the window', [
        { kind: 'image', mimeType: 'image/png', data: IMAGE_BASE64, alt: 'one pixel' }
      ]);
    }
    const spawn = SPAWN_MARKER.exec(prompt);
    if (!record.cancelled && spawn && spawn[1]) {
      await this.#spawnProcess(thread, spawn[1]);
    }

    if (!record.cancelled && prompt === '[compact]') {
      const part: MessagePart = { type: 'compaction', trigger: 'manual', preTokens: thread.context?.tokens ?? null, postTokens: compactAfter };
      const partIndex = message.parts.length;
      message.parts.push(part);
      this.#emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part });
    }
    message.state = 'complete';
    this.#emitToThread(thread.id, 'message.completed', {
      threadId: thread.id,
      messageId: message.id,
      state: 'complete'
    });

    const usage: Usage = {
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEquivalent: Math.round(prompt.length * 0.02) / 1000
    };
    turn.status = record.cancelled ? 'stopped' : 'done';
    turn.finishedAt = this.#now();
    turn.usage = usage;
    this.#usage.set(thread.id, addUsage(this.#usage.get(thread.id) ?? emptyUsage(), usage));
    this.#finished.push({ at: turn.finishedAt, threadId: thread.id, title: thread.title, projectId: thread.projectId, providerId: thread.providerId, model: thread.model, usage });

    this.#inFlight.delete(thread.id);
    thread.status = 'idle';
    thread.unread = !this.#subscribed.has(thread.id);
    // The context meter grows with every turn, the way a real session's does.
    thread.context = {
      tokens: prompt === '[compact]' && !record.cancelled ? compactAfter : (thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) + FAKE_CONTEXT_PER_TURN + prompt.length * 4,
      window: FAKE_CONTEXT_WINDOW,
      at: this.#now()
    };
    this.#touch(thread);
    this.#emit('turn.finished', structuredClone(turn));
    this.#pushScheduler(turn, 'finished');
    if (turn.execution?.operation === 'delegation' && thread.parentThreadId) {
      const root = thread.parentThreadId;
      const text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim().slice(0, 4000);
      const config = this.#delegationConfig(root);
      if (!record.cancelled && config.enabled && !config.paused) {
        const letter: AgentLetter = {
          id: `letter-${++this.#seq}`,
          origin: 'result',
          from: { coreId: 'local', threadId: thread.id, title: thread.title, machine: 'Boite', resources: '', status: thread.status, mode: 'team' },
          to: { coreId: 'local', threadId: root },
          toTitle: this.#thread(root).title,
          text,
          replyTo: null,
          createdAt: this.#now(),
          expiresAt: Number.MAX_SAFE_INTEGER,
          status: 'received',
          error: null
        };
        this.#delegationLetters.set(root, [...(this.#delegationLetters.get(root) ?? []), letter]);
      }
      this.#pumpDelegation(root);
      this.#emit('delegation.changed', { threadId: root });
    }
  }

  #pumpDelegation(rootId: ThreadId): void {
    const config = this.#delegationConfig(rootId);
    if (!config.enabled || config.paused) return;
    const rows = this.#delegationAgents.get(rootId) ?? [];
    let running = rows.filter(row => ['running', 'waiting'].includes(this.#thread(row.threadId).status)).length;
    for (const row of rows) {
      if (running >= config.maxConcurrent) break;
      const thread = this.#thread(row.threadId);
      const turn = thread.turns.at(-1);
      if (thread.status !== 'queued' || turn?.status !== 'queued') continue;
      this.#scheduler.queued = this.#scheduler.queued.filter(entry => entry.turnId !== turn.id);
      this.#scheduler.queued.forEach((entry, index) => { entry.position = index + 1; });
      this.#startTurn(thread.id, row.task, [], 'delegation', undefined, turn);
      running += 1;
    }
  }

  async #askPermission(thread: Thread, turn: Turn, message: Message): Promise<void> {
    const requestId = `req-${++this.#seq}`;
    const partIndex = message.parts.length;
    const part: MessagePart = {
      type: 'permission',
      requestId,
      toolName: 'Write',
      decision: null
    };
    message.parts.push(part);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(part)
    });

    const request: PermissionRequest = {
      id: requestId,
      threadId: thread.id,
      turnId: turn.id,
      toolName: 'Write',
      input: { path: `${thread.cwd}\\notes.md`, contents: 'the thing you asked for' },
      description: 'Write a file inside the working directory',
      createdAt: this.#now()
    };
    thread.status = 'waiting';
    this.#touch(thread);
    this.#emit('permission.requested', structuredClone(request));

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.#pendingPermissions.set(requestId, { request, resolve });
    });

    this.#settlePermission(thread, message, partIndex, request, decision);
    thread.status = 'running';
    this.#touch(thread);
  }

  async #askQuestion(thread: Thread, turn: Turn, message: Message): Promise<void> {
    const questionId = `qst-${++this.#seq}`;
    const partIndex = message.parts.length;
    const asked = {
      text: QUESTION_TEXT,
      options: QUESTION_OPTIONS,
      allowText: true,
      multiple: false
    };
    const part: MessagePart = { type: 'question', questionId, ...asked, answer: null };
    message.parts.push(part);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(part)
    });

    const request: QuestionRequest = {
      id: questionId,
      threadId: thread.id,
      turnId: turn.id,
      ...asked,
      createdAt: this.#now()
    };
    thread.status = 'waiting';
    this.#touch(thread);
    this.#emit('question.asked', structuredClone(request));

    const answer = await new Promise<QuestionAnswer | null>((resolve) => {
      this.#pendingQuestions.set(questionId, { request, resolve });
    });

    this.#settleQuestion(thread, message, partIndex, request, answer);
    thread.status = 'running';
    this.#touch(thread);
  }

  /** The answer written into the part, then the event, whichever path answered. */
  #settleQuestion(
    thread: Thread,
    message: Message,
    partIndex: number,
    request: QuestionRequest,
    answer: QuestionAnswer | null
  ): void {
    const stored = message.parts[partIndex];
    if (stored && stored.type === 'question') stored.answer = answer;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: {
        type: 'question',
        questionId: request.id,
        text: request.text,
        options: request.options,
        allowText: request.allowText,
        multiple: request.multiple,
        answer
      }
    });
    this.#emit('question.answered', { questionId: request.id, threadId: thread.id, answer });
  }

  /** Writes the answer into the part and tells everyone, whichever path asked. */
  #settlePermission(
    thread: Thread,
    message: Message,
    partIndex: number,
    request: PermissionRequest,
    decision: 'allow' | 'deny'
  ): void {
    const stored = message.parts[partIndex];
    if (stored && stored.type === 'permission') stored.decision = decision;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: { type: 'permission', requestId: request.id, toolName: request.toolName, decision }
    });
    this.#emit('permission.resolved', { requestId: request.id, threadId: thread.id, decision });
  }

  /**
   * A tool whose input the model is still typing: the part opens with no input
   * and an empty `inputText`, the JSON arrives as deltas, then the parsed input
   * replaces it. The same shape the Claude driver's `input_json_delta` produces.
   */
  async #streamToolInput(thread: Thread, message: Message): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const opening: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Bash',
      input: {},
      inputText: '',
      output: null,
      status: 'running'
    };
    message.parts.push(opening);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(opening)
    });

    for (const piece of chunkText(STREAMED_TOOL_INPUT, 4)) {
      await this.#pause();
      const part = message.parts[partIndex];
      if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex,
        text: piece
      });
    }

    await this.#pause();
    const done: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Bash',
      input: JSON.parse(STREAMED_TOOL_INPUT) as unknown,
      inputText: null,
      output: 'streamed',
      status: 'done'
    };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  /** One tool that lands whole, carrying the documents it produced. */
  async #documentTool(
    thread: Thread,
    message: Message,
    name: string,
    input: unknown,
    output: string,
    documents: ToolDocument[]
  ): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const running: MessagePart = {
      type: 'tool',
      toolId,
      name,
      input,
      output: null,
      status: 'running',
      documents
    };
    message.parts.push(running);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(running)
    });

    await this.#pause();

    const done: MessagePart = { ...running, output, status: 'done' };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  async #runTool(thread: Thread, message: Message): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const input = { pattern: 'registerMethods', path: thread.cwd };
    const running: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Grep',
      input,
      output: null,
      status: 'running'
    };
    message.parts.push(running);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(running)
    });

    await this.#pause();

    const done: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Grep',
      input,
      output: 'packages/core/src/modules.ts:12\npackages/core/src/server.ts:44',
      status: 'done'
    };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  async #spawnProcess(thread: Thread, exe: string): Promise<void> {
    const pid = 10_000 + ++this.#seq;
    const record: ProcessRecord = {
      pid,
      parentPid: this.#core.pid,
      threadId: thread.id,
      exe,
      commandLine: `${exe} --from boite`,
      startedAt: this.#now(),
      exitedAt: null,
      exitCode: null,
      cpuMs: null,
      peakMemoryBytes: null,
      ioBytes: null
    };
    this.#processes.push(record);
    thread.load = { processes: 1, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#touch(thread);
    this.#emit('process.started', structuredClone(record));

    await this.#pause();

    record.exitedAt = this.#now();
    record.exitCode = 0;
    record.cpuMs = 120;
    record.peakMemoryBytes = 48 * 1024 * 1024;
    record.ioBytes = 32 * 1024;
    thread.load = null;
    this.#touch(thread);
    this.#emit('process.exited', structuredClone(record));
  }

  // -------------------------------------------------------------------------
  // Account login
  // -------------------------------------------------------------------------

  #loginEvent(event: RpcEvents['account.login']): void {
    if (event.state === 'running') {
      const existing = this.#logins.get(event.accountId);
      this.#logins.set(event.accountId, existing ? Object.assign(existing, event) : event);
    } else this.#logins.delete(event.accountId);
    this.#emit('account.login', structuredClone(event));
  }

  #cancelLogin(accountId: string): void {
    if (!this.#logins.has(accountId)) return;
    this.#loginEvent({ accountId, state: 'done', output: 'Login cancelled', url: null, exitCode: null });
  }

  /** What a provider CLI prints first: a link to open, then a question. */
  async #fakeLoginPrompt(accountId: string): Promise<void> {
    const active = this.#logins.get(accountId);
    await this.#pause();
    if (!active || this.#logins.get(accountId) !== active) return;
    this.#loginEvent({
      accountId,
      state: 'running',
      output: 'Open https://example.invalid/login?code=fake to continue',
      url: 'https://example.invalid/login?code=fake',
      exitCode: null
    });
  }

  async #finishFakeLogin(account: Account): Promise<void> {
    const active = this.#logins.get(account.id);
    await this.#pause();
    if (!active || this.#logins.get(account.id) !== active) return;
    this.#loginEvent({
      accountId: account.id,
      state: 'done',
      output: 'logged in',
      url: 'https://example.invalid/login?code=fake',
      exitCode: 0
    });
    account.status = 'ok';
    account.identity = 'you@example.com';
    this.#emit('accounts.updated', structuredClone(account));
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  #now(): number {
    return T0 + this.#seq * 1000;
  }

  #tick(): Promise<void> {
    return Promise.resolve();
  }

  #pause(): Promise<void> {
    if (this.#delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.#delayMs));
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  /**
   * One call the socket holds. A reply that lands after `drop()` broke the
   * promise is thrown away rather than settling it twice, which is what
   * `WsClient` gets for free by clearing `#pending` before it rejects.
   */
  #hold<T>(answer: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = { reject };
      this.#pending.add(entry);
      answer.then(
        (value) => {
          if (this.#pending.delete(entry)) resolve(value);
        },
        (error: unknown) => {
          if (this.#pending.delete(entry)) reject(error);
        }
      );
    });
  }

  #dropPending(message: string): void {
    this.#speechRequests.clear();
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(new RpcFailure({ code: RpcErrorCode.Internal, message }));
    }
  }

  #publishActivity(thread: Thread): void {
    this.#emit('thread.activity', { threadId: thread.id, activity: structuredClone(thread.activity!) });
  }

  #pauseActivity(thread: Thread): void {
    const timer = this.#activityTimers.get(thread.id);
    if (timer) clearTimeout(timer);
    this.#activityTimers.delete(thread.id);
    if (!thread.activity) return;
    for (const kind of ['goal', 'loop'] as const) {
      const item = thread.activity[kind];
      if (item?.status === 'active') item.status = 'paused';
    }
    if (thread.activity.loop) thread.activity.loop.nextRunAt = null;
    this.#publishActivity(thread);
  }

  #scheduleActivity(threadId: string, delay = 0): void {
    const old = this.#activityTimers.get(threadId);
    if (old) clearTimeout(old);
    this.#activityTimers.delete(threadId);
    const thread = this.#threads.get(threadId);
    const activity = thread?.activity;
    if (!thread || thread.archived || !activity || (activity.goal?.status !== 'active' && activity.loop?.status !== 'active')) return;
    this.#activityTimers.set(threadId, setTimeout(() => {
      this.#activityTimers.delete(threadId);
      if (this.#inFlight.has(threadId) || ['running', 'queued', 'waiting'].includes(thread.status)) return;
      const kind = activity.loop?.status === 'active' && (activity.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : activity.goal?.status === 'active' ? 'goal' : null;
      if (!kind) {
        if (activity.loop?.status === 'active') this.#scheduleActivity(threadId, Math.max(0, (activity.loop.nextRunAt ?? Date.now()) - Date.now()));
        return;
      }
      try {
        const turn = this.#startTurn(threadId, kind === 'goal' ? activity.goal!.objective : activity.loop!.prompt, [], undefined, kind);
        this.#activityTurns.set(turn.id, { kind, generation: this.#activityGenerations.get(`${threadId}:${kind}`) ?? 0 });
        activity[kind]!.iterations++;
        if (kind === 'loop') {
          activity.loop!.nextRunAt = null;
          activity.loop!.history = [...(activity.loop!.history ?? []), { iteration: activity.loop!.iterations, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
        }
        this.#publishActivity(thread);
      } catch (error) {
        this.#pauseActivity(thread);
        activity[kind]!.error = error instanceof Error ? error.message : String(error);
        this.#publishActivity(thread);
      }
    }, delay));
  }

  #emit<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
    if (event === 'turn.finished') {
      const turn = payload as Turn;
      const owned = this.#activityTurns.get(turn.id);
      this.#activityTurns.delete(turn.id);
      const thread = this.#threads.get(turn.threadId);
      const current = owned && owned.generation === (this.#activityGenerations.get(`${turn.threadId}:${owned.kind}`) ?? 0);
      if (thread?.activity) {
        if (owned?.kind === 'loop' && current && thread.activity.loop) {
          const loop = thread.activity.loop;
          const run = loop.history?.find(run => run.turnId === turn.id);
          if (run) {
            run.status = turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : 'error';
            run.finishedAt = turn.finishedAt ?? Date.now();
            run.summary = thread.messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n').slice(0, 4000);
          }
          if (turn.status === 'done' && loop.maxIterations && loop.iterations >= loop.maxIterations) { loop.status = 'complete'; loop.nextRunAt = null; }
          else if (loop.status === 'active') loop.nextRunAt = Date.now() + loop.intervalMs;
          this.#publishActivity(thread);
        }
        if (turn.status !== 'done' && (!owned || current)) this.#pauseActivity(thread);
        else {
          // The in-memory agent completes its fake goal after one echo turn.
          if (owned?.kind === 'goal' && current && thread.activity.goal?.status === 'active') { thread.activity.goal.status = 'complete'; this.#publishActivity(thread); }
          this.#scheduleActivity(thread.id, 250);
        }
      }
    }
    // A socket that is down carries nothing. Everything the core emitted
    // during the gap is lost, which is what `reload()` exists to repair.
    if (this.#state !== 'ready') return;
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }

  #emitToThread<E extends RpcEventName>(threadId: ThreadId, event: E, payload: RpcEvents[E]): void {
    if (!this.#subscribed.has(threadId)) return;
    this.#emit(event, payload);
  }

  #thread(threadId: ThreadId): Thread {
    const thread = this.#threads.get(threadId);
    if (!thread) throw this.#notFound('thread', threadId);
    return thread;
  }

  /**
   * The `limit` messages that sit just before `end`, oldest first, with the
   * cursor for what is still behind them. The core reads the same window off
   * rowids; here it is a slice of the array the fake keeps.
   */
  #page(
    messages: Message[],
    end: number,
    limit: number
  ): { messages: Message[]; before: MessageId | null } {
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end);
    return { messages: page, before: start > 0 ? (page[0]?.id ?? null) : null };
  }

  /** The project's cards, the ones already done last, the core's order. */
  #projectTodos(projectId: string): Todo[] {
    const rank = (todo: Todo): number => (todo.status === 'done' ? 1 : 0);
    return structuredClone(
      this.#todos
        .filter((todo) => todo.projectId === projectId)
        .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
    );
  }

  /** A list is shared by the project, so the whole of it travels on every change. */
  #emitTodos(projectId: string): void {
    this.#emit('todos.updated', { projectId, todos: this.#projectTodos(projectId) });
  }

  /** A stable time per path, so two runs of a capture read the same tree. */
  #fileTime(path: string): number {
    const index = [...this.#files.keys(), ...FAKE_MEDIA_PATHS].indexOf(path);
    return T0 - Math.max(0, index) * 3_600_000;
  }

  /** One directory of the fixture tree, directories first, then files by name. */
  #listDir(path: string): FileEntry[] {
    const prefix = path === '' ? '' : `${path.replace(/[\\/]+$/, '')}/`;
    const dirs = new Set<string>();
    const files: FileEntry[] = [];
    for (const full of [...this.#files.keys(), ...FAKE_MEDIA_PATHS]) {
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
        bytes: fakeBytes(full, this.#files.get(full)),
        modifiedAt: this.#fileTime(full)
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

  #isDir(path: string): boolean {
    if (path === '') return true;
    const prefix = `${path}/`;
    return [...this.#files.keys(), ...FAKE_MEDIA_PATHS].some((full) => full.startsWith(prefix));
  }

  /**
   * The core's `resolveInside`, and `existingInside` when `expect` is given,
   * over the fake tree: a path relative to the thread's directory or absolute
   * inside it, never out of it, answered in the relative form with forward
   * slashes the core answers with.
   */
  #inside(cwd: string, path: unknown, what: string, expect?: 'file' | 'dir'): string {
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
    const isFile = this.#files.has(relative) || FAKE_MEDIA[relative] !== undefined;
    const isDir = this.#isDir(relative);
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
  #checkSurface(cwd: string, surface: PanelSurface): PanelSurface {
    const kind = (surface as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== 'string' || !(PANEL_SURFACE_KINDS as readonly string[]).includes(kind)) {
      throw refusal(`panel.open does not know the surface ${String(kind)}`);
    }
    const path = (surface as { path?: unknown }).path;
    if (kind === 'file') {
      if (typeof path !== 'string' || path.length === 0) throw refusal('panel.open file needs a path');
      const found = this.#inside(cwd, path, 'panel.open file path', 'file');
      const line = (surface as { line?: unknown }).line;
      if (line === undefined || line === null) return { kind, path: found };
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        throw refusal(`panel.open line must be a line number, got ${String(line)}`);
      }
      return { kind, path: found, line };
    }
    if (kind === 'files') {
      if (path === undefined || path === null) return { kind };
      return { kind, path: this.#inside(cwd, path, 'panel.open files path', 'dir') };
    }
    if (kind === 'diff') {
      // A diff names a file that may be gone from the working tree.
      if (path === undefined || path === null) return { kind };
      return { kind, path: this.#inside(cwd, path, 'panel.open diff path') };
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

  #notFound(what: string, id: string): RpcFailure {
    return new RpcFailure({
      code: RpcErrorCode.NotFound,
      message: `no such ${what}: ${id}`,
      data: { id }
    });
  }

  #touch(thread: Thread): ThreadSummary {
    thread.updatedAt = this.#now();
    const summary = structuredClone(toSummary(thread));
    this.#emit('thread.updated', summary);
    return structuredClone(summary);
  }

  #pushScheduler(turn: Turn, phase: 'running' | 'finished'): void {
    if (phase === 'running') {
      this.#scheduler.running = [
        ...this.#scheduler.running,
        { turnId: turn.id, threadId: turn.threadId, startedAt: turn.startedAt ?? this.#now() }
      ];
    } else {
      this.#scheduler.running = this.#scheduler.running.filter((r) => r.turnId !== turn.id);
    }
    this.#emit('scheduler.updated', structuredClone(this.#scheduler));
  }

  /**
   * ACP, Codex and pi probe their own catalogs. Demo models are explicitly
   * named as such; only OpenCode uses the large catalog fixture.
   */
  #checkSpeed(providerId: string, accountId: string, model: string | null, speed: string | null): void {
    if (speed === null) return;
    const models = this.#modelCatalogs.get(providerId + '::' + accountId) ?? this.#providers.find(p => p.id === providerId)?.models ?? [];
    if (!models.find(m => m.id === model)?.speeds?.some(option => option.id === speed)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model does not offer this speed' });
  }

  async #probe(providerId: string, accountId: string): Promise<RpcResult<'providers.probe'>> {
    const provider = this.#providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown provider ${providerId}` });
    }
    const account = this.#accounts.find((a) => a.id === accountId);
    if (!account) throw this.#notFound('account', accountId);
    if (account.providerId !== providerId) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the account belongs to another provider' });
    }
    const dynamic = ['acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol);
    if (dynamic && !provider.available) {
      throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${provider.name} is not available on this machine` });
    }
    let models = structuredClone(provider.models);
    if (dynamic) {
      models = provider.id === UPDATABLE_ID ? structuredClone(PROBED_MODELS) : [
        ...models,
        { id: `${provider.id}-demo`, name: `${provider.name} demo model`, default: false, ...(provider.protocol === 'codex-appserver' ? { effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: 'high' }, speeds: [{ id: 'fast', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }] } : provider.protocol === 'muse' ? { effort: MUSE_EFFORT } : {}) }
      ];
      await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
    }
    this.#modelCatalogs.set(providerId + '::' + accountId, models);
    const probedAt = this.#now();
    this.#emit('providers.probed', { providerId, accountId, models: structuredClone(models), probedAt });
    return { models, probedAt };
  }

  // -------------------------------------------------------------------------
  // Agent updates
  // -------------------------------------------------------------------------

  /**
   * Two agents behind their newest release, one by each route, so the notices
   * have a subject. The fake page shows them on `?updates=1` only: a card
   * pinned to a corner would sit in every other capture.
   */
  #harnessUpdates: HarnessUpdate[] = ([
    { providerId: 'claude', name: 'Claude Code', route: 'self', current: '2.1.267', latest: '2.1.278', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'codex', name: 'Codex', route: 'managed', current: '0.154.0', latest: '0.155.1', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'opencode', name: 'OpenCode', route: 'self', current: '1.18.31', latest: '1.18.31', pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    // No way to name its newest release: the row that offers the updater itself.
    { providerId: 'antigravity', name: 'Antigravity', route: 'self', current: '1.2.7', latest: null, pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() }
  ] satisfies HarnessUpdate[]).map((update) => (quietUpdates() ? { ...update, current: update.latest ?? update.current, pending: false } : update));

  #harnessUpdate(providerId: string): HarnessUpdate {
    const update = this.#harnessUpdates.find((entry) => entry.providerId === providerId);
    if (!update) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${providerId} has no update Boite can run on this machine` });
    return update;
  }

  #updateHarness(providerId: string): RpcResult<'providers.update'> {
    const update = this.#harnessUpdate(providerId);
    if (update.state === 'updating') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already updating` });
    if (update.latest !== null && update.current === update.latest) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already on its newest known version` });
    }
    update.state = 'updating';
    update.pending = false;
    this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
    setTimeout(() => {
      update.state = 'idle';
      update.current = update.latest ?? update.current;
      update.checkedAt = Date.now();
      this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
    }, 1200);
    return structuredClone(update);
  }

  // -------------------------------------------------------------------------
  // Managed installs
  // -------------------------------------------------------------------------

  #managed(providerId: string): ProviderSummary {
    const provider = this.#providers.find((p) => p.id === providerId);
    if (!provider || provider.install === null) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `${providerId} has nothing for Boite to install`
      });
    }
    return provider;
  }

  #setInstall(provider: ProviderSummary, state: ProviderInstallState): void {
    provider.install = state;
    this.#emit('providers.installProgress', { ...state, providerId: provider.id });
  }

  /** The release one install would fetch on this provider, and what it weighs. */
  #release(providerId: string): { version: string; archiveBytes: number } {
    return RELEASES[providerId] ?? { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES };
  }

  #startInstall(providerId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const before = provider.install;
    if (
      before !== null &&
      before.state !== 'absent' &&
      before.state !== 'installed' &&
      before.state !== 'failed'
    ) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `an install of ${providerId} is already running`
      });
    }
    if (before?.state === 'installed' && before.available === before.version) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `${providerId} is up to date on ${before.version}`
      });
    }
    // An update that is cancelled goes back to the release already on disk.
    if (before !== null) this.#installBefore.set(providerId, before);

    const release = this.#release(providerId);
    const operationId = `inst_${(this.#seq += 1)}`;
    const state: ProviderInstallState = {
      state: 'downloading',
      version: release.version,
      receivedBytes: 0,
      totalBytes: release.archiveBytes,
      operationId
    };
    this.#setInstall(provider, state);
    void this.#runInstall(provider, release, operationId);
    return state;
  }

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  #requirePlugin(id: string): PluginState {
    const plugin = this.#plugins.find((entry) => entry.id === id);
    if (plugin === undefined) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `unknown plugin ${id}; expected a plugin id from plugins.list` });
    return plugin;
  }

  /** A URL plugin leaves the list; the event carries it back `not-installed`, as the core's does. */
  #dropPlugin(plugin: PluginState): PluginState {
    this.#plugins = this.#plugins.filter((entry) => entry.id !== plugin.id);
    const gone: PluginState = { ...structuredClone(plugin), status: 'not-installed', version: null, progress: 0, error: null, rejected: null };
    this.#emit('plugins.updated', structuredClone(gone));
    return gone;
  }

  async #runPluginInstall(id: string): Promise<void> {
    const run = (this.#pluginRuns.get(id) ?? 0) + 1;
    this.#pluginRuns.set(id, run);
    for (let step = 1; step <= PLUGIN_STEPS; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      const plugin = this.#plugins.find((entry) => entry.id === id);
      if (this.#pluginRuns.get(id) !== run || plugin === undefined) return;
      if (step < PLUGIN_STEPS) plugin.progress = Math.round((step / PLUGIN_STEPS) * 95);
      else Object.assign(plugin, { status: 'installed', version: plugin.availableVersion, progress: 0, error: null, rejected: null });
      this.#emit('plugins.updated', structuredClone(plugin));
    }
  }

  /**
   * What the core's `plugins.inspect` answers, without git: https only, a URL
   * holding `broken` comes back refused, anything else reads as a Pi pool
   * plugin named after the repository.
   */
  async #inspectPlugin(params: RpcParams<'plugins.inspect'>): Promise<PluginPreview> {
    const text = params.url.trim().replace(/\/+$/, '');
    let url: URL | null = null;
    try { url = new URL(text); } catch { url = null; }
    if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'plugin url must be an https URL of a git repository, such as https://github.com/owner/repo' });
    }
    // The core takes a moment to fetch; the page shows it reading.
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs * 10));
    const source = { url: `${url.origin}${url.pathname}`, ref: params.ref?.trim() || 'HEAD', commit: 'e7d1c9a35b2f4e6d8a0c1b3f5d7e9a2c4b6d8f0e' };
    const base: PluginPreview = { previewId: null, source, manifest: null, rejected: null, artifact: null, platform: 'win32-x64', commands: [], replaces: null, expiresAt: this.#now() + 600_000 };
    if (text.includes('broken')) {
      return { ...base, rejected: { file: 'boite-plugin.json', field: 'artifacts.win32-x64.sha256', expected: '64 lowercase hexadecimal characters',
        message: 'boite-plugin.json: artifacts.win32-x64.sha256 must be 64 lowercase hexadecimal characters, found "TODO"' } };
    }
    const slug = (url.pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
    const manifest: PluginManifest = {
      schema: 1, id: slug, name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '), version: '1.5.0',
      description: 'Saves Pi logins and switches the active one.', homepage: source.url, executable: slug,
      artifacts: { 'win32-x64': { url: `${source.url}/releases/download/v1.5.0/${slug}-win32-x64.exe`, sha256: '5a7c9e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a5c7e9b2d4f6a8c' } },
      provides: { accountPools: { providers: ['pi'] } }
    };
    const read: PluginPreview = { ...base, manifest, artifact: manifest.artifacts['win32-x64'] ?? null, commands: poolCommands(slug) };
    const existing = this.#plugins.find((entry) => entry.id === slug);
    if (existing?.origin === 'recommended') {
      const expected = 'an id no recommended plugin uses (kebacc-switcher)';
      return { ...read, rejected: { file: 'boite-plugin.json', field: 'id', expected, message: `boite-plugin.json: id must be ${expected}, found "${slug}"` } };
    }
    if (existing !== undefined && existing.source !== null && existing.source.url !== source.url) {
      const expected = `an id not already used by the plugin from ${existing.source.url}`;
      return { ...read, rejected: { file: 'boite-plugin.json', field: 'id', expected, message: `boite-plugin.json: id must be ${expected}, found "${slug}"` } };
    }
    const preview: PluginPreview = { ...read, previewId: `preview-${++this.#seq}`, replaces: existing?.version ?? null };
    this.#pluginPreviews.set(preview.previewId!, preview);
    return structuredClone(preview);
  }

  #addPlugin(previewId: string): PluginState {
    const preview = this.#pluginPreviews.get(previewId);
    const manifest = preview?.manifest;
    // A preview is read once and only within its ten minutes, as the core's is.
    if (preview !== undefined && preview.expiresAt <= this.#now()) this.#pluginPreviews.delete(previewId);
    if (preview === undefined || manifest == null || preview.expiresAt <= this.#now()) {
      throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'plugin preview is unknown or expired; inspect the URL again' });
    }
    this.#pluginPreviews.delete(previewId);
    const existing = this.#plugins.find((entry) => entry.id === manifest.id);
    const pools = manifest.provides.accountPools?.providers ?? [];
    const plugin: PluginState = {
      id: manifest.id, name: manifest.name, origin: 'url', description: manifest.description, homepage: manifest.homepage,
      version: existing?.version ?? null, availableVersion: manifest.version, status: 'installing', progress: 0, error: null,
      source: preview.source, artifact: preview.artifact, platform: preview.platform, commands: preview.commands, pools, rejected: null
    };
    if (existing !== undefined) Object.assign(existing, plugin);
    else this.#plugins.push(plugin);
    this.#pluginPools[manifest.id] ??= pools.map((provider) => ({ provider, accounts: [] }));
    this.#emit('plugins.updated', structuredClone(plugin));
    void this.#runPluginInstall(manifest.id);
    return structuredClone(plugin);
  }

  /** The download ticks, then the two short states, then the files are there. */
  async #runInstall(
    provider: ProviderSummary,
    release: { version: string; archiveBytes: number },
    operationId: string
  ): Promise<void> {
    const running = (): boolean =>
      provider.install !== null &&
      provider.install.state !== 'absent' &&
      provider.install.state !== 'installed' &&
      provider.install.state !== 'failed' &&
      provider.install.operationId === operationId;

    for (let step = 1; step <= INSTALL_STEPS; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      if (!running()) return;
      this.#setInstall(provider, {
        state: 'downloading',
        version: release.version,
        receivedBytes: Math.round((release.archiveBytes * step) / INSTALL_STEPS),
        totalBytes: release.archiveBytes,
        operationId
      });
    }
    for (const state of ['verifying', 'extracting'] as const) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      if (!running()) return;
      this.#setInstall(provider, { state, version: release.version, operationId });
    }
    await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
    if (!running()) return;
    this.#installBefore.delete(provider.id);
    provider.available = true;
    provider.executable = provider.id === MANAGED_ID ? MANAGED_EXE : provider.executable ?? `${DATA_DIR}/agents/${provider.id}/current/${provider.id}.exe`;
    // Same order as the core: the provider list first, so no client sees
    // `installed` on a provider it still believes is missing.
    const installed: ProviderInstallState = {
      state: 'installed',
      version: release.version,
      installedAt: this.#now(),
      available: release.version
    };
    provider.install = installed;
    this.#emit('providers.updated', { loaded: structuredClone(this.#providers), rejected: [] });
    this.#setInstall(provider, installed);
  }

  #cancelInstall(providerId: string, operationId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const current = provider.install;
    if (
      current === null ||
      current.state === 'absent' ||
      current.state === 'installed' ||
      current.state === 'failed'
    ) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `no install of ${providerId} is running` });
    }
    if (current.operationId !== operationId) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'that operation is not the one running' });
    }
    const release = this.#release(providerId);
    const back = this.#installBefore.get(providerId);
    this.#installBefore.delete(providerId);
    const state: ProviderInstallState = back ?? {
      state: 'absent',
      version: release.version,
      archiveBytes: release.archiveBytes
    };
    this.#setInstall(provider, state);
    return state;
  }

  #uninstall(providerId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const release = this.#release(providerId);
    this.#installBefore.delete(providerId);
    provider.available = false;
    provider.executable = null;
    const state: ProviderInstallState = {
      state: 'absent',
      version: release.version,
      archiveBytes: release.archiveBytes
    };
    this.#setInstall(provider, state);
    this.#emit('providers.updated', { loaded: structuredClone(this.#providers), rejected: [] });
    return state;
  }

  #resources(): ThreadResources[] {
    const out: ThreadResources[] = [];
    for (const thread of this.#threads.values()) {
      const mine = this.#processes.filter((p) => p.threadId === thread.id);
      if (mine.length === 0) continue;
      out.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        live: mine.filter((p) => p.exitedAt === null),
        totals: {
          processes: mine.length,
          cpuMs: mine.reduce((sum, p) => sum + (p.cpuMs ?? 0), 0),
          peakMemoryBytes: mine.reduce((max, p) => Math.max(max, p.peakMemoryBytes ?? 0), 0)
        }
      });
    }
    return out.sort((a, b) => b.live.length - a.live.length);
  }

  // -------------------------------------------------------------------------
  // Seed: two projects, four threads, one of each interesting state.
  // -------------------------------------------------------------------------

  #seed(): void {
    this.#projects = [
      { id: 'p-boite', name: 'boite', path: 'C:\\src\\boite', createdAt: T0 },
      { id: 'p-notes', name: 'notes', path: 'C:\\src\\notes', createdAt: T0 }
    ];

    // What Claude Code left under its projects folder for boite: one session
    // to import, one that is already the trace thread.
    const transcripts = 'C:\\Users\\you\\.claude\\projects\\D--Dev-Collab-boite';
    this.#importable = [
      {
        projectId: 'p-boite',
        providerId: 'claude',
        accountId: 'a-claude-main',
        sessionId: '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        file: `${transcripts}\\4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f.jsonl`,
        title: 'Where the shell looks for a core',
        startedAt: T0 - 26 * 3_600_000,
        updatedAt: T0 - 25 * 3_600_000,
        bytes: 184_320,
        threadId: null
      },
      {
        projectId: 'p-boite',
        providerId: 'claude',
        accountId: 'a-claude-main',
        sessionId: '9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b',
        file: `${transcripts}\\9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b.jsonl`,
        title: 'Finish the trace tab',
        startedAt: T0 - 2 * 3_600_000,
        updatedAt: T0 - 3_600_000,
        bytes: 61_440,
        threadId: 't-trace'
      }
    ];

    this.#providers = [
      {
        id: 'claude',
        name: 'Claude',
        shortName: 'Claude',
        protocol: 'claude-sdk',
        login: { kind: 'command' },
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: 'C:\\Users\\you\\.local\\bin\\claude.exe',
        models: [
          { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', badge: 'new', effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-opus-5', name: 'Claude Opus 5', speeds: [{ id: 'fast', label: 'Fast' }], effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-fable-5', name: 'Claude Fable 5', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', legacy: true }
        ],
        install: null,
        capabilities: {
          approvals: true,
          hooks: true,
          checkpoint: true,
          images: true,
          planMode: true,
          resume: true
        }
      },
      {
        id: 'echo',
        name: 'Echo',
        shortName: 'Echo',
        protocol: 'echo',
        login: false,
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: null,
        models: [
          {
            id: 'echo-1',
            name: 'Echo',
            default: true,
            effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            }
          }
        ],
        install: null,
        // The shipped echo descriptor reads images too: the fake agent names
        // back what it was sent, which is what the attachment capture proves.
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: true,
          planMode: false,
          resume: true
        }
      },
      {
        id: UPDATABLE_ID,
        name: 'OpenCode',
        shortName: 'OpenCode',
        protocol: 'acp',
        login: { kind: 'command' },
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.exe',
        // One model in the descriptor: the agent owns the rest, and a probe reads them.
        models: [{ id: 'default', name: 'OpenCode default', default: true }],
        // Its files are down and one version behind: the Providers page offers Update.
        install: {
          state: 'installed',
          version: UPDATABLE_VERSION,
          installedAt: T0,
          available: UPDATABLE_AVAILABLE
        },
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: false,
          planMode: false,
          resume: true
        }
      },
      {
        id: MANAGED_ID,
        name: 'Antigravity',
        shortName: 'Antigravity',
        protocol: 'acp',
        login: { kind: 'acp' },
        alwaysIsolated: true,
        source: 'shipped',
        // Nothing runs until the release lands: the picker row offers the download.
        available: false,
        executable: null,
        models: [{ id: 'default', name: 'Antigravity default', default: true }],
        install: {
          state: 'absent',
          version: MANAGED_VERSION,
          archiveBytes: MANAGED_ARCHIVE_BYTES
        },
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: false,
          planMode: false,
          resume: true
        }
      }
    ];
    this.#providers.push(...PROBE_PROVIDERS.map((provider): ProviderSummary => ({
      ...provider,
      shortName: provider.name,
      source: 'shipped',
      available: true,
      executable: `${DATA_DIR}\\demo\\${provider.id}.exe`,
      models: [{ id: 'default', name: `${provider.name} default`, default: true }],
      capabilities: {
        approvals: provider.protocol !== 'pi', hooks: false, checkpoint: false,
        images: false, planMode: provider.protocol !== 'pi', resume: true
      },
      install: null,
      alwaysIsolated: false
    })));
    this.#accounts = [
      {
        id: 'a-echo',
        providerId: 'echo',
        label: 'Echo',
        isolationDir: `${DATA_DIR}\\accounts\\a-echo`,
        status: 'ok',
        identity: 'echo',
        createdAt: T0
      },
      {
        id: 'a-antigravity',
        providerId: MANAGED_ID,
        label: 'Antigravity',
        isolationDir: `${DATA_DIR}\\accounts\\a-antigravity`,
        // A managed provider is signed into from the Accounts page, once its
        // files are down: nothing on this machine has logged it in yet.
        status: 'unauthenticated',
        identity: null,
        createdAt: T0
      },
      {
        id: 'a-claude-main',
        providerId: 'claude',
        label: 'Default login',
        isolationDir: null,
        status: 'ok',
        identity: 'you@example.com',
        createdAt: T0
      },
      {
        id: 'a-claude-side',
        providerId: 'claude',
        label: 'Second seat',
        isolationDir: `${DATA_DIR}\\accounts\\a-claude-side`,
        status: 'unauthenticated',
        identity: null,
        createdAt: T0
      },
      {
        id: 'a-opencode',
        providerId: 'opencode',
        label: 'Default',
        isolationDir: null,
        status: 'ok',
        identity: 'you@example.com',
        createdAt: T0
      }
    ];

    this.#accounts.push(...PROBE_PROVIDERS.map((provider): Account => ({
      id: `a-${provider.id}`,
      providerId: provider.id,
      label: 'Default',
      isolationDir: null,
      status: 'ok',
      identity: 'you@example.com',
      createdAt: T0
    })));

    const base = {
      providerId: 'echo',
      accountId: 'a-echo',
      model: 'echo-1',
      effort: null,
      permissionMode: 'default' as const,
      archived: false,
      pinned: false,
      branch: null,
      titleSource: 'prompt' as const,
      // A stored thread is the whole record; `threads.get` is what pages it.
      messagesBefore: null,
      commands: []
    };

    const finished: Thread = {
      ...base,
      id: 't-trace',
      projectId: 'p-boite',
      title: 'Finish the trace tab',
      cwd: 'C:\\src\\boite',
      status: 'idle',
      unread: false,
      sessionId: 'sess-trace',
      load: null,
      context: null,
      createdAt: T0,
      updatedAt: T0 + 60_000,
      turns: [
        {
          id: 'turn-seed-1',
          threadId: 't-trace',
          status: 'done',
          queuedAt: T0,
          startedAt: T0,
          finishedAt: T0 + 41_000,
          usage: {
            inputTokens: 1840,
            outputTokens: 520,
            cacheReadTokens: 12_400,
            cacheWriteTokens: 900,
            costUsdEquivalent: 0.041
          },
          error: null
        }
      ],
      messages: [
        {
          id: 'm-1',
          threadId: 't-trace',
          turnId: 'turn-seed-1',
          role: 'user',
          parts: [{ type: 'text', text: 'What does the trace tab need from the core?' }],
          state: 'complete',
          createdAt: T0
        },
        {
          id: 'm-2',
          threadId: 't-trace',
          turnId: 'turn-seed-1',
          role: 'assistant',
          parts: [
            {
              type: 'thinking',
              text: 'The table wants a row per process, so the question is what procs already reports and what the panel would have to ask for on top. Start with trace.get.'
            },
            {
              type: 'text',
              text: 'It needs trace.get for the table and the TraceCapability note above it. Let me look at what procs already reports.'
            },
            {
              type: 'tool',
              toolId: 'tool-seed-1',
              name: 'Grep',
              input: { pattern: 'process.started', path: 'packages/core/src' },
              output: 'packages/core/src/procs.ts:88\npackages/core/src/trace.ts:20',
              status: 'done'
            },
            {
              type: 'text',
              text: 'Both events carry the pid, the exe, the CPU time and the peak memory, so the table can be filled without a second call.'
            }
          ],
          state: 'complete',
          createdAt: T0 + 20_000
        }
      ]
    };

    const running: Thread = {
      ...base,
      id: 't-scheduler',
      projectId: 'p-boite',
      title: 'Port the scheduler',
      // The one seeded thread in its own worktree: what the header badge is looked at on.
      cwd: 'C:\\src\\.boite-worktrees\\boite\\port-the-scheduler',
      branch: 'boite/port-the-scheduler',
      // Waiting on a question nobody has answered, the same reason as `t-bench`
      // and its permission: a page that loads now draws the card from the list.
      status: 'waiting',
      unread: false,
      sessionId: 'sess-scheduler',
      load: { processes: 2, cpuPercent: 34, memoryBytes: 412 * 1024 * 1024 },
      // Running at a high share: the meter turns full past nine tenths.
      context: { tokens: 183_000, window: 200_000, at: T0 + 100_000 },
      createdAt: T0 + 100_000,
      updatedAt: T0 + 180_000,
      turns: [
        {
          id: 'turn-seed-2',
          threadId: 't-scheduler',
          status: 'running',
          queuedAt: T0 + 170_000,
          startedAt: T0 + 170_500,
          finishedAt: null,
          usage: null,
          error: null
        }
      ],
      messages: [
        {
          id: 'm-3',
          threadId: 't-scheduler',
          turnId: 'turn-seed-2',
          role: 'user',
          parts: [{ type: 'text', text: 'Count turns, never threads. Start with the caps.' }],
          state: 'complete',
          createdAt: T0 + 170_000
        },
        {
          id: 'm-4',
          threadId: 't-scheduler',
          turnId: 'turn-seed-2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Reading the current caps and the queue order' },
            {
              type: 'question',
              questionId: 'qst-seed-1',
              text: QUESTION_TEXT,
              options: QUESTION_OPTIONS,
              allowText: true,
              multiple: false,
              answer: null
            }
          ],
          state: 'streaming',
          createdAt: T0 + 171_000
        }
      ]
    };

    // Its turn is stopped on a permission nobody has answered, which is what a
    // page that loads now shows without ever having seen `permission.requested`.
    const waiting: Thread = {
      ...base,
      id: 't-bench',
      projectId: 'p-boite',
      title: 'Bench against legacy',
      cwd: 'C:\\src\\boite',
      status: 'waiting',
      unread: false,
      sessionId: 'sess-bench',
      load: null,
      context: null,
      createdAt: T0 + 200_000,
      updatedAt: T0 + 200_000,
      turns: [
        {
          id: 'turn-seed-3',
          threadId: 't-bench',
          status: 'running',
          queuedAt: T0 + 200_000,
          startedAt: T0 + 200_500,
          finishedAt: null,
          usage: null,
          error: null
        }
      ],
      messages: [
        {
          id: 'm-5',
          threadId: 't-bench',
          turnId: 'turn-seed-3',
          role: 'user',
          parts: [{ type: 'text', text: 'Fifty echo threads, RSS and throughput.' }],
          state: 'complete',
          createdAt: T0 + 200_000
        },
        {
          id: 'm-8',
          threadId: 't-bench',
          turnId: 'turn-seed-3',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Writing the run script before the fifty threads go out.' },
            { type: 'permission', requestId: 'req-seed-1', toolName: 'Write', decision: null }
          ],
          state: 'streaming',
          createdAt: T0 + 201_000
        }
      ]
    };

    const unread: Thread = {
      ...base,
      id: 't-descriptors',
      projectId: 'p-notes',
      title: 'Review the descriptor loader',
      cwd: 'C:\\src\\notes',
      // The most recent thread, so this is the one a boot opens: it has already
      // run a turn, so the echo agent has already named what it takes.
      commands: structuredClone(ECHO_COMMANDS),
      status: 'idle',
      unread: true,
      sessionId: 'sess-descriptors',
      load: null,
      context: null,
      createdAt: T0 + 300_000,
      updatedAt: T0 + 340_000,
      turns: [
        {
          id: 'turn-seed-4',
          threadId: 't-descriptors',
          status: 'done',
          queuedAt: T0 + 300_000,
          startedAt: T0 + 300_000,
          finishedAt: T0 + 340_000,
          usage: {
            inputTokens: 640,
            outputTokens: 210,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdEquivalent: 0.008
          },
          error: null
        }
      ],
      messages: [
        {
          id: 'm-6',
          threadId: 't-descriptors',
          turnId: 'turn-seed-4',
          role: 'user',
          parts: [{ type: 'text', text: 'Does an unknown field refuse the file?' }],
          state: 'complete',
          createdAt: T0 + 300_000
        },
        {
          id: 'm-7',
          threadId: 't-descriptors',
          turnId: 'turn-seed-4',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'It does, with the file, the field and what was expected. One case is still silent: a roots entry that resolves outside the descriptor directory.'
            },
            // The agent compacted on its way out: the divider under the answer.
            { type: 'compaction', trigger: 'auto', preTokens: 184_000, postTokens: 31_000 },
            { type: 'text', text: 'The loader test now names that case too.' }
          ],
          state: 'complete',
          createdAt: T0 + 320_000
        }
      ]
    };
    // The meters: the trace thread at a comfortable share, the descriptor one just compacted.
    finished.context = { tokens: 84_000, window: 200_000, at: T0 + 60_000 };
    finished.branch = 'boite/trace';
    finished.pullRequest = { number: 84, url: 'https://github.com/example/project/pull/84', state: 'OPEN' };
    unread.context = { tokens: 31_000, breakdown: {input: 18000, cache: 10000, output: 3000}, window: 200_000, at: T0 + 340_000 };

    for (const thread of [finished, running, waiting, unread]) this.#threads.set(thread.id, thread);

    // The project's cards, the list the tasks surface shows under the agent's
    // own: one waiting on the user, one open, one already confirmed. The ids
    // carry a prefix so a card added later never lands on a seeded one.
    this.#todos = [
      { id: 'seed-todo-1', projectId: 'p-boite', text: 'Ship the changes surface', status: 'claimed', threadId: finished.id, createdAt: T0 - 7_200_000, updatedAt: T0 - 600_000 },
      { id: 'seed-todo-2', projectId: 'p-boite', text: 'Give the file tree its rows', status: 'open', threadId: null, createdAt: T0 - 5_400_000, updatedAt: T0 - 5_400_000 },
      { id: 'seed-todo-3', projectId: 'p-boite', text: 'Move the trace behind the panel toggle', status: 'done', threadId: finished.id, createdAt: T0 - 86_400_000, updatedAt: T0 - 3_600_000 },
      { id: 'seed-todo-4', projectId: 'p-notes', text: 'Sort last week into the journal', status: 'open', threadId: null, createdAt: T0 - 86_400_000, updatedAt: T0 - 86_400_000 }
    ];

    if (this.#long) {
      const long = this.#longThread();
      this.#threads.set(long.id, long);
    }

    const seededRequest: PermissionRequest = {
      id: 'req-seed-1',
      threadId: waiting.id,
      turnId: 'turn-seed-3',
      toolName: 'Write',
      input: { path: `${waiting.cwd}\\bench\\run.ts`, contents: 'fifty echo threads, one core' },
      description: 'Write the bench runner inside the project',
      createdAt: T0 + 201_500
    };
    const seededMessage = waiting.messages[1];
    this.#pendingPermissions.set(seededRequest.id, {
      request: seededRequest,
      resolve: (decision) => {
        if (seededMessage) {
          this.#settlePermission(waiting, seededMessage, 1, seededRequest, decision);
          seededMessage.state = 'complete';
          this.#emitToThread(waiting.id, 'message.completed', {
            threadId: waiting.id,
            messageId: seededMessage.id,
            state: 'complete'
          });
        }
        const turn = waiting.turns[0];
        if (turn) {
          turn.status = 'done';
          turn.finishedAt = this.#now();
          this.#emit('turn.finished', structuredClone(turn));
        }
        waiting.status = 'idle';
        this.#touch(waiting);
      }
    });

    const seededQuestion: QuestionRequest = {
      id: 'qst-seed-1',
      threadId: running.id,
      turnId: 'turn-seed-2',
      text: QUESTION_TEXT,
      options: QUESTION_OPTIONS,
      allowText: true,
      multiple: false,
      createdAt: T0 + 171_500
    };
    const questionMessage = running.messages[1];
    this.#pendingQuestions.set(seededQuestion.id, {
      request: seededQuestion,
      resolve: (answer) => {
        if (questionMessage) {
          this.#settleQuestion(running, questionMessage, 1, seededQuestion, answer);
          questionMessage.state = 'complete';
          this.#emitToThread(running.id, 'message.completed', {
            threadId: running.id,
            messageId: questionMessage.id,
            state: 'complete'
          });
        }
        const turn = running.turns[0];
        if (turn) {
          turn.status = 'done';
          turn.finishedAt = this.#now();
          this.#emit('turn.finished', structuredClone(turn));
        }
        running.status = 'idle';
        this.#touch(running);
      }
    });

    this.#processes = [
      {
        pid: 21_140,
        parentPid: 4242,
        threadId: 't-trace',
        exe: 'C:\\tools\\claude\\claude.exe',
        commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
        startedAt: T0 + 1000,
        exitedAt: T0 + 39_000,
        exitCode: 0,
        cpuMs: 4210,
        peakMemoryBytes: 210 * 1024 * 1024,
        ioBytes: 1_240_000
      },
      {
        pid: 21_402,
        parentPid: 21_140,
        threadId: 't-trace',
        exe: 'C:\\tools\\ripgrep\\rg.exe',
        commandLine: 'C:\\tools\\ripgrep\\rg.exe --json process.started packages/core/src',
        startedAt: T0 + 12_000,
        exitedAt: T0 + 12_400,
        exitCode: 0,
        cpuMs: 90,
        peakMemoryBytes: 18 * 1024 * 1024,
        ioBytes: 82_000
      },
      {
        // Gone before the job could read its counters: nothing measured.
        pid: 21_460,
        parentPid: 21_140,
        threadId: 't-trace',
        exe: 'C:\\Program Files\\Git\\cmd\\git.exe',
        commandLine: 'C:\\Program Files\\Git\\cmd\\git.exe status --porcelain',
        startedAt: T0 + 14_000,
        exitedAt: T0 + 14_120,
        exitCode: 0,
        cpuMs: null,
        peakMemoryBytes: null,
        ioBytes: null
      },
      {
        pid: 22_800,
        parentPid: 4242,
        threadId: 't-scheduler',
        exe: 'C:\\tools\\claude\\claude.exe',
        commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
        startedAt: T0 + 170_500,
        exitedAt: null,
        exitCode: null,
        cpuMs: 2100,
        peakMemoryBytes: 380 * 1024 * 1024,
        ioBytes: 640_000
      },
      {
        pid: 22_912,
        parentPid: 22_800,
        threadId: 't-scheduler',
        exe: 'C:\\tools\\bun\\bun.exe',
        commandLine: 'C:\\tools\\bun\\bun.exe test packages/core/src/scheduler.test.ts',
        startedAt: T0 + 176_000,
        exitedAt: null,
        exitCode: null,
        cpuMs: 810,
        peakMemoryBytes: 96 * 1024 * 1024,
        ioBytes: 120_000
      }
    ];

    this.#usage.set('t-trace', {
      inputTokens: 1840,
      outputTokens: 520,
      cacheReadTokens: 12_400,
      cacheWriteTokens: 900,
      costUsdEquivalent: 0.041
    });
    this.#usage.set('t-descriptors', {
      inputTokens: 640,
      outputTokens: 210,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEquivalent: 0.008
    });

    this.#scheduler = {
      maxConcurrentTurns: this.#settings.maxConcurrentTurns,
      perAccountConcurrency: this.#settings.perAccountConcurrency,
      running: [{ turnId: 'turn-seed-2', threadId: 't-scheduler', startedAt: T0 + 170_500 }],
      queued: [
        { turnId: 'turn-seed-3', threadId: 't-bench', position: 1, queuedAt: T0 + 200_000 }
      ]
    };

    this.#seq = 100;
  }

  /**
   * Four hundred messages of uneven height in one thread: what the windowed
   * list is looked at on, behind `?fake=1&long=1`.
   */
  #longThread(): Thread {
    const messages: Message[] = [];
    for (let index = 0; index < 400; index += 1) {
      const at = T0 + 400_000 + index * 1000;
      messages.push(
        index % 2 === 0
          ? {
              id: `m-long-${index}`,
              threadId: 't-long',
              turnId: 'turn-long',
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text: `${LONG_ASKS[(index / 2) % LONG_ASKS.length] ?? ''} (${index})`
                }
              ],
              state: 'complete',
              createdAt: at
            }
          : {
              id: `m-long-${index}`,
              threadId: 't-long',
              turnId: 'turn-long',
              role: 'assistant',
              parts: [
                {
                  type: 'text',
                  text: LONG_ANSWERS[((index - 1) / 2) % LONG_ANSWERS.length] ?? ''
                }
              ],
              state: 'complete',
              createdAt: at
            }
      );
    }
    return {
      id: 't-long',
      projectId: 'p-boite',
      providerId: 'echo',
      accountId: 'a-echo',
      model: 'echo-1',
      effort: null,
      permissionMode: 'default',
      archived: false,
      pinned: false,
      title: 'Four hundred messages',
      titleSource: 'prompt',
      cwd: 'C:\\src\\boite',
      branch: null,
      status: 'idle',
      unread: false,
      sessionId: 'sess-long',
      load: null,
      context: null,
      createdAt: T0 + 400_000,
      updatedAt: T0 + 800_000,
      messagesBefore: null,
      commands: [],
      turns: [
        {
          id: 'turn-long',
          threadId: 't-long',
          status: 'done',
          queuedAt: T0 + 400_000,
          startedAt: T0 + 400_000,
          finishedAt: T0 + 800_000,
          usage: {
            inputTokens: 41_200,
            outputTokens: 18_400,
            cacheReadTokens: 210_000,
            cacheWriteTokens: 12_000,
            costUsdEquivalent: 1.24
          },
          error: null
        }
      ],
      messages
    };
  }
}
