import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseChord } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { readKeybindings } from '../src/keybindings.ts';
import { removeDir, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import type { CoreClient } from '../src/client.ts';

let harness: TestCore;
let client: CoreClient;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterEach(async () => {
  await harness.stop();
});

describe('the chord grammar', () => {
  test('reads modifiers in any order, named keys, and a bare function key', () => {
    expect(parseChord('mod+shift+K')).toEqual({ ok: true, chord: { mod: true, ctrl: false, alt: false, shift: true, meta: false, key: 'k' } });
    expect(parseChord('Shift + Ctrl + Enter')).toEqual({ ok: true, chord: { mod: false, ctrl: true, alt: false, shift: true, meta: false, key: 'enter' } });
    expect(parseChord('alt+up')).toEqual({ ok: true, chord: { mod: false, ctrl: false, alt: true, shift: false, meta: false, key: 'arrowup' } });
    expect(parseChord('mod+,')).toEqual({ ok: true, chord: { mod: true, ctrl: false, alt: false, shift: false, meta: false, key: ',' } });
    expect(parseChord('mod++')).toEqual({ ok: true, chord: { mod: true, ctrl: false, alt: false, shift: false, meta: false, key: '+' } });
    expect(parseChord('f5')).toEqual({ ok: true, chord: { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: 'f5' } });
  });

  test('refuses typing, a missing key, an unknown key and a doubled modifier, each by name', () => {
    expect(parseChord('b')).toEqual({ ok: false, reason: '"b" has no modifier: a chord needs mod, ctrl, alt or meta before its key' });
    expect(parseChord('shift+b')).toEqual({ ok: false, reason: '"shift+b" has no modifier: a chord needs mod, ctrl, alt or meta before its key' });
    expect(parseChord('mod+')).toEqual({ ok: false, reason: '"mod+" names no key' });
    expect(parseChord('mod+shift')).toEqual({ ok: false, reason: '"mod+shift" ends on a modifier and names no key' });
    expect(parseChord('mod+mod+k')).toEqual({ ok: false, reason: '"mod+mod+k" names mod twice' });
    expect(parseChord('k+mod')).toEqual({ ok: false, reason: '"k+mod" has "k" where a modifier was expected (mod, ctrl, alt, shift, meta)' });
    const unknown = parseChord('mod+banana');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toStartWith('"mod+banana" has an unknown key "banana"');
  });
});

describe('the keybindings file', () => {
  test('a missing file is no binding and no error, and the path names the data directory', async () => {
    const result = await client.call('keybindings.get', {});
    expect(result).toEqual({ path: join(harness.dataDir, 'keybindings.json'), bindings: {}, errors: [] });
  });

  test('each bad entry is refused by name while the good ones apply', () => {
    const result = readKeybindings('x', JSON.stringify({
      'new-thread': 'Mod+Shift+N',
      palette: null,
      nope: 'mod+x',
      sidebar: 'b',
      settings: 12,
    }));
    expect(result.bindings).toEqual({ 'new-thread': 'mod+shift+n', palette: null });
    expect(result.errors).toEqual([
      'keybindings.json: "nope" is not a command Boite has (the Keyboard settings list them)',
      'keybindings.json: "sidebar": "b" has no modifier: a chord needs mod, ctrl, alt or meta before its key',
      'keybindings.json: "settings" must be a chord string like mod+shift+k, or null to unbind it',
    ]);
    expect(readKeybindings('x', '[1]').errors).toEqual([
      'keybindings.json: expected an object of command ids to chords, like {"new-thread": "mod+shift+n"}',
    ]);
    const broken = readKeybindings('x', '{"new-thread": ');
    expect(broken.bindings).toEqual({});
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]).toStartWith('keybindings.json: not valid JSON (');
  });

  test('a file written, rewritten and deleted while the core runs is read each time and announced', async () => {
    const path = join(harness.dataDir, 'keybindings.json');
    const logs: string[] = [];
    client.on('core.log', (entry) => logs.push(`${entry.level} ${entry.message}`));

    const written = client.next('keybindings.updated', (payload) => payload.bindings['new-thread'] === 'mod+shift+n');
    writeFileSync(path, JSON.stringify({ 'new-thread': 'mod+shift+n', nope: 'mod+x' }));
    const first = await written;
    expect(first).toEqual({
      path,
      bindings: { 'new-thread': 'mod+shift+n' },
      errors: ['keybindings.json: "nope" is not a command Boite has (the Keyboard settings list them)'],
    });
    expect(await client.call('keybindings.get', {})).toEqual(first);
    expect(logs).toContain('warn keybindings.json: "nope" is not a command Boite has (the Keyboard settings list them)');

    const rewritten = client.next('keybindings.updated', (payload) => payload.bindings.palette === null);
    writeFileSync(path, JSON.stringify({ palette: null }));
    expect((await rewritten).bindings).toEqual({ palette: null });

    const removed = client.next('keybindings.updated', (payload) => Object.keys(payload.bindings).length === 0);
    rmSync(path);
    expect(await removed).toEqual({ path, bindings: {}, errors: [] });
  });

  test('the settings page writes one entry at a time and keeps what the user wrote by hand', async () => {
    const path = join(harness.dataDir, 'keybindings.json');
    writeFileSync(path, JSON.stringify({ palette: 'mod+p', nope: 'mod+x' }));
    await client.next('keybindings.updated', (payload) => payload.bindings.palette === 'mod+p');

    const set = await client.call('keybindings.set', { command: 'new-thread', chord: 'Mod+Shift+N' });
    expect(set.bindings).toEqual({ palette: 'mod+p', 'new-thread': 'mod+shift+n' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ palette: 'mod+p', nope: 'mod+x', 'new-thread': 'mod+shift+n' });

    const unbound = await client.call('keybindings.set', { command: 'sidebar', chord: null });
    expect(unbound.bindings.sidebar).toBeNull();

    const one = await client.call('keybindings.reset', { command: 'palette' });
    expect(one.bindings).toEqual({ 'new-thread': 'mod+shift+n', sidebar: null });
    expect(await client.call('keybindings.get', {})).toEqual(one);

    // Every command entry goes; an entry that is no command stays for its owner to read.
    const all = await client.call('keybindings.reset', {});
    expect(all.bindings).toEqual({});
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ nope: 'mod+x' });
    rmSync(path);
    await client.next('keybindings.updated', (payload) => payload.errors.length === 0);
    await client.call('keybindings.set', { command: 'pin', chord: 'mod+alt+p' });
    expect((await client.call('keybindings.reset', {})).bindings).toEqual({});
    expect(existsSync(path)).toBe(false);
  });

  test('a chord it cannot read and a file that is not JSON are refused, the file untouched', async () => {
    await expect(client.call('keybindings.set', { command: 'pin', chord: 'p' })).rejects.toThrow(
      'chord: "p" has no modifier: a chord needs mod, ctrl, alt or meta before its key',
    );
    await expect(client.call('keybindings.set', { command: 'nope' as 'pin', chord: 'mod+p' })).rejects.toThrow('command: "nope" is not a command Boite has');
    const path = join(harness.dataDir, 'keybindings.json');
    writeFileSync(path, '{"pin": ');
    await expect(client.call('keybindings.set', { command: 'pin', chord: 'mod+p' })).rejects.toThrow('keybindings.json: not valid JSON');
    expect(readFileSync(path, 'utf8')).toBe('{"pin": ');
  });

  test('a file present at start is read before any client connects', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-keys-'));
    writeFileSync(join(dataDir, 'keybindings.json'), JSON.stringify({ sidebar: 'mod+alt+s', pin: 'p' }));
    const core = new Core({ dataDir, token: newToken() });
    try {
      expect(core.keybindings.get()).toEqual({
        path: join(dataDir, 'keybindings.json'),
        bindings: { sidebar: 'mod+alt+s' },
        errors: ['keybindings.json: "pin": "p" has no modifier: a chord needs mod, ctrl, alt or meta before its key'],
      });
    } finally {
      await core.close();
      await removeDir(dataDir);
    }
  });
});
