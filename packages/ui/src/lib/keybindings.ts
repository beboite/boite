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
  'close-surface': 'mod+w',
  settings: 'mod+,',
  stash: 'mod+s',
  'send-and-draft': 'mod+enter',
  'add-project': null,
  pin: null,
  rename: null,
  trace: null,
  appearance: null,
  providers: null,
  pair: null,
  'theme-dark': null,
  'theme-light': null,
  'theme-system': null,
  archive: null
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
  return event.key.toLowerCase() === chord.key;
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

/** `Ctrl+Shift+K`, or `Cmd+Shift+K` on a Mac: what a tooltip and a palette row show. */
export function chordLabel(chord: Chord, mac: boolean = isMac()): string {
  const parts: string[] = [];
  if (chord.ctrl || (chord.mod && !mac)) parts.push('Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta || (chord.mod && mac)) parts.push(mac ? 'Cmd' : 'Win');
  parts.push(KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.toUpperCase()));
  return parts.join('+');
}
