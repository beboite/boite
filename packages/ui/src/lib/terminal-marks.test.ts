import { describe, expect, test } from 'vitest';
import { OscScanner, baseName, clearLineKeys, filterCommands, parseConEmuCwd, parseCwdProperty, parseFileUrl, parsePromptMark } from './terminal-marks';

describe('terminal marks', () => {
  test('OSC 133 reads as prompt, input, run and done with its status', () => {
    expect(parsePromptMark('A')).toEqual({ kind: 'prompt' });
    expect(parsePromptMark('B')).toEqual({ kind: 'input' });
    expect(parsePromptMark('C')).toEqual({ kind: 'run' });
    expect(parsePromptMark('D;127')).toEqual({ kind: 'done', exit: 127 });
    expect(parsePromptMark('D')).toEqual({ kind: 'done', exit: null });
    expect(parsePromptMark('P;k=i')).toBeNull();
  });

  test('a directory comes from OSC 633 Cwd or an OSC 7 file URL, Windows drives included', () => {
    expect(parseCwdProperty('P;Cwd=C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(parseCwdProperty('P;HistoryFile=/x')).toBeNull();
    expect(parseFileUrl('file://host/home/me/my%20dir')).toBe('/home/me/my dir');
    expect(parseFileUrl('file:///C:/Users/me')).toBe('C:/Users/me');
    expect(parseFileUrl('not a url')).toBeNull();
    expect(parseFileUrl('file://host/tmp/100%')).toBe('/tmp/100%');
    expect(parseConEmuCwd('9;"C:\\work"')).toBe('C:\\work');
    expect(parseConEmuCwd('4;1;50')).toBeNull();
    expect(baseName('/home/me/project/')).toBe('project');
    expect(baseName('C:\\Users\\me')).toBe('me');
    expect(baseName('C:\\')).toBe('C:\\');
    expect(baseName('/')).toBe('/');
  });

  test('a released screen reads its OSC sequences from raw chunks, split ones and ST-ended ones included', () => {
    const seen: [number, string][] = [];
    const scanner = new OscScanner((code, data) => seen.push([code, data]));
    // A sequence cut inside its body, one cut between ESC and `]`, one ended by ST cut between ESC and `\`.
    for (const chunk of ['out\x1b]133;C\x07build\x1b]13', '3;D;2\x07\x1b', ']633;P;Cwd=/srv\x1b', '\\\x1b[0m\x1b]7;file:///tmp\x07']) scanner.feed(chunk);
    expect(seen).toEqual([[133, 'C'], [133, 'D;2'], [633, 'P;Cwd=/srv'], [7, 'file:///tmp']]);
    // A CSI ends nothing it is not in; an escape inside a sequence drops it; a giant one is skipped whole.
    seen.length = 0;
    scanner.feed('\x1b]133;A\x1b[2J\x1b]8;;' + 'x'.repeat(5000) + '\x07\x1b]133;B\x07');
    expect(seen).toEqual([[133, 'B']]);
  });

  test('the keys that empty a line suit PSReadLine on Windows, readline elsewhere, and cmd', () => {
    expect(clearLineKeys({ name: 'pwsh', kind: 'powershell', integrated: true }, true)).toBe('\x1b[F\x1b[1;5H');
    expect(clearLineKeys({ name: 'pwsh', kind: 'powershell', integrated: true }, false)).toBe('\x05\x15');
    expect(clearLineKeys({ name: 'bash', kind: 'posix', integrated: true }, false)).toBe('\x05\x15');
    expect(clearLineKeys({ name: 'cmd', kind: 'cmd', integrated: false }, true)).toBe('\x1b');
  });

  test('a history search keeps every word in any order, those starting with the query first', () => {
    const commands = ['npm run build', 'git push origin main', 'git status', 'echo git'];
    expect(filterCommands(commands, 'git')).toEqual(['git push origin main', 'git status', 'echo git']);
    expect(filterCommands(commands, 'main PUSH')).toEqual(['git push origin main']);
    expect(filterCommands(commands, '  ')).toEqual(commands);
  });
});
