import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainConfig, BrainEntry, BrainStatus } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';

const FILE_LIMIT = 64 * 1024;
const ENTRY_LIMIT = 500;
const WALK_LIMIT = 2000;
const INSTRUCTIONS_LIMIT = 128 * 1024;
const INSTRUCTION_FILES = ['AGENTS.md', '.agents/AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const CATALOG_DIRS = ['skills', '.agents/skills', '.claude/skills', '.codex/skills', 'plugins', '.claude/plugins', '.codex/plugins'];
const PLUGIN_FILES = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}

function read(root: string, path: string): string {
  const actual = realpathSync(path);
  if (!inside(root, actual)) throw new Error(`${path}: link points outside the brain folder`);
  const stat = statSync(actual);
  if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error(`${path}: expected a file of at most ${FILE_LIMIT} bytes`);
  return readFileSync(actual, 'utf8');
}

/** Only instruction entrypoints and catalog folders are inspected. Never execute a brain script. */
export function scanBrain(root: string): { entries: BrainEntry[]; problems: string[] } {
  root = realpathSync(root);
  if (!statSync(root).isDirectory()) throw refused(`${root}: expected an existing brain folder`);
  const entries: BrainEntry[] = [], problems: string[] = [];
  const visited = new Set<string>();
  let walked = 0;
  function add(kind: BrainEntry['kind'], file: string) {
    if (entries.length >= ENTRY_LIMIT) throw new Error(`Brain inventory exceeds ${ENTRY_LIMIT} entries`);
    const entry: BrainEntry = { kind, path: relative(root, file).split(sep).join('/'), name: basename(kind === 'skill' ? resolve(file, '..') : file), description: '', error: null };
    try {
      const text = read(root, file);
      if (kind !== 'instructions') {
        const front = kind === 'skill' ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] : undefined;
        if (kind === 'skill' && front === undefined) throw new Error(`${entry.path}: expected YAML frontmatter with name and description`);
        const metadata: unknown = kind === 'plugin' ? JSON.parse(text) : Bun.YAML.parse(front!);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`${entry.path}: expected an object`);
        const data = metadata as Record<string, unknown>;
        if (typeof data.name !== 'string' || !data.name.trim()) throw new Error(`${entry.path}: name must be a nonempty string`);
        if (kind === 'skill' && (typeof data.description !== 'string' || !data.description.trim())) throw new Error(`${entry.path}: description must be a nonempty string`);
        entry.name = data.name.slice(0, 200);
        entry.description = typeof data.description === 'string' ? data.description.slice(0, 2000) : '';
      }
    } catch (cause) { entry.error = messageOf(cause); }
    entries.push(entry);
  }
  function walk(dir: string, depth: number) {
    if (++walked > WALK_LIMIT) throw new Error(`Brain inventory exceeds ${WALK_LIMIT} directories`);
    const actual = realpathSync(dir);
    if (!inside(root, actual)) { problems.push(`${dir}: link points outside the brain folder`); return; }
    if (visited.has(actual)) return;
    visited.add(actual);
    const skill = join(dir, 'SKILL.md');
    if (exists(skill)) add('skill', skill);
    for (const file of PLUGIN_FILES) if (exists(join(dir, file))) add('plugin', join(dir, file));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.secrets', '.claude-plugin', '.codex-plugin'].includes(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      if (depth >= 6) { problems.push(`${child}: inventory depth limit reached`); continue; }
      try { if (statSync(child).isDirectory()) walk(child, depth + 1); }
      catch (cause) { problems.push(`${child}: ${messageOf(cause)}`); }
      if (walked > WALK_LIMIT || entries.length >= ENTRY_LIMIT) return;
    }
  }
  for (const file of INSTRUCTION_FILES) if (exists(join(root, file))) add('instructions', join(root, file));
  for (const dir of CATALOG_DIRS) {
    try { if (exists(join(root, dir))) walk(join(root, dir), 0); }
    catch (cause) { problems.push(messageOf(cause)); }
    if (walked > WALK_LIMIT || entries.length >= ENTRY_LIMIT) break;
  }
  if (entries.length >= ENTRY_LIMIT) problems.push(`Brain inventory reached ${ENTRY_LIMIT} entries; some entries may be missing`);
  return { entries, problems };
}

export class BrainStore {
  private busy = false;
  private closed = false;
  private readonly processes = new Map<string, Promise<void>>();
  constructor(private readonly core: Core) {}

  config(): BrainConfig {
    return (this.core.journal.getSetting('brain') as BrainConfig | undefined) ?? { path: null, enabled: false };
  }

  async configure(config: BrainConfig): Promise<BrainStatus> {
    if (this.busy) throw refused('Brain synchronization is running; wait before changing its folder');
    if (typeof config.enabled !== 'boolean') throw invalidParams('brain.enabled must be a boolean');
    if (config.path !== null && (typeof config.path !== 'string' || !isAbsolute(config.path))) throw invalidParams('brain.path must be an absolute folder path or null');
    if (config.enabled && config.path === null) throw invalidParams('brain.path is required when enabled');
    let path: string | null = null;
    if (config.path !== null) {
      try {
        path = realpathSync(config.path);
        if (!statSync(path).isDirectory()) throw new Error('not a folder');
      } catch { throw invalidParams(`brain.path ${config.path}: expected an existing, readable folder`); }
    }
    if (path !== this.config().path) this.core.journal.setSetting('brain.lastSync', null);
    this.core.journal.setSetting('brain', { path, enabled: config.enabled });
    return this.status();
  }

  async status(): Promise<BrainStatus> {
    const config = this.config();
    const status: BrainStatus = { config, entries: [], problems: [], git: null, lastSync: (this.core.journal.getSetting('brain.lastSync') as number | null) ?? null };
    if (!config.path) return status;
    try {
      Object.assign(status, scanBrain(config.path));
      // A folder within another repository is not itself a synchronizable brain.
      if (exists(join(config.path, '.git'))) status.git = await this.gitStatus(config.path);
    } catch (cause) { status.problems.push(messageOf(cause)); }
    return status;
  }

  /** Included in normal turns across all drivers, including already warm sessions. */
  instructions(providerId?: string): string {
    const { path, enabled } = this.config();
    if (!enabled || !path) return '';
    const { entries } = scanBrain(path);
    const blocks = [`Shared agent brain: ${path}. Instructions below apply to this turn. Project instructions still apply.`];
    for (const entry of entries.filter(entry => entry.kind === 'instructions' && (entry.path.endsWith('AGENTS.md') || (entry.path === 'CLAUDE.md' && providerId === 'claude') || (entry.path === 'GEMINI.md' && providerId === 'antigravity')))) {
      if (entry.error) throw refused(entry.error);
      blocks.push(`Instructions from ${entry.path}:\n${read(path, join(path, entry.path))}`);
    }
    const skills = entries.filter(entry => entry.kind === 'skill' && !entry.error);
    if (skills.length) blocks.push('Available skills. Read the named SKILL.md before using a skill.\n' + skills.map(entry => `${entry.name}: ${entry.description}\nFile: ${join(path, entry.path)}`).join('\n'));
    const text = blocks.join('\n\n');
    if (Buffer.byteLength(text) > INSTRUCTIONS_LIMIT) throw refused(`Brain instructions and skill catalog exceed ${INSTRUCTIONS_LIMIT} bytes; reduce the entry files or catalog`);
    return `${text}\n\nUser request:\n`;
  }

  async sync(): Promise<BrainStatus> {
    if (this.busy) throw refused('Brain synchronization is already running');
    this.busy = true;
    try {
      const path = this.config().path;
      if (!path || !exists(join(path, '.git'))) throw refused('brain.path must point to the root of a Git checkout to synchronize');
      let state = await this.gitStatus(path);
      if (state.dirty) throw refused('Brain has local file changes. Commit or resolve them before synchronizing; Boite leaves them untouched.');
      if (!state.branch || !state.upstream) throw refused('Brain needs a local branch with a configured Git upstream');
      const remote = (await this.git(path, ['config', '--get', `branch.${state.branch}.remote`])).trim();
      const merge = (await this.git(path, ['config', '--get', `branch.${state.branch}.merge`])).trim();
      if (!remote || remote.startsWith('-') || !merge.startsWith('refs/heads/')) throw refused('Brain upstream must name a remote branch');
      await this.git(path, ['fetch', '--no-tags', '--', remote]);
      state = await this.gitStatus(path);
      if (state.dirty || (state.ahead > 0 && state.behind > 0)) throw refused('Brain has local changes or diverging commits. Resolve them before synchronizing; Boite does not merge conflicts.');
      if (state.behind > 0) await this.git(path, ['merge', '--ff-only', '@{upstream}']);
      if (state.ahead > 0) await this.git(path, ['push', '--', remote, `HEAD:${merge}`]);
      this.core.journal.setSetting('brain.lastSync', Date.now());
      return await this.status();
    } finally { this.busy = false; }
  }

  private async gitStatus(path: string): Promise<NonNullable<BrainStatus['git']>> {
    const lines = (await this.git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'])).split('\n');
    const value = (key: string) => lines.find(line => line.startsWith(`# branch.${key} `))?.slice(key.length + 10).trim() ?? null;
    const head = value('head'), upstream = value('upstream'), counts = value('ab')?.match(/^\+(\d+) -(\d+)$/);
    return { branch: head === '(detached)' ? null : head, upstream, ahead: Number(counts?.[1] ?? 0), behind: Number(counts?.[2] ?? 0), dirty: lines.some(line => line.length > 0 && !line.startsWith('#')) };
  }

  private async git(path: string, args: string[]): Promise<string> {
    if (this.closed) throw refused('Brain is shutting down');
    const id = `brain:${crypto.randomUUID()}`;
    const child = this.core.procs.spawn(id, 'git', ['-c', 'core.hooksPath=', '-c', 'credential.interactive=false', ...args], { cwd: path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    let settled!: () => void;
    this.processes.set(id, new Promise<void>(resolve => { settled = resolve; }));
    const timer = setTimeout(() => this.core.procs.killTree(id), 30_000);
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 1024 * 1024) { this.core.procs.killTree(id); throw refused('Brain Git output exceeds 1 MiB'); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    try {
      const [out, , code] = await Promise.all([drain(child.proc.stdout), drain(child.proc.stderr), child.exited]);
      if (this.closed) throw refused('Brain is shutting down');
      // Git stderr can contain credential-bearing remote URLs. Keep it out of RPC and logs.
      if (code !== 0) throw refused(`Brain git ${args[0]} failed with exit ${code}. Check the repository's upstream and Git authentication on this machine.`);
      return out;
    } finally { clearTimeout(timer); this.core.procs.killTree(id); this.processes.delete(id); settled(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.processes.keys()) this.core.procs.killTree(id);
    await Promise.all(this.processes.values());
  }
}
