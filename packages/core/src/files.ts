/*
 * The files of a project, for the composer's `@` mentions. One walk per
 * project every few seconds at most, held in memory, then a ranking of the
 * query against it. No git process: `.git`, `.boite` and `node_modules` are always
 * skipped, and the root `.gitignore` adds the directories and files it names by
 * plain name (`dist`, `target/`, `/coverage`); globs and negations are not
 * read, so an ignored tree named through one still shows up. The walk stops at
 * `FILE_CAP` entries and says so, rather than reading a monorepo's every file.
 */

import { existsSync } from 'node:fs';
import { opendir, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { refused } from './errors.ts';
import { currentOs } from './paths.ts';

/** How many files a walk keeps before giving up on the rest. */
export const FILE_CAP = 20_000;
/** How long a walk stays good for, so a mention typed letter by letter walks once. */
export const WALK_TTL_MS = 5_000;
/** The default and the largest page a query hands back. */
export const FILES_LIMIT = 50;
export const FILES_LIMIT_MAX = 200;

const ALWAYS_SKIPPED = new Set(['.git', '.boite', 'node_modules']);

export interface FileWalk {
  files: string[];
  capped: boolean;
}

export interface FilesPage {
  files: string[];
  total: number;
  capped: boolean;
}

/**
 * The names a root `.gitignore` skips outright: a line that is one plain
 * name, with or without a leading or trailing slash. Anything with a glob, a
 * nested path or a `!` is left to git, which is not consulted here.
 */
export function ignoredNames(gitignore: string): Set<string> {
  const names = new Set<string>();
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const name = line.replace(/^\//, '').replace(/\/$/, '');
    if (name.length === 0 || /[*?[\]\\/]/.test(name)) continue;
    names.add(name);
  }
  return names;
}

/** Every file under `root`, relative with `/`, in no promised order. */
export async function walkFiles(root: string, cap = FILE_CAP): Promise<FileWalk> {
  let skipped = ALWAYS_SKIPPED;
  try {
    const extra = ignoredNames(await readFile(join(root, '.gitignore'), 'utf8'));
    if (extra.size > 0) skipped = new Set([...ALWAYS_SKIPPED, ...extra]);
  } catch {
    // No .gitignore, or one that cannot be read: the fixed names still apply.
  }

  const files: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const relative = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(relative.length === 0 ? root : join(root, relative), { withFileTypes: true });
    } catch {
      // A directory gone or refused between the listing and the read: nothing to name there.
      continue;
    }
    for (const entry of entries) {
      if (skipped.has(entry.name)) continue;
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        files.push(path);
        if (files.length >= cap) return { files, capped: true };
      }
    }
  }
  return { files, capped: false };
}

/**
 * The files under `root` a chat link's `path` names: itself when it is there,
 * else those whose relative path ends with it, so `core.md` finds
 * `.local/core.md`. Ignored trees count here, since a link may well name a
 * generated file. The walk goes breadth first and stops at the first depth
 * with a match, so a copy deeper down does not make a name ambiguous. It
 * reads at most `cap` entries, and a single match found before that cap is
 * dropped, since its twin may lie past it.
 */
export async function locateFile(root: string, path: string, cap = FILE_CAP): Promise<string[]> {
  if (typeof path !== 'string' || path.length === 0 || /[\u0000-\u001f]/.test(path)) {
    throw refused(`files.locate path: expected a file path, got ${JSON.stringify(path)}`, { path });
  }
  if (existsSync(resolve(root, path))) return [path];
  const parts = path.replaceAll('\\', '/').split('/').filter((part) => part.length > 0 && part !== '.');
  if (isAbsolute(path) || parts.length === 0 || parts.includes('..')) return [];
  // Windows and macOS names do not differ by case alone.
  const fold = currentOs() === 'linux' ? (text: string) => text : (text: string) => text.toLowerCase();
  const tail = fold(parts.join('/'));
  let level = [''];
  let read = 0;
  while (level.length > 0) {
    const found: string[] = [];
    const next: string[] = [];
    for (const relative of level) {
      let entries;
      try {
        // Read a batch at a time, so a huge generated folder costs no more than `cap` entries.
        entries = await opendir(relative.length === 0 ? root : join(root, relative));
      } catch {
        continue;
      }
      try {
        for await (const entry of entries) {
          // A match found before the cap may have a twin past it: one is not an answer then, two still are.
          if (++read > cap) return found.length > 1 ? found.sort() : [];
          if (ALWAYS_SKIPPED.has(entry.name)) continue;
          const file = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) next.push(file);
          else if (entry.isFile() && (fold(file) === tail || fold(file).endsWith(`/${tail}`))) found.push(file);
        }
      } catch {
        // A directory gone or refused while it was read: what it held is not named here.
      }
    }
    if (found.length > 0) return found.sort();
    level = next;
  }
  return [];
}

/**
 * How well a path answers a query, 0 for not at all. The file's own name
 * counts most, a prefix over a substring, then the whole path as a substring,
 * then the query's letters in order along the path. A multi-word query needs
 * every word and scores on its weakest one, like the palette.
 */
export function scorePath(query: string, path: string): number {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  let weakest = Number.POSITIVE_INFINITY;
  for (const word of words) {
    let score = 0;
    if (name === word) score = 100;
    else if (name.startsWith(word)) score = 80;
    else if (name.includes(word)) score = 60;
    else if (lower.includes(word)) score = 40;
    else if (inOrder(word, lower)) score = 20;
    if (score === 0) return 0;
    weakest = Math.min(weakest, score);
  }
  return weakest;
}

function inOrder(word: string, text: string): boolean {
  let at = 0;
  for (const char of word) {
    at = text.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** The best `limit` matches of a walk, ties broken by the shorter path, then alphabetically. */
export function rankFiles(query: string, walk: FileWalk, limit: number): FilesPage {
  const scored: { path: string; score: number }[] = [];
  for (const path of walk.files) {
    const score = scorePath(query, path);
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return { files: scored.slice(0, limit).map((entry) => entry.path), total: scored.length, capped: walk.capped };
}

/** One walk per root, reused for `WALK_TTL_MS`, so a mention typed letter by letter walks once. */
export class FileIndex {
  private readonly walks = new Map<string, { at: number; walk: Promise<FileWalk> }>();

  constructor(private readonly now: () => number = Date.now) {}

  async list(root: string, query: string, limit?: number): Promise<FilesPage> {
    const size = Math.max(1, Math.min(FILES_LIMIT_MAX, Math.floor(limit ?? FILES_LIMIT)));
    return rankFiles(query, await this.walkOf(root), size);
  }

  /** Forget a root, for a project removed or a walk a test wants fresh. */
  forget(root: string): void {
    this.walks.delete(root);
  }

  private walkOf(root: string): Promise<FileWalk> {
    const at = this.now();
    const held = this.walks.get(root);
    if (held !== undefined && at - held.at < WALK_TTL_MS) return held.walk;
    const walk = walkFiles(root).catch((error: unknown) => {
      this.walks.delete(root);
      throw error;
    });
    this.walks.set(root, { at, walk });
    return walk;
  }
}
