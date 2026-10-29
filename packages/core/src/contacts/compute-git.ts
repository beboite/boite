import type { Core } from '../core.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { refused } from '../errors.ts';
import { gitRemoteOf } from './git-remote.ts';
import { logGit } from '../git/git-log.ts';

/** Fixed argv only; caller data is restricted to full object ids or core-captured refs. */
export async function computeGit(core: Core, threadId: string, cwd: string, args: string[]): Promise<string> {
  return rawGit(core, threadId, cwd, [...await sharedGitConfig(core, threadId, cwd), ...args]);
}
/** Git's own ignore rules, without parsing quoted filenames or staging unrelated files. */
export async function computeChangedFiles(core: Core, threadId: string, cwd: string, paths: string[]): Promise<string[]> {
  const output = await rawGit(core, threadId, cwd, [...await sharedGitConfig(core, threadId, cwd), '--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], false);
  return [...new Set(output.split('\0').filter(Boolean))];
}
/** Git preparation/inspection is core work: host hooks, filters and fsmonitor must not execute outside the job boundary. */
export async function sharedGitConfig(core: Core, threadId: string, cwd: string): Promise<string[]> {
  const emptyHooks = join(core.dataDir, 'shared-compute-empty-hooks'); mkdirSync(emptyHooks, {recursive: true});
  const keys = await rawGit(core, threadId, cwd, ['config', '--null', '--name-only', '--list']);
  const filters = new Set(keys.split('\0').flatMap(key => {
    const found = /^(filter\..+)\.(?:process|smudge|clean|required)$/is.exec(key);
    return found ? [found[1]!] : [];
  }));
  return ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', ...[...filters].flatMap(key => ['-c', `${key}.process=`, '-c', `${key}.smudge=`, '-c', `${key}.clean=`, '-c', `${key}.required=false`])];
}
async function rawGit(core: Core, threadId: string, cwd: string, args: string[], trim = true): Promise<string> {
  core.sharedCompute?.assertGit(threadId);
  const scope = core.procs.protection.policy(threadId) ? core.procs.protection.control(threadId) : threadId;
  const spawned = core.procs.spawn(scope, 'git', ['--no-pager', '--no-optional-locks', ...args], { cwd });
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bound process output at the reader, rather than collecting arbitrary repo/config errors.
  const read = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return '';
    const reader = stream.getReader(), decoder = new TextDecoder(); let size = 0, value = '';
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 65536) { spawned.proc.kill(); throw refused('compute.git: output exceeded 65536 bytes'); } value += decoder.decode(next.value, {stream: true}); }
      return value + decoder.decode();
    } finally { reader.releaseLock(); }
  };
  try {
    timer = setTimeout(() => { spawned.proc.kill(); }, 15000);
    const [out, err, code] = await Promise.all([read(spawned.proc.stdout), read(spawned.proc.stderr), spawned.exited]);
    if (code !== 0) {
      try {logGit(core, threadId, args, code, performance.now() - started, err);} catch { /* Diagnostics must not replace the admission failure. */ }
      throw refused(`compute.git: ${args[0]} could not verify the captured repository or commit`);
    }
    return trim ? out.trim() : out;
  } finally { clearTimeout(timer); }
}
export function computeRepository(core: Core, projectId: string): string {
  const project = core.projects.require(projectId);
  const repository = gitRemoteOf(project.path);
  if (!repository) throw refused('compute.repository: expected a registered git project with a normalized network remote');
  return repository;
}
export async function computeBase(core: Core, threadId: string, projectId: string, base: string): Promise<void> {
  const cwd = core.projects.require(projectId).path;
  if (await computeGit(core, threadId, cwd, ['rev-parse', '--verify', `${base}^{commit}`]) !== base) throw refused('baseCommit: expected an existing exact commit of the registered project');
  await computeGit(core, threadId, cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
}
