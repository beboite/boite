import { accessSync, linkSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainLink } from '@boite/contracts';
import { messageOf } from './errors.ts';
import { homePath } from './paths.ts';

export interface OwnedBrainLink { path: string; source: string; backup: string | null }
interface LinkStorage { get(): OwnedBrainLink[]; set(links: OwnedBrainLink[]): void }
export interface BrainProfiles { home: string; env: Record<string, string | undefined> }
type Target = { name: string; path: string; override?: string };

function stat(path: string, follow = false) {
  try { return follow ? statSync(path) : lstatSync(path); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause; }
}

function pointsTo(path: string, source: string): boolean {
  return stat(path)?.isSymbolicLink() === true && resolve(dirname(path), readlinkSync(path)) === source;
}

function restoreBackup(backup: string, path: string): void {
  // Exclusive creation preserves a file that appeared after the destination check.
  if (lstatSync(backup).isSymbolicLink()) symlinkSync(readlinkSync(backup), path, 'file');
  else linkSync(backup, path);
  unlinkSync(backup);
}

/** Own only the links created here. Backups survive a user replacing a managed link. */
export class BrainLinks {
  private errors = new Map<string, string>();
  constructor(private readonly storage: LinkStorage, private readonly profiles: BrainProfiles = { home: homePath(), env: process.env }) {}

  private targets(): Target[] {
    const { home, env } = this.profiles;
    const base = (key: string, fallback: string) => env[key] || fallback;
    const codex = base('CODEX_HOME', join(home, '.codex'));
    const xdg = base('XDG_CONFIG_HOME', join(home, '.config'));
    const pi = base('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'));
    return [
      { name: 'Claude Code', path: join(base('CLAUDE_CONFIG_DIR', join(home, '.claude')), 'CLAUDE.md') },
      { name: 'Codex', path: join(codex, 'AGENTS.md'), override: join(codex, 'AGENTS.override.md') },
      { name: 'OpenCode', path: join(xdg, 'opencode', 'AGENTS.md') },
      { name: 'pi', path: join(pi, 'AGENTS.md'), override: join(pi, 'AGENTS.override.md') },
      { name: 'Grok', path: join(base('GROK_HOME', join(home, '.grok')), 'AGENTS.md') },
      { name: 'Gemini / Antigravity', path: join(base('GEMINI_HOME', join(home, '.gemini')), 'GEMINI.md') },
      { name: 'Muse', path: join(xdg, 'muse', 'AGENTS.md') },
    ];
  }

  private sourceError(root: string): string | null {
    const source = join(root, 'AGENTS.md');
    try {
      const rel = relative(realpathSync(root), realpathSync(source));
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return `${source}: link points outside the brain folder`;
      const info = statSync(source);
      accessSync(source, constants.R_OK);
      if (!info.isFile() || info.size === 0 || info.size > 64 * 1024) return `${source}: expected a nonempty file of at most 65536 bytes`;
      return null;
    } catch { return `${source}: expected a readable AGENTS.md for global instructions`; }
  }

  private targetError(target: Target): string | null {
    if (!isAbsolute(target.path)) return `${target.path}: the harness profile must use an absolute path`;
    if (target.override && stat(target.override)) return `${target.override}: existing override takes precedence; move it to use the brain globally`;
    return null;
  }

  status(root: string | null): BrainLink[] {
    const owned = this.storage.get();
    if (!root) return owned.map(link => ({ name: 'Global instructions', path: link.path, state: 'blocked', error: this.errors.get(link.path) ?? `Restore pending at ${link.path}${link.backup ? `; original backup at ${link.backup}` : ''}` }));
    const source = join(root, 'AGENTS.md'), sourceError = this.sourceError(root);
    const targets = this.targets();
    const result: BrainLink[] = targets.map(target => {
      try {
        const error = sourceError ?? this.targetError(target) ?? this.errors.get(target.path);
        if (error) return { ...target, state: 'blocked', error };
        if (pointsTo(target.path, source) || (target.path === source && stat(source)?.isFile())) {
          return { ...target, state: owned.some(link => link.path === target.path && link.source === source) ? 'linked' : 'existing', error: null };
        }
        return { ...target, state: 'blocked', error: `${target.path}: global instructions are not linked to this brain` };
      } catch (cause) { return { ...target, state: 'blocked', error: messageOf(cause) }; }
    });
    for (const link of owned) if (!targets.some(target => target.path === link.path)) {
      result.push({ name: 'Previous profile', path: link.path, state: 'blocked', error: this.errors.get(link.path) ?? `Restore pending at ${link.path}; original backup: ${link.backup ?? 'none'}` });
    }
    return result;
  }

  apply(root: string | null): BrainLink[] {
    let owned = [...this.storage.get()];
    const source = root ? join(root, 'AGENTS.md') : null;
    const targets = root ? this.targets() : [];
    const errors = this.errors = new Map<string, string>();
    const save = () => this.storage.set(owned);
    // Restore old destinations before adopting a new folder or profile location.
    for (const link of [...owned]) {
      if (source === link.source && targets.some(target => target.path === link.path)) continue;
      try {
        if (stat(link.path)) {
          if (!pointsTo(link.path, link.source)) throw new Error(`${link.path}: changed outside Boite; original backup kept at ${link.backup ?? 'none'}`);
          unlinkSync(link.path);
        }
        if (link.backup) restoreBackup(link.backup, link.path);
        owned = owned.filter(candidate => candidate.path !== link.path); save();
      } catch (cause) { errors.set(link.path, messageOf(cause)); }
    }
    const sourceError = root ? this.sourceError(root) : null;
    if (source && !sourceError) for (const target of targets) {
      let backup: string | null = null;
      try {
        const error = this.targetError(target);
        if (error) throw new Error(error);
        if (pointsTo(target.path, source) || target.path === source) continue;
        const info = stat(target.path);
        const managed = owned.find(link => link.path === target.path);
        if (managed) {
          if (info || managed.source !== source) throw new Error(`${target.path}: changed outside Boite; original backup kept at ${managed.backup ?? 'none'}`);
          mkdirSync(dirname(target.path), { recursive: true });
          symlinkSync(source, target.path, 'file');
          continue;
        }
        if (info && !info.isFile() && (!info.isSymbolicLink() || stat(target.path, true)?.isDirectory())) throw new Error(`${target.path}: expected a file or file symlink; directory preserved`);
        mkdirSync(dirname(target.path), { recursive: true });
        backup = info ? `${target.path}.boite-backup-${crypto.randomUUID()}` : null;
        // Persist ownership before moving anything, including incomplete installations.
        owned.push({ path: target.path, source, backup }); save();
        try {
          if (backup) renameSync(target.path, backup);
          symlinkSync(source, target.path, 'file');
        }
        catch (cause) {
          if (backup && stat(backup) && !stat(target.path)) restoreBackup(backup, target.path);
          if (!backup || !stat(backup)) { owned = owned.filter(link => link.path !== target.path); save(); }
          throw cause;
        }
      } catch (cause) {
        const hint = process.platform === 'win32' && (cause as NodeJS.ErrnoException).code === 'EPERM' ? ' Enable Windows Developer Mode to allow file symlinks.' : '';
        const pending = owned.find(link => link.path === target.path)?.backup;
        errors.set(target.path, `${messageOf(cause)}${hint}${pending ? ` Original backup: ${pending}` : ''}`);
      }
    }
    return this.status(root).map(link => errors.has(link.path) ? { ...link, state: 'blocked', error: errors.get(link.path)! } : link);
  }
}
