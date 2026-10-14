/**
 * A drop from the system onto the shell window. The native drop hands paths,
 * not `File`s, and on Windows it is the only drop the page hears: the
 * composer's own `ondrop` never fires in the shell. So the shell says what each
 * path is (`dropped_entries`): a folder becomes a project, a file goes to the
 * message being written (`dropped_file`), and a drop of files alone never
 * changes machine or project.
 */
import { ATTACHMENT_MAX_BYTES } from '@boite/contracts';
import { bytes } from './format';
import { fill, strings } from './strings';

export type DroppedEntry = { path: string; name: string; directory: boolean; size: number };

/** What a drop asks for while it is dragged over the window. */
export type DropKind = 'project' | 'attach';

type Taker = (files: File[]) => void | Promise<void>;
let taker: Taker | null = null;

/** The composer on screen takes dropped files; the returned function lets go. */
export function receiveDroppedFiles(take: Taker): () => void {
  taker = take;
  return () => {
    if (taker === take) taker = null;
  };
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf', json: 'application/json', zip: 'application/zip',
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', ndjson: 'application/x-ndjson',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

/** The type a browser would have given the file, from its extension; empty when unknown. */
export function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : (MIME[name.slice(dot + 1).toLowerCase()] ?? '');
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export function droppedEntries(paths: string[]): Promise<DroppedEntry[]> {
  return invoke<DroppedEntry[]>('dropped_entries', { paths });
}

/** A folder in the drag asks for a project; files alone ask for an attachment. */
export function dropKind(entries: DroppedEntry[]): DropKind | null {
  if (entries.length === 0) return null;
  return entries.some((entry) => entry.directory) ? 'project' : 'attach';
}

async function readDropped(entry: DroppedEntry): Promise<File> {
  const body = await invoke<ArrayBuffer>('dropped_file', { path: entry.path });
  return new File([body], entry.name, { type: mimeFor(entry.name) });
}

export type DropActions = {
  /** Adds the folders as projects on this computer's core and opens the first. */
  addProjects(paths: string[]): Promise<void>;
  /** Shows a refusal in the active machine's toast. */
  fail(message: string): void;
};

/** Files to the composer on screen, folders to projects. */
export async function routeDrop(paths: string[], actions: DropActions): Promise<void> {
  let entries: DroppedEntry[];
  try {
    entries = await droppedEntries(paths);
  } catch (error) {
    actions.fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const folders = entries.filter((entry) => entry.directory);
  const files = entries.filter((entry) => !entry.directory);
  if (files.length > 0) {
    const take = taker;
    if (take === null) actions.fail(strings.drop.noComposer);
    else {
      const read: File[] = [];
      for (const file of files) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          actions.fail(fill(strings.composer.attachTooLarge, { name: file.name, max: bytes(ATTACHMENT_MAX_BYTES) }));
          continue;
        }
        try {
          read.push(await readDropped(file));
        } catch {
          actions.fail(fill(strings.composer.attachReadError, { name: file.name }));
        }
      }
      if (read.length > 0) await take(read);
    }
  }
  if (folders.length > 0) await actions.addProjects(folders.map((folder) => folder.path));
}

type DropTarget = { readonly active: { dropping: DropKind | false; error: string | null }; addLocalProjects(paths: string[]): Promise<void> };

/** Listens to the shell's native drag and drop; the returned function stops. */
export async function listenNativeDrop(workspace: DropTarget): Promise<() => void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  let drag = 0;
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === 'over') return;
    // A later enter, leave or drop makes a classification still on its way stale.
    const current = ++drag;
    if (payload.type === 'enter') {
      void droppedEntries(payload.paths).then((entries) => {
        if (current === drag) workspace.active.dropping = dropKind(entries) ?? false;
      }, () => undefined);
    } else if (payload.type === 'leave') workspace.active.dropping = false;
    else {
      workspace.active.dropping = false;
      void routeDrop(payload.paths, {
        addProjects: (paths) => workspace.addLocalProjects(paths),
        fail: (message) => { workspace.active.error = message; }
      });
    }
  });
}
