/**
 * What an agent does with a secret it holds by ref: the core writes it into
 * an ignored env file, or hands it to a command in an env var or on stdin,
 * and gives back only the masked output.
 */
import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SecretExecUse, SecretUseResult, SecretWriteUse, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { git } from '../git/read.ts';
import type { Connection } from '../router.ts';

export const SECRET_OUTPUT_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 10 * 60_000;
const RUN_MAX_TIMEOUT_MS = 60 * 60_000;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const encoder = new TextEncoder();

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/** The real path of `file` under the thread's folder, symlinks resolved, or a refusal naming the field. */
function containedPath(cwd: string, file: string): { root: string; path: string } {
  if (typeof file !== 'string' || file.trim().length === 0) throw refused('path: expected a file inside the conversation\'s folder', { field: 'path', expected: cwd });
  let root: string;
  try { root = realpathSync(cwd); } catch { throw refused(`path: the conversation's folder ${cwd} does not exist`, { field: 'path', expected: cwd }); }
  const wanted = resolve(cwd, file);
  let parent: string;
  try { parent = realpathSync(dirname(wanted)); } catch { throw refused(`path: the folder of ${file} does not exist`, { field: 'path', expected: `an existing folder inside ${root}` }); }
  let path = resolve(parent, wanted.slice(dirname(wanted).length + 1));
  if (existsSync(path)) {
    path = realpathSync(path);
    if (!statSync(path).isFile()) throw refused(`path: ${file} is not a file`, { field: 'path', expected: 'a file' });
  } else if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    // A dangling link: opening it would create its target, wherever that is.
    throw refused(`path: ${file} is a link to a missing file`, { field: 'path', expected: 'a file or no file' });
  }
  if (!inside(root, path)) throw refused(`path: ${file} is outside the conversation's folder`, { field: 'path', expected: `a file inside ${root}` });
  return { root, path };
}

/**
 * Escapes a value for a double-quoted env line when it holds anything a
 * parser would cut on; the bytes stay bytes, never a JS string.
 */
function envValue(value: Uint8Array): Uint8Array {
  const plain = value.every(byte => byte > 0x20 && byte !== 0x22 && byte !== 0x27 && byte !== 0x23 && byte !== 0x5c && byte !== 0x24 && byte !== 0x60 && byte !== 0x7f);
  if (plain) return value.slice();
  const out: number[] = [0x22];
  for (const byte of value) {
    if (byte === 0x0a) out.push(0x5c, 0x6e);
    else if (byte === 0x0d) out.push(0x5c, 0x72);
    else if (byte === 0x22 || byte === 0x5c || byte === 0x24 || byte === 0x60) out.push(0x5c, byte);
    else out.push(byte);
  }
  out.push(0x22);
  const bytes = Uint8Array.from(out);
  out.fill(0);
  return bytes;
}

/**
 * Writes `KEY=<value>` into an env file the repository ignores, replacing the
 * key's line or adding one, every other line as it was.
 */
export async function writeSecret(core: Core, threadId: ThreadId, cwd: string, use: SecretWriteUse, value: Uint8Array): Promise<SecretUseResult> {
  if (typeof use.key !== 'string' || !VARIABLE.test(use.key)) throw refused('key: expected an env variable name, letters, digits and _', { field: 'key', expected: VARIABLE.source });
  const { root, path } = containedPath(cwd, use.path);
  const rel = relative(root, path).split(sep).join('/');
  const tracked = await git(core, threadId, root, ['ls-files', '--error-unmatch', '--', rel], undefined, 'checking a secret file');
  if (tracked.code === 0) throw refused(`path: ${rel} is tracked by git, so the value would be committed`, { field: 'path', expected: 'a file git does not track' });
  if (use.allowUnignored !== true) {
    const ignored = await git(core, threadId, root, ['check-ignore', '-q', '--', rel], undefined, 'checking a secret file');
    if (ignored.code !== 0) throw refused(`path: git does not ignore ${rel}; add it to .gitignore or pass --allow-unignored`, { field: 'path', expected: 'a file git check-ignore ignores' });
  }
  // O_NOFOLLOW refuses a link swapped in since the checks above; Windows has no such flag.
  let fd: number;
  try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600); } catch (error) {
    throw refused(`path: could not open ${rel} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`, { field: 'path', expected: 'a regular file inside the folder, not a link' });
  }
  let quoted: Uint8Array | null = null;
  try {
    if (!fstatSync(fd).isFile()) throw refused(`path: ${rel} is not a file`, { field: 'path', expected: 'a file' });
    const before = readFileSync(fd, 'utf8');
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const lines = before.length === 0 ? [] : before.split(/\r?\n/);
    const trailing = lines.at(-1) === '';
    if (trailing) lines.pop();
    const line = new RegExp(`^\\s*(export\\s+)?${use.key}\\s*=`);
    const at = lines.findIndex(text => line.test(text));
    const head = (at < 0 ? lines : lines.slice(0, at)).map(text => text + eol).join('');
    const tail = at < 0 ? '' : lines.slice(at + 1).map(text => eol + text).join('') + (trailing ? eol : '');
    quoted = envValue(value);
    const prefix = encoder.encode(`${head}${at >= 0 && lines[at]!.trimStart().startsWith('export') ? 'export ' : ''}${use.key}=`);
    const suffix = encoder.encode(at < 0 ? eol : tail);
    // The mode applies only to a new file: an existing one readable by others is narrowed too.
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    let offset = 0;
    for (const bytes of [prefix, quoted, suffix]) offset += writeSync(fd, bytes, 0, bytes.length, offset);
    return { action: 'write', path, replaced: at >= 0 };
  } finally {
    closeSync(fd);
    quoted?.fill(0);
  }
}

/** Reads a stream whole up to the cap, dropping the rest so the child never blocks on a full pipe. */
async function capped(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size >= SECRET_OUTPUT_BYTES) { truncated = true; continue; }
    const room = SECRET_OUTPUT_BYTES - size;
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    truncated ||= chunk.length > room;
    size += Math.min(chunk.length, room);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, truncated };
}

/**
 * `run` puts the value in the child's env var `as`; `pipe` writes it on the
 * child's stdin. The child is the thread's, through `procs.spawnPiped`, and is
 * stopped at its deadline or when the caller's socket closes.
 */
export async function execSecret(core: Core, threadId: ThreadId, cwd: string, use: SecretExecUse, value: Uint8Array, mask: (text: string) => string, connection: Connection | undefined): Promise<SecretUseResult> {
  if (typeof use.command !== 'string' || use.command.trim().length === 0) throw refused('command: expected the program to run', { field: 'command', expected: 'a program name or path' });
  if (!Array.isArray(use.args) || use.args.some(arg => typeof arg !== 'string')) throw refused('args: expected a list of strings', { field: 'args', expected: 'string[]' });
  if (use.action === 'run' && (typeof use.as !== 'string' || !VARIABLE.test(use.as))) throw refused('as: expected an env variable name, letters, digits and _', { field: 'as', expected: VARIABLE.source });
  const timeoutMs = use.timeoutMs === undefined ? RUN_TIMEOUT_MS : use.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > RUN_MAX_TIMEOUT_MS) throw refused(`timeoutMs: expected 1000 to ${RUN_MAX_TIMEOUT_MS}`, { field: 'timeoutMs', expected: `1000..${RUN_MAX_TIMEOUT_MS}` });
  if (use.cwd !== undefined && typeof use.cwd !== 'string') throw refused('cwd: expected a folder path', { field: 'cwd', expected: `a folder inside ${cwd}` });
  const workdir = use.cwd === undefined || use.cwd === '' ? cwd : resolve(cwd, use.cwd);
  let root: string;
  try { root = realpathSync(cwd); } catch { throw refused(`cwd: the conversation's folder ${cwd} does not exist`, { field: 'cwd', expected: cwd }); }
  let real: string;
  try { real = realpathSync(workdir); } catch { throw refused(`cwd: ${use.cwd} does not exist`, { field: 'cwd', expected: `a folder inside ${root}` }); }
  if (real !== root && !inside(root, real)) throw refused(`cwd: ${use.cwd} is outside the conversation's folder`, { field: 'cwd', expected: `a folder inside ${root}` });
  const base = use.env !== undefined && typeof use.env === 'object' ? use.env : process.env;
  const env: Record<string, string | undefined> = { ...base };
  // The env var takes a JS string for the length of the spawn: Bun hands the child a copy and this one is dropped.
  if (use.action === 'run') env[use.as!] = new TextDecoder().decode(value);
  const spawned = core.procs.spawnPiped(threadId, use.command, use.args, { cwd: real, env, agentRoot: false });
  delete env[use.as ?? ''];
  let timedOut = false;
  const stop = (): void => { try { spawned.stop(); } catch { /* already gone */ } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const detach = connection?.onClose?.(stop);
  try {
    const stdin = spawned.proc.stdin;
    if (use.action === 'pipe') stdin.write(value);
    await stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([capped(spawned.proc.stdout), capped(spawned.proc.stderr), spawned.exited]);
    const decoder = new TextDecoder();
    const result = {
      action: use.action, exitCode, timedOut,
      stdout: mask(decoder.decode(stdout.bytes)), stderr: mask(decoder.decode(stderr.bytes)),
      truncated: stdout.truncated || stderr.truncated,
    };
    stdout.bytes.fill(0);
    stderr.bytes.fill(0);
    return result;
  } finally {
    clearTimeout(timer);
    detach?.();
  }
}
