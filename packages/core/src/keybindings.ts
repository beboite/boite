/*
 * The keybindings file: `<dataDir>/keybindings.json`, a JSON object of command
 * ids to chords (`"new-thread": "mod+shift+n"`) or to null to unbind. The core
 * reads it at start and again on every change, hands the result to `keybindings.get`
 * and `keybindings.updated`, and refuses each bad entry by name: an unknown
 * command, a chord it cannot parse, a value that is neither a string nor null.
 * A file that is not JSON gives one error and no binding at all. The defaults
 * are the UI's, so the file only carries what differs.
 */

import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { KEYBINDING_COMMANDS, parseChord } from '@boite/contracts';
import type { Keybindings, KeybindingCommand } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';

export const KEYBINDINGS_FILE = 'keybindings.json';
/** An editor writes a file in more than one event; the read waits for the burst to end. */
const SETTLE_MS = 120;

const KNOWN = new Set<string>(KEYBINDING_COMMANDS);

/** Reads one file's text into bindings and errors. Pure, so a test can call it on any string. */
export function readKeybindings(path: string, text: string | null): Keybindings {
  const bindings: Keybindings['bindings'] = {};
  const errors: string[] = [];
  if (text === null) return { path, bindings, errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${KEYBINDINGS_FILE}: not valid JSON (${detail})`);
    return { path, bindings, errors };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(`${KEYBINDINGS_FILE}: expected an object of command ids to chords, like {"new-thread": "mod+shift+n"}`);
    return { path, bindings, errors };
  }
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN.has(id)) {
      errors.push(`${KEYBINDINGS_FILE}: "${id}" is not a command Boite has (the Keyboard settings list them)`);
      continue;
    }
    const command = id as KeybindingCommand;
    if (value === null) {
      bindings[command] = null;
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${KEYBINDINGS_FILE}: "${id}" must be a chord string like mod+shift+k, or null to unbind it`);
      continue;
    }
    const chord = parseChord(value);
    if (!chord.ok) {
      errors.push(`${KEYBINDINGS_FILE}: "${id}": ${chord.reason}`);
      continue;
    }
    bindings[command] = value.trim().toLowerCase();
  }
  return { path, bindings, errors };
}

export class KeybindingStore {
  readonly path: string;
  private current: Keybindings;
  private watcher: FSWatcher | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly core: Core) {
    this.path = join(core.dataDir, KEYBINDINGS_FILE);
    this.current = this.read();
    this.warn(this.current);
    this.watch();
  }

  get(): Keybindings {
    return structuredClone(this.current);
  }

  /**
   * One entry written into the file, the others kept as the user wrote them,
   * unknown ones included: the settings page edits the same file a text editor
   * does. A chord is checked before anything is written.
   */
  set(command: KeybindingCommand, chord: string | null): Keybindings {
    if (!KNOWN.has(command)) throw invalidParams(`command: "${command}" is not a command Boite has`);
    if (chord !== null) {
      if (typeof chord !== 'string') throw invalidParams('chord: expected a chord string like mod+shift+k, or null');
      const parsed = parseChord(chord);
      if (!parsed.ok) throw invalidParams(`chord: ${parsed.reason}`);
    }
    const entries = this.entries();
    entries[command] = chord === null ? null : chord.trim().toLowerCase();
    return this.write(entries);
  }

  /** Entries out of the file: one command, or all of them, which removes the file. */
  reset(command?: KeybindingCommand): Keybindings {
    if (command !== undefined && !KNOWN.has(command)) throw invalidParams(`command: "${command}" is not a command Boite has`);
    const entries = this.entries();
    if (command === undefined) for (const id of KEYBINDING_COMMANDS) delete entries[id];
    else delete entries[command];
    return this.write(entries);
  }

  /** The file as an object, or a refusal: a file Boite cannot read is the user's to fix, never to overwrite. */
  private entries(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw refused(`${KEYBINDINGS_FILE}: not valid JSON (${detail}); fix it by hand at ${this.path} before changing a key here`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw refused(`${KEYBINDINGS_FILE}: expected an object of command ids to chords at ${this.path}; fix it by hand before changing a key here`);
    }
    return parsed as Record<string, unknown>;
  }

  /** Written beside and renamed over, so the watcher and an open editor never see half a file. */
  private write(entries: Record<string, unknown>): Keybindings {
    if (Object.keys(entries).length === 0) rmSync(this.path, { force: true });
    else {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(entries, null, 2)}
`, 'utf8');
      renameSync(temp, this.path);
    }
    // Read back now rather than on the watch, so the answer already holds the change.
    if (this.settle !== null) clearTimeout(this.settle);
    this.settle = null;
    this.reload();
    return this.get();
  }

  close(): void {
    if (this.settle !== null) clearTimeout(this.settle);
    this.settle = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private read(): Keybindings {
    if (!existsSync(this.path)) return readKeybindings(this.path, null);
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { path: this.path, bindings: {}, errors: [`${KEYBINDINGS_FILE}: could not be read (${detail})`] };
    }
    return readKeybindings(this.path, text);
  }

  private warn(result: Keybindings): void {
    for (const error of result.errors) this.core.log('warn', error);
  }

  /**
   * The directory is watched rather than the file: a file that does not exist
   * yet cannot be, and an editor that saves by rename replaces the inode the
   * file watcher held. Every other name in the directory is ignored.
   */
  private watch(): void {
    try {
      this.watcher = watch(this.core.dataDir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== KEYBINDINGS_FILE) return;
        this.schedule();
      });
      this.watcher.on('error', (error) => {
        this.core.log('warn', `${KEYBINDINGS_FILE}: the watch on ${this.core.dataDir} stopped (${error.message}); edits are read on the next start`);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.core.log('warn', `${KEYBINDINGS_FILE}: no watch on ${this.core.dataDir} (${detail}); edits are read on the next start`);
    }
  }

  private schedule(): void {
    if (this.settle !== null) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      this.reload();
    }, SETTLE_MS);
  }

  private reload(): void {
    const next = this.read();
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.warn(next);
    this.core.bus.emit('keybindings.updated', structuredClone(next));
  }
}

export function registerKeybindingMethods(core: Core): void {
  core.router.register('keybindings.get', () => core.keybindings.get());
  core.router.register('keybindings.set', ({ command, chord }) => core.keybindings.set(command, chord));
  core.router.register('keybindings.reset', ({ command }) => core.keybindings.reset(command));
}
