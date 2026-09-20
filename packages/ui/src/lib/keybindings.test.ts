import { describe, expect, test } from 'vitest';
import { KEYBINDING_COMMANDS, parseChord } from '@boite/contracts';
import { COMMAND_GROUPS, chordFromEvent, chordLabel, chordParts, commandForKey, isMac, matchesChord, resolveBindings } from './keybindings';

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('the keyboard table', () => {
  test('the defaults stand until the file names a command, and null takes its key away', () => {
    const table = resolveBindings({ 'new-thread': 'mod+shift+n', palette: null });
    expect(table['new-thread']).toEqual({
      text: 'mod+shift+n',
      chord: { mod: true, ctrl: false, alt: false, shift: true, meta: false, key: 'n' },
      custom: true
    });
    expect(table.palette).toEqual({ text: null, chord: null, custom: true });
    expect(table.sidebar).toEqual({
      text: 'mod+b',
      chord: { mod: true, ctrl: false, alt: false, shift: false, meta: false, key: 'b' },
      custom: false
    });
    expect(table.archive).toEqual({ text: null, chord: null, custom: false });
  });

  test('a chord matches its exact modifiers, and mod is Ctrl here and Cmd on a Mac', () => {
    const modB = resolveBindings({}).sidebar.chord!;
    expect(matchesChord(key({ key: 'b', ctrlKey: true }), modB, false)).toBe(true);
    expect(matchesChord(key({ key: 'B', ctrlKey: true }), modB, false)).toBe(true);
    expect(matchesChord(key({ key: 'b', ctrlKey: true, altKey: true }), modB, false)).toBe(false);
    expect(matchesChord(key({ key: 'b', ctrlKey: true, shiftKey: true }), modB, false)).toBe(false);
    expect(matchesChord(key({ key: 'b', metaKey: true }), modB, false)).toBe(false);
    expect(matchesChord(key({ key: 'b', metaKey: true }), modB, true)).toBe(true);
    expect(matchesChord(key({ key: 'b', ctrlKey: true }), modB, true)).toBe(false);
  });

  test('a keydown finds its command, and one the file unbound finds nothing', () => {
    const table = resolveBindings({ palette: null, 'theme-dark': 'mod+shift+d' });
    expect(commandForKey(table, key({ key: 'n', ctrlKey: true }), false)).toBe('new-thread');
    expect(commandForKey(table, key({ key: 'k', ctrlKey: true }), false)).toBeNull();
    expect(commandForKey(table, key({ key: 'D', ctrlKey: true, shiftKey: true }), false)).toBe('theme-dark');
    expect(commandForKey(table, key({ key: ',', ctrlKey: true }), false)).toBe('settings');
    expect(commandForKey(table, key({ key: 'Enter', ctrlKey: true }), false)).toBe('send-and-draft');
    expect(commandForKey(table, key({ key: 'n' }), false)).toBeNull();
  });

  test('labels read the way the tooltips always did', () => {
    const table = resolveBindings({ trace: 'alt+up', pair: 'f5', rename: 'mod+shift+,' });
    expect(chordLabel(table['new-thread'].chord!, false)).toBe('Ctrl+N');
    expect(chordLabel(table['new-thread'].chord!, true)).toBe('Cmd+N');
    expect(chordLabel(table.panel.chord!, false)).toBe('Ctrl+Alt+B');
    expect(chordLabel(table.panel.chord!, true)).toBe('Option+Cmd+B');
    expect(chordLabel(table.settings.chord!, false)).toBe('Ctrl+,');
    expect(chordLabel(table['send-and-draft'].chord!, false)).toBe('Ctrl+Enter');
    expect(chordLabel(table.trace.chord!, false)).toBe('Alt+Up');
    expect(chordLabel(table.pair.chord!, false)).toBe('F5');
    expect(chordLabel(table.rename.chord!, false)).toBe('Ctrl+Shift+,');
  });

  test('the platform is read from the navigator string', () => {
    expect(isMac('MacIntel')).toBe(true);
    expect(isMac('Win32')).toBe(false);
    expect(isMac('Linux x86_64')).toBe(false);
  });
});

describe('recording a chord on the Keyboard page', () => {
  test('a keydown spells the words of the file, the platform modifier becoming mod', () => {
    expect(chordFromEvent(key({ key: 'K', ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+k');
    expect(chordFromEvent(key({ key: 'k', metaKey: true }), true)).toBe('mod+k');
    expect(chordFromEvent(key({ key: 'k', ctrlKey: true }), true)).toBe('ctrl+k');
    expect(chordFromEvent(key({ key: 'ArrowUp', altKey: true }), false)).toBe('alt+up');
    expect(chordFromEvent(key({ key: ' ', ctrlKey: true }), false)).toBe('mod+space');
    expect(chordFromEvent(key({ key: '+', ctrlKey: true }), false)).toBe('mod+plus');
    expect(chordFromEvent(key({ key: 'F5' }), false)).toBe('f5');
    // Only modifiers held: the recording waits for the key.
    expect(chordFromEvent(key({ key: 'Control', ctrlKey: true }), false)).toBeNull();
    expect(chordFromEvent(key({ key: 'Shift', shiftKey: true }), false)).toBeNull();
  });

  test('what it records reads back as the same chord, and a bare letter is refused', () => {
    for (const event of [key({ key: 'K', ctrlKey: true, shiftKey: true }), key({ key: 'ArrowLeft', ctrlKey: true, altKey: true }), key({ key: ',', ctrlKey: true })]) {
      const text = chordFromEvent(event, false)!;
      const parsed = parseChord(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(matchesChord(event, parsed.chord, false)).toBe(true);
    }
    expect(parseChord(chordFromEvent(key({ key: 'b' }), false)!).ok).toBe(false);
  });

  test('the page draws one cap per key, and every command sits in exactly one section', () => {
    expect(chordParts(resolveBindings({}).tasks.chord!, false)).toEqual(['Ctrl', 'Shift', 'K']);
    expect(chordParts(resolveBindings({}).tasks.chord!, true)).toEqual(['Shift', 'Cmd', 'K']);
    const listed = COMMAND_GROUPS.flatMap((group) => group.commands);
    expect([...listed].sort()).toEqual([...KEYBINDING_COMMANDS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
