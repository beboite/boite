// ---------------------------------------------------------------------------
// Keybindings: one file in the data directory, read by the core, applied by
// every client. The defaults are the UI's; the file only says what differs.
// ---------------------------------------------------------------------------

/** Every command a chord can be bound to. The UI owns the default chord of each. */
export const KEYBINDING_COMMANDS = [
  'new-thread',
  'palette',
  'sidebar',
  'panel',
  'browser',
  'changes',
  'files',
  'tasks',
  'close-surface',
  'settings',
  'stash',
  'send-and-draft',
  'add-project',
  'pin',
  'rename',
  'retitle',
  'trace',
  'appearance',
  'providers',
  'pair',
  'theme-dark',
  'theme-light',
  'theme-system',
  'archive',
  'import-session',
  'terminal',
  'terminal-new',
  'terminal-split',
  'terminal-split-vertical',
  'terminal-close',
  'terminal-find',
  'terminal-history',
  'terminal-previous-command',
  'terminal-next-command',
  'reopen-thread',
  'copy-answer',
  'find',
  'thread-1',
  'thread-2',
  'thread-3',
  'thread-4',
  'thread-5',
  'thread-6',
  'thread-7',
  'thread-8',
  'thread-9',
] as const;
export type KeybindingCommand = (typeof KEYBINDING_COMMANDS)[number];

/** What `<dataDir>/keybindings.json` says, as the core last read it. */
export interface Keybindings {
  /** The file itself, which may not exist yet. */
  path: string;
  /**
   * Command id to chord, `mod+shift+k` style, or null to leave the command
   * with no key. Only the entries the file names; the rest keep their default.
   */
  bindings: Partial<Record<KeybindingCommand, string | null>>;
  /**
   * Every line of the file the core could not take, each naming the file, the
   * entry and what was expected. A file that is not JSON is one error and no
   * binding at all.
   */
  errors: string[];
}

/** A chord parsed: which modifiers it holds and the key that ends it. */
export interface Chord {
  /** The platform's primary modifier: Ctrl on Windows and Linux, Cmd on macOS. */
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** The key as `KeyboardEvent.key` reports it, lowercased: `k`, `,`, `enter`, `arrowup`, `f5`. */
  key: string;
}

const CHORD_MODIFIERS: Record<string, keyof Omit<Chord, 'key'>> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
};

/** The named keys a chord may end with, and what `KeyboardEvent.key` says for each. */
const CHORD_KEYS: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  space: ' ',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  minus: '-',
  equal: '=',
  plus: '+',
  backquote: '`',
  bracketleft: '[',
  bracketright: ']',
  semicolon: ';',
  quote: "'",
};

/**
 * Reads a chord such as `mod+shift+k`, `ctrl+alt+b`, `mod+,` or `f5`. A chord
 * needs `mod`, `ctrl`, `alt` or `meta` unless its key is a function key: a
 * bare letter, or Shift alone, is typing. The refusal names what was wrong.
 */
export function parseChord(text: string): { ok: true; chord: Chord } | { ok: false; reason: string } {
  const parts = text.split('+').map((part) => part.trim().toLowerCase());
  // `mod++` is Mod and the plus key: the empty part between the two signs marks it.
  const plusAt = parts.indexOf('', 1);
  if (plusAt !== -1 && plusAt === parts.length - 2 && parts[parts.length - 1] === '') parts.splice(plusAt, 2, 'plus');
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const modifier = CHORD_MODIFIERS[part];
    if (modifier !== undefined && !last) {
      if (chord[modifier]) return { ok: false, reason: `"${text}" names ${part} twice` };
      chord[modifier] = true;
      continue;
    }
    if (!last) return { ok: false, reason: `"${text}" has "${part}" where a modifier was expected (mod, ctrl, alt, shift, meta)` };
    if (part === '') return { ok: false, reason: `"${text}" names no key` };
    if (modifier !== undefined) return { ok: false, reason: `"${text}" ends on a modifier and names no key` };
    const named = CHORD_KEYS[part];
    if (named !== undefined) chord.key = named;
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) chord.key = part;
    else if ([...part].length === 1) chord.key = part;
    else return { ok: false, reason: `"${text}" has an unknown key "${part}" (a character, enter, escape, tab, space, up, down, left, right, home, end, pageup, pagedown, backspace, delete or f1 to f24)` };
  }
  const isFunctionKey = /^f\d+$/.test(chord.key);
  if (!chord.mod && !chord.ctrl && !chord.alt && !chord.meta && !isFunctionKey) {
    return { ok: false, reason: `"${text}" has no modifier: a chord needs mod, ctrl, alt or meta before its key` };
  }
  return { ok: true, chord };
}

export interface KeybindingsRpcMethods {
  /** The keybindings file as last read: the path, the entries it names, and what it got wrong. */
  'keybindings.get': { params: Record<string, never>; result: Keybindings };
  /**
   * Writes one entry of the keybindings file: a chord, `mod+shift+k` style, or
   * null to leave the command with no key. The other entries stay as written.
   * A file that is not JSON is refused rather than overwritten.
   */
  'keybindings.set': { params: { command: KeybindingCommand; chord: string | null }; result: Keybindings };
  /** Takes entries out of the file so they fall back to the default: one command, or every one when omitted. */
  'keybindings.reset': { params: { command?: KeybindingCommand }; result: Keybindings };
}

export interface KeybindingsRpcEvents {
  /** The keybindings file changed on disk and was read again; the whole result, as `keybindings.get` would answer. */
  'keybindings.updated': Keybindings;
}
