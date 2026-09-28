/*
 * The keyboard table: one chord per command, the defaults here and the user's
 * changes from `<dataDir>/keybindings.json` through `keybindings.get`. Every key
 * handler asks this table instead of reading `event.key` itself, so a chord the
 * file moves moves everywhere at once: the handler, the palette hint, the
 * tooltip. `mod` is Ctrl on Windows and Linux, Cmd on macOS.
 */

import { KEYBINDING_COMMANDS, parseChord, type Chord, type KeybindingCommand, type Keybindings } from '@boite/contracts';

/** What each command answers to until the file says otherwise. Null is a command with no key. */
export const DEFAULT_BINDINGS: Record<KeybindingCommand, string | null> = {
  'new-thread': 'mod+n',
  palette: 'mod+k',
  sidebar: 'mod+b',
  panel: 'mod+alt+b',
  browser: 'mod+shift+j',
  // The three workbench surfaces take the letter their launcher card shows.
  changes: 'mod+shift+c',
  files: 'mod+shift+f',
  tasks: 'mod+shift+k',
  'close-surface': 'mod+w',
  settings: 'mod+,',
  stash: 'mod+s',
  'send-and-draft': 'mod+enter',
  'add-project': null,
  pin: null,
  rename: null,
  retitle: null,
  trace: null,
  appearance: null,
  providers: null,
  pair: null,
  'theme-dark': null,
  'theme-light': null,
  'theme-system': null,
  archive: null,
  'import-session': null,
  terminal: 'mod+j',
  // The browser's key for the tab just closed: here the thread just archived.
  'reopen-thread': 'mod+shift+t',
  'copy-answer': 'mod+alt+c',
  find: 'mod+f',
  // The Nth thread of the sidebar, top to bottom as it is drawn.
  'thread-1': 'alt+1',
  'thread-2': 'alt+2',
  'thread-3': 'alt+3',
  'thread-4': 'alt+4',
  'thread-5': 'alt+5',
  'thread-6': 'alt+6',
  'thread-7': 'alt+7',
  'thread-8': 'alt+8',
  'thread-9': 'alt+9'
};

/** The resolved table: every command, its chord parsed or null, and whether the file set it. */
export type BindingTable = Record<KeybindingCommand, { text: string | null; chord: Chord | null; custom: boolean }>;

/** True on a Mac, where `mod` is Cmd and the labels say so. Read once; a test passes its own. */
export function isMac(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

/** The defaults with the file's entries over them. A chord the core already refused never reaches here. */
export function resolveBindings(overrides: Keybindings['bindings']): BindingTable {
  const table = {} as BindingTable;
  for (const id of KEYBINDING_COMMANDS) {
    const custom = Object.prototype.hasOwnProperty.call(overrides, id);
    const text = custom ? (overrides[id] ?? null) : DEFAULT_BINDINGS[id];
    const parsed = text === null ? null : parseChord(text);
    table[id] = { text, chord: parsed !== null && parsed.ok ? parsed.chord : null, custom };
  }
  return table;
}

/** True while this keydown is exactly this chord: the same modifiers, no more, and the key. */
export function matchesChord(event: KeyboardEvent, chord: Chord, mac: boolean = isMac()): boolean {
  const ctrl = chord.ctrl || (chord.mod && !mac);
  const meta = chord.meta || (chord.mod && mac);
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== chord.alt || event.shiftKey !== chord.shift) {
    return false;
  }
  if (event.key.toLowerCase() === chord.key) return true;
  // A digit is its key cap, not the character: on a French layout the key
  // marked 1 reports `&` unless Shift is down.
  return /^[0-9]$/.test(chord.key) && event.code === `Digit${chord.key}`;
}

/** The first command whose chord this keydown is, or null when the key belongs to no one. */
export function commandForKey(table: BindingTable, event: KeyboardEvent, mac: boolean = isMac()): KeybindingCommand | null {
  if (event.isComposing) return null;
  for (const id of KEYBINDING_COMMANDS) {
    const chord = table[id].chord;
    if (chord !== null && matchesChord(event, chord, mac)) return id;
  }
  return null;
}

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right'
};

/** `['Ctrl', 'Shift', 'K']`: one entry per key cap, what the Keyboard page draws. */
export function chordParts(chord: Chord, mac: boolean = isMac()): string[] {
  const parts: string[] = [];
  if (chord.ctrl || (chord.mod && !mac)) parts.push('Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta || (chord.mod && mac)) parts.push(mac ? 'Cmd' : 'Win');
  parts.push(KEY_LABELS[chord.key] ?? chord.key.toUpperCase());
  return parts;
}

/** `Ctrl+Shift+K`, or `Cmd+Shift+K` on a Mac: what a tooltip and a palette row show. */
export function chordLabel(chord: Chord, mac: boolean = isMac()): string {
  return chordParts(chord, mac).join('+');
}

/** The file's name for a key `KeyboardEvent.key` reports, where the two differ. */
const FILE_KEYS: Record<string, string> = {
  ' ': 'space',
  '+': 'plus',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right'
};

const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'numlock', 'fn']);

/**
 * The chord a keydown spells, in the file's words (`mod+shift+k`), or null
 * while only modifiers are held or the key has no name. The platform's own
 * modifier becomes `mod`, so a chord set on Windows means Cmd on a Mac.
 * Whether it is a legal chord is `parseChord`'s call, not this one's.
 */
export function chordFromEvent(event: KeyboardEvent, mac: boolean = isMac()): string | null {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key) || key === 'dead' || key === 'unidentified' || key === 'process' || key === '') return null;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (mac && event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (!mac && event.metaKey) parts.push('meta');
  parts.push(FILE_KEYS[key] ?? key);
  return parts.join('+');
}

/** The Keyboard page's sections. Every command sits in exactly one; a test holds that. */
export const COMMAND_GROUPS: { id: 'general' | 'surfaces' | 'thread' | 'jump' | 'theme'; commands: KeybindingCommand[] }[] = [
  { id: 'general', commands: ['new-thread', 'palette', 'sidebar', 'panel', 'settings', 'providers', 'appearance', 'add-project', 'pair', 'import-session'] },
  { id: 'surfaces', commands: ['terminal', 'browser', 'changes', 'files', 'tasks', 'trace', 'close-surface'] },
  { id: 'thread', commands: ['send-and-draft', 'stash', 'pin', 'rename', 'retitle', 'archive', 'reopen-thread', 'copy-answer', 'find'] },
  { id: 'jump', commands: ['thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6', 'thread-7', 'thread-8', 'thread-9'] },
  { id: 'theme', commands: ['theme-dark', 'theme-light', 'theme-system'] }
];
