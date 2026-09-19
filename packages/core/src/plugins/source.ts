/*
 * Reading a plugin's manifest out of a git repository, and nothing else. The
 * core makes an empty bare repository under its data directory, fetches the one
 * commit the ref names with `--depth 1`, reads `boite-plugin.json` out of that
 * commit as a blob and deletes the directory. No working tree is checked out,
 * no hook of the plugin's runs, and every git goes through `core.procs`, so the
 * trace shows it under `plugin:fetch:<n>` like any other process.
 *
 * Only https reaches git. The other transports are where a URL turns into a
 * command (`ext::`), a local file read (`file://`) or a login prompt (ssh), so
 * git is told `protocol.allow=never` with https the one exception, and the
 * credential helpers are emptied: a private or missing repository fails at
 * once instead of opening a sign-in window on the user's screen.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { PLUGIN_MANIFEST_FILE } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { MANIFEST_MAX_BYTES, httpsProblem } from './manifest.ts';

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const FETCH_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_BYTES = 1024 * 1024;

let sequence = 0;

/**
 * The repository URL the core will fetch: https, a host, no credentials, no
 * query or fragment, trailing slashes cut. `allowLocal` is the tests' door to
 * a fixture repository on disk and is never set by a client.
 */
export function normalizeSourceUrl(input: unknown, allowLocal = false): string {
  const expected = 'an https URL of a git repository, such as https://github.com/owner/repo';
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 2048) {
    throw invalidParams(`plugin url must be ${expected}`, { field: 'url', expected });
  }
  const text = input.trim();
  if (allowLocal && isAbsolute(text) && existsSync(text)) return resolve(text);
  const problem = httpsProblem(text);
  if (problem !== null) throw invalidParams(`plugin url must be ${expected}, found ${problem}`, { field: 'url', expected, url: text });
  const url = new URL(text);
  if (url.search !== '' || url.hash !== '') {
    throw invalidParams(`plugin url must be ${expected}, with no query or fragment`, { field: 'url', expected, url: text });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** A branch, a tag or a commit: no leading dash, no `..`, nothing git would read as an option. */
export function checkRef(input: unknown): string {
  const expected = 'a branch, tag or commit: letters, digits, ., _, / and -, not starting with - or holding ..';
  if (input === undefined || input === '') return 'HEAD';
  if (typeof input !== 'string' || !REF_PATTERN.test(input) || input.includes('..') || input.endsWith('/') || input.endsWith('.lock')) {
    throw invalidParams(`plugin ref must be ${expected}`, { field: 'ref', expected, ref: String(input) });
  }
  return input;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    // Past the cap the rest is read and dropped, so git never blocks on a full pipe.
    if (size <= OUTPUT_MAX_BYTES) chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('hint:')) ?? '';
}

/**
 * Fetches `ref` of `url` and returns the commit it resolved to and the text of
 * the manifest at that commit, null when the commit has no such file.
 */
export async function fetchManifest(
  core: Core,
  url: string,
  ref: string,
  options: { allowLocal?: boolean; signal?: AbortSignal } = {},
): Promise<{ commit: string; text: string | null }> {
  const allowLocal = options.allowLocal === true;
  const root = resolve(core.dataDir, 'plugins');
  mkdirSync(root, { recursive: true });
  const dir = join(root, `.fetch-${newId('')}`);
  const threadId = `plugin:fetch:${++sequence}`;
  const config = [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(allowLocal ? ['-c', 'protocol.file.allow=always'] : []),
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
  ];
  const git = async (args: string[]): Promise<GitRun> => {
    if (options.signal?.aborted) throw refused('Boite is shutting down.');
    let spawned;
    try {
      spawned = core.procs.spawn(threadId, 'git', [...config, ...args], {
        cwd: root,
        env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      });
    } catch (error) {
      throw refused(`git did not start (${messageOf(error)}): adding a plugin from a URL needs git on PATH`, { args });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(refused(`git ${args.find((arg) => !arg.startsWith('-') && arg !== dir) ?? ''} did not finish within ${FETCH_TIMEOUT_MS / 1000} seconds`, { url }));
      }, FETCH_TIMEOUT_MS);
    });
    try {
      const [stdout, stderr, code] = await Promise.race([
        Promise.all([drain(spawned.proc.stdout), drain(spawned.proc.stderr), spawned.exited]),
        expired,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      // Only a git that outlived its deadline is killed; the next one runs under the same id.
      if (late) core.procs.killTree(threadId);
      await spawned.exited;
    }
  };

  // The core closing stops a fetch where it is instead of waiting out its timeout.
  const stop = () => core.procs.killTree(threadId);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    const init = await git(['init', '--bare', '--quiet', dir]);
    if (init.code !== 0) throw refused(`git init failed in ${root}: ${firstLine(init.stderr) || `exit ${init.code}`}`, { dir });
    const fetched = await git(['--git-dir', dir, 'fetch', '--depth', '1', '--no-tags', '--quiet', url, ref]);
    if (fetched.code !== 0) {
      throw refused(`git could not fetch ${ref} from ${url}: ${firstLine(fetched.stderr) || `exit ${fetched.code}`}`, { url, ref });
    }
    const parsed = await git(['--git-dir', dir, 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']);
    const commit = parsed.stdout.trim();
    if (parsed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw refused(`${ref} of ${url} does not name a commit`, { url, ref });
    const blob = `${commit}:${PLUGIN_MANIFEST_FILE}`;
    const sized = await git(['--git-dir', dir, 'cat-file', '-s', blob]);
    if (sized.code !== 0) return { commit, text: null };
    const size = Number(sized.stdout.trim());
    if (!Number.isFinite(size) || size > MANIFEST_MAX_BYTES) {
      throw refused(`${PLUGIN_MANIFEST_FILE} at ${commit.slice(0, 7)} is ${size} bytes, past the ${MANIFEST_MAX_BYTES} a manifest may take`, { url, commit });
    }
    const read = await git(['--git-dir', dir, 'cat-file', 'blob', blob]);
    if (read.code !== 0) throw refused(`git could not read ${PLUGIN_MANIFEST_FILE} at ${commit.slice(0, 7)}: ${firstLine(read.stderr) || `exit ${read.code}`}`, { url, commit });
    return { commit, text: read.stdout };
  } finally {
    options.signal?.removeEventListener('abort', stop);
    // A helper git left behind (git-remote-https) goes with the job before the directory does.
    core.procs.killTree(threadId);
    await removeWithRetry(dir);
  }
}

/** Windows holds a pack file a moment after git exits. */
async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
