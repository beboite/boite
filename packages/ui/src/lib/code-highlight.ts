import { highlightText, knownLanguage, type Language } from './code-grammar';

/** File names select a grammar; unknown files remain plain text. No guessing on every keystroke. */
const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  svelte: 'xml', vue: 'xml', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  py: 'python', rs: 'rust', go: 'go', cs: 'csharp', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', sql: 'sql', rb: 'ruby', php: 'php'
};
const ALIASES: Record<string, string> = { html: 'xml', svelte: 'xml', vue: 'xml', ts: 'typescript', js: 'javascript', shell: 'bash', sh: 'bash', toml: 'ini', 'c#': 'csharp' };

export function codeLanguage(path: string, hint?: string | null): Language | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const inferred = name === 'dockerfile' || name.startsWith('dockerfile.') ? 'dockerfile'
    : name === 'makefile' || name === 'gnumakefile' ? 'makefile'
    : EXTENSIONS[name.split('.').at(-1) ?? ''];
  const requested = hint?.toLowerCase();
  const language = inferred ?? (requested ? ALIASES[requested] ?? requested : null);
  return language && knownLanguage(language) ? language : null;
}

/** Large files stay editable without sending megabytes through a grammar on each edit. */
export const HIGHLIGHT_LIMIT = 200_000;

/**
 * Highlighted lines by grammar and text. A diff the window mounts again, the
 * same diff in the turn's files card or a file opened twice is not run through
 * the grammar a second time, and two views of one text wait on one run.
 * Bounded by the characters it holds, texts and results, oldest first.
 */
const highlighted = new Map<string, { lines: Promise<string[] | null>; chars: number }>();
const HIGHLIGHTED_CHARS = 2_000_000;
let highlightedChars = 0;

function trimHighlighted(): void {
  for (const [oldest, entry] of highlighted) {
    if (highlightedChars <= HIGHLIGHTED_CHARS || highlighted.size === 1) break;
    highlighted.delete(oldest);
    highlightedChars -= entry.chars;
  }
}

export function highlightCode(text: string, language: Language | null): Promise<string[] | null> {
  if (!language || text.length > HIGHLIGHT_LIMIT) return Promise.resolve(null);
  const key = `${language}\0${text}`;
  const known = highlighted.get(key);
  if (known) {
    highlighted.delete(key);
    highlighted.set(key, known);
    return known.lines;
  }
  const entry = { lines: highlightAway(text, language), chars: key.length };
  highlighted.set(key, entry);
  highlightedChars += entry.chars;
  trimHighlighted();
  entry.lines.then(lines => {
    if (highlighted.get(key) !== entry || !lines) return;
    const added = lines.reduce((sum, line) => sum + line.length, 0);
    entry.chars += added;
    highlightedChars += added;
    trimHighlighted();
  }, () => {
    // A grammar that failed to load is tried again by the next view.
    if (highlighted.get(key) !== entry) return;
    highlighted.delete(key);
    highlightedChars -= entry.chars;
  });
  return entry.lines;
}

/**
 * Texts from this length go through the grammar in a worker. A 190,000
 * character file spent 108 to 242 ms in the grammar on the main thread
 * (2026-10-17, `bench/ui-frames.ts`, large file highlight); a diff of a few
 * hundred lines stays here, where posting it would cost more than running it.
 */
export const WORKER_FROM = 20_000;

interface Job {
  resolve(lines: string[]): void;
  reject(error: Error): void;
  /** Runs the text here instead, when the worker could not start. */
  here(): void;
}

/** The worker, made on the first long text; null once it could not start, and every text then runs here. */
let worker: Worker | null | undefined;
let lastJob = 0;
const jobs = new Map<number, Job>();

function highlightWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return worker = null;
  try {
    worker = new Worker(new URL('./code-highlight.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return worker = null;
  }
  worker.onmessage = ({ data }: MessageEvent<{ id: number; lines?: string[]; error?: string }>) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.lines) job.resolve(data.lines);
    else job.reject(new Error(data.error ?? 'highlight failed'));
  };
  // A worker that failed to load answers nothing: what it was given runs here.
  worker.onerror = (event) => {
    event.preventDefault();
    worker?.terminate();
    worker = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const job of waiting) job.here();
  };
  return worker;
}

function highlightAway(text: string, language: Language): Promise<string[]> {
  const away = text.length >= WORKER_FROM ? highlightWorker() : null;
  if (!away) return highlightText(text, language);
  return new Promise((resolve, reject) => {
    const id = ++lastJob;
    jobs.set(id, { resolve, reject, here: () => { highlightText(text, language).then(resolve, reject); } });
    away.postMessage({ id, text, language });
  });
}
